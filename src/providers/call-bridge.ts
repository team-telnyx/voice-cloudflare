import type { VoiceAudioInput } from "@cloudflare/voice/client";

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
    // Implemented in Task 3
    throw new Error("Not implemented");
  }

  /** Disconnect from Telnyx and clean up all resources. */
  stop(): void {
    // Implemented in Task 3
  }
}
