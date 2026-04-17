import type { VoiceAudioInput } from "@cloudflare/voice/client";
import { TelnyxRTC } from "@telnyx/webrtc";
import { float32ToInt16, computeRMS, PCM_CAPTURE_PROCESSOR_SOURCE } from "../audio/utils.js";

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

  /** Disconnect from Telnyx and clean up all resources. */
  stop(): void {
    this.stopAudioCapture();
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
        break;

      case "hangup":
      case "destroy":
      case "purge":
        this.stopAudioCapture();
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
      this.onAudioData?.(int16.buffer);
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
}
