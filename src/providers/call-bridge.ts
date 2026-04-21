import type { VoiceAudioInput } from "@cloudflare/voice/client";
import { TelnyxRTC } from "@telnyx/webrtc";
import { float32ToInt16, computeRMS, PCM_CAPTURE_PROCESSOR_SOURCE, PCM_PLAYBACK_PROCESSOR_SOURCE } from "../audio/utils.js";

/**
 * Configuration for the TelnyxCallBridge.
 *
 * Uses JWT authentication (browser-side). The JWT is generated
 * server-side from a Telnyx API key + credential connection.
 */
export interface TelnyxCallBridgeConfig {
  /** JWT token from the Telnyx telephony credentials API. */
  loginToken: string;
  /** Automatically answer inbound calls. @default false */
  autoAnswer?: boolean;
  /** Enable debug logging. @default false */
  debug?: boolean;
}

/**
 * Bridges Telnyx phone calls into the Cloudflare voice pipeline.
 *
 * Implements `VoiceAudioInput` from @cloudflare/voice — extracts PCM
 * audio from inbound phone calls and feeds it to the AI pipeline.
 * Also provides `playAudio()` for injecting response audio back
 * into the phone call.
 *
 * Usage:
 * ```typescript
 * const bridge = new TelnyxCallBridge({ loginToken: jwt });
 * const voiceClient = new VoiceClient({
 *   agent: "my-agent",
 *   audioInput: bridge,
 * });
 * ```
 */
export class TelnyxCallBridge implements VoiceAudioInput {
  // VoiceAudioInput callbacks — set by VoiceClient before start()
  onAudioLevel: ((rms: number) => void) | null = null;
  onAudioData?: ((pcm: ArrayBuffer) => void) | null = null;

  private readonly config: TelnyxCallBridgeConfig;
  private _connected = false;
  private _activeCall: unknown | null = null;
  private client: TelnyxRTC | null = null;
  private captureContext: AudioContext | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureWorklet: AudioWorkletNode | null = null;
  private captureBlobUrl: string | null = null;
  private playbackContext: AudioContext | null = null;
  private playbackWorklet: AudioWorkletNode | null = null;
  private playbackBlobUrl: string | null = null;

  constructor(config: TelnyxCallBridgeConfig) {
    this.config = config;
  }

  /** Whether the Telnyx client is connected to the platform. */
  get connected(): boolean {
    return this._connected;
  }

  /** The currently active Telnyx call, or null. */
  get activeCall(): unknown | null {
    return this._activeCall;
  }

  /** Connect to Telnyx and start listening for calls. */
  async start(): Promise<void> {
    this.client = new TelnyxRTC({
      login_token: this.config.loginToken,
      debug: this.config.debug,
    });

    return new Promise<void>((resolve, reject) => {
      this.client!.on("telnyx.ready", () => {
        this._connected = true;
        resolve();
      });

      this.client!.on("telnyx.error", (error: unknown) => {
        reject(error);
      });

      this.client!.on("telnyx.notification", (notification: any) => {
        this.handleNotification(notification);
      });

      this.client!.connect();
    });
  }

  /** Answer the current inbound call. */
  answer(): void {
    if (!this._activeCall) throw new Error("No active call");
    (this._activeCall as any).answer();
  }

  /** End the active call. */
  hangup(): void {
    if (!this._activeCall) return;
    (this._activeCall as any).hangup();
  }

  /**
   * Initiate an outbound PSTN call.
   * @param destination Phone number or SIP URI to call.
   * @param callerNumber The caller ID number to present.
   * @returns The Telnyx Call object.
   */
  dial(destination: string, callerNumber?: string): unknown {
    if (!this.client) throw new Error("Not connected — call start() first");
    const call = (this.client as any).newCall({
      destinationNumber: destination,
      callerNumber,
    });
    this._activeCall = call;
    return call;
  }

  /** Send DTMF digits on the active call. */
  sendDTMF(digits: string): void {
    if (!this._activeCall) throw new Error("No active call");
    (this._activeCall as any).dtmf(digits);
  }

  /**
   * Clear any buffered audio in the playback pipeline.
   * Used during interrupt detection to stop stale audio from playing.
   */
  clearPlaybackBuffer(): void {
    this.playbackWorklet?.port.postMessage("clear");
  }

  /**
   * Inject PCM audio into the active phone call (agent → caller).
   * Accepts 16kHz mono Int16 PCM. Upsamples to 48kHz for WebRTC.
   * No-op if no active call.
   */
  playAudio(pcm: ArrayBuffer): void {
    if (!this.playbackWorklet) return;
    const int16 = new Int16Array(pcm);

    // Upsample 16kHz → 48kHz (3x) via linear interpolation
    const upsampleRatio = 3;
    const float32 = new Float32Array(int16.length * upsampleRatio);
    for (let i = 0; i < int16.length; i++) {
      const current = int16[i] / 32768;
      const next = i < int16.length - 1 ? int16[i + 1] / 32768 : current;
      const base = i * upsampleRatio;
      for (let j = 0; j < upsampleRatio; j++) {
        float32[base + j] = current + (next - current) * (j / upsampleRatio);
      }
    }

    this.playbackWorklet.port.postMessage(float32);
  }

  /** Disconnect from Telnyx and clean up all resources. */
  stop(): void {
    this.stopAudioCapture();
    this.stopAudioPlayback();
    this._activeCall = null;
    this._connected = false;
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

  private handleNotification(notification: any): void {
    if (notification.type !== "callUpdate" || !notification.call) return;

    const call = notification.call;

    switch (call.state) {
      case "ringing":
        this._activeCall = call;
        if (this.config.autoAnswer) {
          call.answer();
        }
        break;

      case "active":
        this._activeCall = call;
        this.startAudioCapture(call);
        this.startAudioPlayback(call);
        break;

      case "hangup":
      case "destroy":
      case "purge":
        this.stopAudioCapture();
        this.stopAudioPlayback();
        this._activeCall = null;
        break;
    }
  }

  private async startAudioCapture(call: any): Promise<void> {
    const remoteStream = call.remoteStream;
    if (!remoteStream) return;

    this.captureContext = new AudioContext({ sampleRate: 16000 });

    const blob = new Blob([PCM_CAPTURE_PROCESSOR_SOURCE], {
      type: "application/javascript",
    });
    this.captureBlobUrl = URL.createObjectURL(blob);
    await this.captureContext.audioWorklet.addModule(this.captureBlobUrl);

    this.captureSource = this.captureContext.createMediaStreamSource(remoteStream);
    this.captureWorklet = new AudioWorkletNode(
      this.captureContext,
      "pcm-capture-processor"
    );

    this.captureWorklet.port.onmessage = (event: MessageEvent) => {
      const float32: Float32Array = event.data;
      const rms = computeRMS(float32);
      this.onAudioLevel?.(rms);
      const int16 = float32ToInt16(float32);
      this.onAudioData?.(int16.buffer as ArrayBuffer);
    };

    this.captureSource.connect(this.captureWorklet);
  }

  private stopAudioCapture(): void {
    if (this.captureWorklet) {
      this.captureWorklet.disconnect();
      this.captureWorklet = null;
    }
    if (this.captureSource) {
      this.captureSource.disconnect();
      this.captureSource = null;
    }
    if (this.captureContext) {
      this.captureContext.close();
      this.captureContext = null;
    }
    if (this.captureBlobUrl) {
      URL.revokeObjectURL(this.captureBlobUrl);
      this.captureBlobUrl = null;
    }
  }

  private async startAudioPlayback(call: any): Promise<void> {
    const peerConnection = call.peer?.instance as RTCPeerConnection | undefined;
    if (!peerConnection) return;

    this.playbackContext = new AudioContext({ sampleRate: 48000 });

    const blob = new Blob([PCM_PLAYBACK_PROCESSOR_SOURCE], {
      type: "application/javascript",
    });
    this.playbackBlobUrl = URL.createObjectURL(blob);
    await this.playbackContext.audioWorklet.addModule(this.playbackBlobUrl);

    this.playbackWorklet = new AudioWorkletNode(
      this.playbackContext,
      "pcm-playback-processor"
    );

    const destination = this.playbackContext.createMediaStreamDestination();
    this.playbackWorklet.connect(destination);

    const audioTrack = destination.stream.getAudioTracks()[0];
    if (audioTrack) {
      const sender = peerConnection
        .getSenders()
        .find((s: RTCRtpSender) => s.track?.kind === "audio");
      if (sender) {
        await sender.replaceTrack(audioTrack);
      }
    }
  }

  private stopAudioPlayback(): void {
    if (this.playbackWorklet) {
      this.playbackWorklet.disconnect();
      this.playbackWorklet = null;
    }
    if (this.playbackContext) {
      this.playbackContext.close();
      this.playbackContext = null;
    }
    if (this.playbackBlobUrl) {
      URL.revokeObjectURL(this.playbackBlobUrl);
      this.playbackBlobUrl = null;
    }
  }
}
