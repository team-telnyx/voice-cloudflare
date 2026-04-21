/**
 * Telnyx STT provider for the Cloudflare Agents SDK.
 *
 * Implements the Transcriber interface from @cloudflare/voice,
 * streaming audio to the Telnyx WebSocket STT API.
 */

import type { Transcriber, TranscriberSession } from "@cloudflare/voice";
import { TelnyxClient, type TelnyxClientConfig } from "../client.js";

const DEFAULT_STT_URL = "wss://api.telnyx.com/v2/speech-to-text/transcription";

export interface TelnyxSTTConfig extends TelnyxClientConfig {
  /** STT engine (default: "Telnyx") */
  engine?: string;
  /** Language code for transcription (default: "en") */
  language?: string;
  /** Audio input format (default: "pcm") */
  inputFormat?: string;
  /** Deepgram model when engine is "Deepgram" (e.g., "nova-3", "flux") */
  transcriptionModel?: string;
  /** Enable interim results (default: true) */
  interimResults?: boolean;
  /**
   * Override the WebSocket URL for the STT streaming endpoint.
   * @default "wss://api.telnyx.com/v2/speech-to-text/transcription"
   */
  sttWsUrl?: string;
}

export interface TelnyxSTTSessionOptions {
  language?: string;
  onInterim?: (text: string) => void;
  onUtterance?: (transcript: string) => void;
}

export class TelnyxSTT implements Transcriber {
  private client: TelnyxClient;
  private engine: string;
  private language: string;
  private inputFormat: string;
  private transcriptionModel?: string;
  private interimResults: boolean;
  private sttUrl: string;

  constructor(config: TelnyxSTTConfig) {
    this.client = new TelnyxClient(config);
    this.engine = config.engine ?? "Telnyx";
    this.language = config.language ?? "en";
    this.inputFormat = config.inputFormat ?? "pcm";
    this.transcriptionModel = config.transcriptionModel;
    this.interimResults = config.interimResults ?? true;
    this.sttUrl = config.sttWsUrl ?? DEFAULT_STT_URL;
  }

  createSession(options?: TelnyxSTTSessionOptions): TelnyxSTTSession {
    const language = options?.language ?? this.language;
    return new TelnyxSTTSession({
      apiKey: this.client.apiKey,
      sttUrl: this.sttUrl,
      engine: this.engine,
      inputFormat: this.inputFormat,
      transcriptionModel: this.transcriptionModel,
      interimResults: this.interimResults,
      language,
      onInterim: options?.onInterim,
      onUtterance: options?.onUtterance,
    });
  }
}

interface SessionParams {
  apiKey: string;
  sttUrl: string;
  engine: string;
  inputFormat: string;
  transcriptionModel?: string;
  interimResults: boolean;
  language: string;
  onInterim?: (text: string) => void;
  onUtterance?: (transcript: string) => void;
}

export class TelnyxSTTSession implements TranscriberSession {
  private ws: WebSocket;
  private pendingChunks: ArrayBuffer[] = [];
  private closed = false;
  private onInterim?: (text: string) => void;
  private onUtterance?: (transcript: string) => void;

  constructor(params: SessionParams) {
    this.onInterim = params.onInterim;
    this.onUtterance = params.onUtterance;

    const url = new URL(params.sttUrl);
    url.searchParams.set("transcription_engine", params.engine);
    url.searchParams.set("input_format", params.inputFormat);
    url.searchParams.set("language", params.language);
    url.searchParams.set("interim_results", String(params.interimResults));
    if (params.transcriptionModel) {
      url.searchParams.set("transcription_model", params.transcriptionModel);
    }
    url.searchParams.set("token", params.apiKey);

    this.ws = new WebSocket(url.toString());

    this.ws.onopen = () => {
      if (this.closed) return;
      for (const chunk of this.pendingChunks) {
        this.ws.send(chunk);
      }
      this.pendingChunks = [];
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    this.ws.onerror = (event: Event) => {
      console.error("[TelnyxSTT] WebSocket error:", event);
      this.closed = true;
    };

    this.ws.onclose = () => {
      this.closed = true;
    };
  }

  feed(chunk: ArrayBuffer): void {
    if (this.closed) return;

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    } else if (this.ws.readyState === WebSocket.CONNECTING) {
      this.pendingChunks.push(chunk);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingChunks = [];
    this.ws.close();
  }

  private handleMessage(event: MessageEvent): void {
    if (this.closed) return;
    let data: { transcript?: string; is_final?: boolean };
    try {
      data = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (typeof data.transcript !== "string" || data.transcript === "") return;

    if (data.is_final) {
      this.onUtterance?.(data.transcript);
    } else {
      this.onInterim?.(data.transcript);
    }
  }
}
