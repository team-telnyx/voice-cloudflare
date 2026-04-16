/**
 * Telnyx TTS provider for the Cloudflare Agents SDK.
 *
 * Implements the TTSProvider interface from @cloudflare/voice,
 * providing streaming text-to-speech synthesis via Telnyx.
 */

import { TelnyxClient, type TelnyxClientConfig } from "./client.js";

export interface TelnyxTTSConfig extends TelnyxClientConfig {
  /** Voice ID for synthesis */
  voice?: string;
  /** Output audio format (default: "pcm") */
  format?: string;
  /** Sample rate (default: 24000) */
  sampleRate?: number;
}

export class TelnyxTTS {
  private client: TelnyxClient;
  private voice: string;
  private format: string;
  private sampleRate: number;

  constructor(config: TelnyxTTSConfig) {
    this.client = new TelnyxClient(config);
    this.voice = config.voice ?? "default";
    this.format = config.format ?? "pcm";
    this.sampleRate = config.sampleRate ?? 24000;
  }

  // TODO: Implement TTSProvider interface from @cloudflare/voice
  // - Accept text or stream of text
  // - Sentence-chunk for streaming (low time-to-first-audio)
  // - Synthesize each sentence
  // - Return audio chunks in expected format
}
