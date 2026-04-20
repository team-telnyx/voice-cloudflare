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
        "wss://api.telnyx.com/v2/speech-to-text/transcription?transcription_engine=Telnyx&input_format=pcm&language=en&interim_results=true&token=test-key"
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
        "ws://localhost:9000/stt?transcription_engine=Telnyx&input_format=pcm&language=en&interim_results=true&token=test-key"
      );
    });

    it("passes session-level language override to the WebSocket URL", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key", language: "en" });
      stt.createSession({ language: "fr" });

      const ws = MockWebSocket.instances[0];
      expect(ws.url).toContain("language=fr");
    });

    it("includes transcription_model when provided", () => {
      const stt = new TelnyxSTT({
        apiKey: "test-key",
        engine: "Deepgram",
        transcriptionModel: "nova-3",
      });
      stt.createSession();

      const ws = MockWebSocket.instances[0];
      expect(ws.url).toContain("transcription_model=nova-3");
    });

    it("omits transcription_model when not provided", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession();

      const ws = MockWebSocket.instances[0];
      expect(ws.url).not.toContain("transcription_model");
    });
  });
});

describe("TelnyxSTTSession", () => {
  describe("feed()", () => {
    it("buffers audio chunks before WebSocket is open", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      const ws = MockWebSocket.instances[0];

      const chunk = new ArrayBuffer(1024);
      session.feed(chunk);

      expect(ws.send).not.toHaveBeenCalled();
    });

    it("flushes buffered chunks when WebSocket opens", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      const ws = MockWebSocket.instances[0];

      const chunk1 = new ArrayBuffer(1024);
      const chunk2 = new ArrayBuffer(512);
      session.feed(chunk1);
      session.feed(chunk2);

      ws.simulateOpen();

      expect(ws.send).toHaveBeenCalledTimes(2);
      expect(ws.send).toHaveBeenNthCalledWith(1, chunk1);
      expect(ws.send).toHaveBeenNthCalledWith(2, chunk2);
    });

    it("sends chunks directly when WebSocket is already open", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      const ws = MockWebSocket.instances[0];

      ws.simulateOpen();

      const chunk = new ArrayBuffer(2048);
      session.feed(chunk);

      expect(ws.send).toHaveBeenCalledWith(chunk);
    });

    it("does nothing after close()", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      const ws = MockWebSocket.instances[0];

      ws.simulateOpen();
      session.close();

      const chunk = new ArrayBuffer(1024);
      session.feed(chunk);

      // send was never called with audio (only ws.close was called)
      expect(ws.send).not.toHaveBeenCalled();
    });

    it("does nothing after WebSocket error", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      const ws = MockWebSocket.instances[0];

      ws.simulateError();

      const chunk = new ArrayBuffer(1024);
      session.feed(chunk);

      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe("transcript callbacks", () => {
    it("fires onInterim for non-final transcripts", () => {
      const onInterim = vi.fn();
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession({ onInterim });
      const ws = MockWebSocket.instances[0];

      ws.simulateOpen();
      ws.simulateMessage({ transcript: "Hello", is_final: false, confidence: 0.8 });

      expect(onInterim).toHaveBeenCalledWith("Hello");
      expect(onInterim).toHaveBeenCalledTimes(1);
    });

    it("fires onUtterance for final transcripts", () => {
      const onUtterance = vi.fn();
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession({ onUtterance });
      const ws = MockWebSocket.instances[0];

      ws.simulateOpen();
      ws.simulateMessage({ transcript: "Hello world", is_final: true, confidence: 0.95 });

      expect(onUtterance).toHaveBeenCalledWith("Hello world");
      expect(onUtterance).toHaveBeenCalledTimes(1);
    });

    it("fires onInterim multiple times as transcript builds up", () => {
      const onInterim = vi.fn();
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession({ onInterim });
      const ws = MockWebSocket.instances[0];

      ws.simulateOpen();
      ws.simulateMessage({ transcript: "Hel", is_final: false });
      ws.simulateMessage({ transcript: "Hello", is_final: false });
      ws.simulateMessage({ transcript: "Hello wor", is_final: false });

      expect(onInterim).toHaveBeenCalledTimes(3);
      expect(onInterim).toHaveBeenNthCalledWith(1, "Hel");
      expect(onInterim).toHaveBeenNthCalledWith(2, "Hello");
      expect(onInterim).toHaveBeenNthCalledWith(3, "Hello wor");
    });

    it("ignores messages with empty transcript", () => {
      const onInterim = vi.fn();
      const onUtterance = vi.fn();
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession({ onInterim, onUtterance });
      const ws = MockWebSocket.instances[0];

      ws.simulateOpen();
      ws.simulateMessage({ transcript: "", is_final: false });
      ws.simulateMessage({ transcript: "", is_final: true });

      expect(onInterim).not.toHaveBeenCalled();
      expect(onUtterance).not.toHaveBeenCalled();
    });

    it("ignores messages without transcript field", () => {
      const onInterim = vi.fn();
      const onUtterance = vi.fn();
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession({ onInterim, onUtterance });
      const ws = MockWebSocket.instances[0];

      ws.simulateOpen();
      ws.simulateMessage({ error: "something went wrong" });

      expect(onInterim).not.toHaveBeenCalled();
      expect(onUtterance).not.toHaveBeenCalled();
    });

    it("ignores unparseable messages", () => {
      const onInterim = vi.fn();
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession({ onInterim });
      const ws = MockWebSocket.instances[0];

      ws.simulateOpen();
      // Send raw string that is not valid JSON
      ws.onmessage?.(new MessageEvent("message", { data: "not json" }));

      expect(onInterim).not.toHaveBeenCalled();
    });

    it("works without any callbacks provided", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      const ws = MockWebSocket.instances[0];

      ws.simulateOpen();
      // Should not throw
      expect(() => {
        ws.simulateMessage({ transcript: "Hello", is_final: false });
        ws.simulateMessage({ transcript: "Hello", is_final: true });
      }).not.toThrow();
    });
  });

  describe("close()", () => {
    it("closes the WebSocket", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      const ws = MockWebSocket.instances[0];

      ws.simulateOpen();
      session.close();

      expect(ws.close).toHaveBeenCalledTimes(1);
    });

    it("clears pending buffer on close", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      const ws = MockWebSocket.instances[0];

      // Buffer some chunks before socket opens
      session.feed(new ArrayBuffer(1024));
      session.feed(new ArrayBuffer(1024));

      session.close();

      // Now open — buffered chunks should NOT be flushed
      ws.simulateOpen();

      expect(ws.send).not.toHaveBeenCalled();
    });

    it("is idempotent — calling close() twice does not throw", () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      const ws = MockWebSocket.instances[0];

      ws.simulateOpen();

      expect(() => {
        session.close();
        session.close();
      }).not.toThrow();

      // Only one actual close call
      expect(ws.close).toHaveBeenCalledTimes(1);
    });

    it("stops firing callbacks after close", () => {
      const onInterim = vi.fn();
      const onUtterance = vi.fn();
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession({ onInterim, onUtterance });
      const ws = MockWebSocket.instances[0];

      ws.simulateOpen();
      session.close();

      ws.simulateMessage({ transcript: "Hello", is_final: false });
      ws.simulateMessage({ transcript: "Hello", is_final: true });

      expect(onInterim).not.toHaveBeenCalled();
      expect(onUtterance).not.toHaveBeenCalled();
    });
  });
});
