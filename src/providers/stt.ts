/**
 * Telnyx STT provider for the Cloudflare Agents SDK.
 *
 * Implements the STTProvider interface from @cloudflare/voice,
 * providing real-time transcription via Telnyx.
 */

import { TelnyxClient, type TelnyxClientConfig } from "../client.js";

export interface TelnyxSTTConfig extends TelnyxClientConfig {
  /** Language code for transcription (default: "en") */
  language?: string;
  /** Enable interim results (default: true) */
  interimResults?: boolean;
}

export class TelnyxSTT {
  private client: TelnyxClient;
  private language: string;
  private interimResults: boolean;

  constructor(config: TelnyxSTTConfig) {
    this.client = new TelnyxClient(config);
    this.language = config.language ?? "en";
    this.interimResults = config.interimResults ?? true;
  }

  // TODO: Implement STTProvider interface from @cloudflare/voice
  // - Start transcription session
  // - Stream audio chunks (16 kHz mono PCM)
  // - Emit interim and final transcripts
  // - Detect turns (end of utterance)
}
