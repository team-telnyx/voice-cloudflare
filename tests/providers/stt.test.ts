import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelnyxSTT } from "../../src/providers/stt.js";

// Mock WebSocket globally
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  send = vi.fn();
  close = vi.fn();

  constructor(url: string, _protocols?: string | string[]) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  // Test helpers
  static instances: MockWebSocket[] = [];
  static reset() {
    MockWebSocket.instances = [];
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  simulateError() {
    this.onerror?.(new Event("error"));
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

beforeEach(() => {
  MockWebSocket.reset();
});

describe("TelnyxSTT", () => {
  describe("config", () => {
    it("creates with just an API key", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      expect(stt).toBeDefined();
    });

    it("accepts engine, language, inputFormat, and interimResults overrides", () => {
      const stt = new TelnyxSTT({
        apiKey: "test-key",
        engine: "Deepgram",
        language: "es",
        inputFormat: "wav",
        transcriptionModel: "nova-3",
        interimResults: false,
      });
      expect(stt).toBeDefined();
    });
  });

  describe("createSession", () => {
    it("returns a session with feed and close methods", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      expect(typeof session.feed).toBe("function");
      expect(typeof session.close).toBe("function");
    });

    it("opens a WebSocket to the STT endpoint with default query params", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession();

      expect(MockWebSocket.instances).toHaveLength(1);
      const ws = MockWebSocket.instances[0];
      expect(ws.url).toBe(
        "wss://api.telnyx.com/v2/speech-to-text/transcription?transcription_engine=Telnyx&input_format=pcm&token=test-key"
      );
    });

    it("includes custom engine and input format in the WebSocket URL", () => {
      const stt = new TelnyxSTT({
        apiKey: "test-key",
        engine: "Deepgram",
        inputFormat: "mp3",
      });
      stt.createSession();

      const ws = MockWebSocket.instances[0];
      expect(ws.url).toContain("transcription_engine=Deepgram");
      expect(ws.url).toContain("input_format=mp3");
    });

    it("includes API key as token query param for auth", () => {
      const stt = new TelnyxSTT({ apiKey: "KEY_abc123" });
      stt.createSession();

      const ws = MockWebSocket.instances[0];
      expect(ws.url).toContain("token=KEY_abc123");
    });

    it("uses wsUrl override when provided", () => {
      const stt = new TelnyxSTT({
        apiKey: "test-key",
        wsUrl: "ws://localhost:9000/stt",
      });
      stt.createSession();

      const ws = MockWebSocket.instances[0];
      expect(ws.url).toBe(
        "ws://localhost:9000/stt?transcription_engine=Telnyx&input_format=pcm&token=test-key"
      );
    });

    it("passes session-level language override", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key", language: "en" });
      const onUtterance = vi.fn();
      const session = stt.createSession({ language: "fr", onUtterance });
      expect(session).toBeDefined();
    });
  });
});
