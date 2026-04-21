import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelnyxSTT } from "../../src/providers/stt.js";

// ---------------------------------------------------------------------------
// Mock WebSocket returned by the Cloudflare Workers fetch-upgrade pattern
// ---------------------------------------------------------------------------
interface MockWs {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  accept: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  simulateMessage(data: unknown): void;
  simulateClose(): void;
  simulateError(): void;
}

function createMockWebSocket(): MockWs {
  const listeners: Record<string, Function[]> = {};

  return {
    send: vi.fn(),
    close: vi.fn(),
    accept: vi.fn(),
    addEventListener: vi.fn((event: string, handler: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    simulateMessage(data: unknown) {
      for (const handler of listeners["message"] ?? []) {
        handler(new MessageEvent("message", { data: JSON.stringify(data) }));
      }
    },
    simulateClose() {
      for (const handler of listeners["close"] ?? []) {
        handler(new Event("close"));
      }
    },
    simulateError() {
      for (const handler of listeners["error"] ?? []) {
        handler(new Event("error"));
      }
    },
  };
}

// Track all WebSocket mocks created by fetch
let mockWebSockets: MockWs[] = [];

const mockFetch = vi.fn(() => {
  const ws = createMockWebSocket();
  mockWebSockets.push(ws);
  return Promise.resolve({ webSocket: ws });
});

vi.stubGlobal("fetch", mockFetch);

// Helper: let the async fetch-upgrade connection settle
const flushConnection = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mockWebSockets = [];
  mockFetch.mockClear();
  mockFetch.mockImplementation(() => {
    const ws = createMockWebSocket();
    mockWebSockets.push(ws);
    return Promise.resolve({ webSocket: ws });
  });
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

    it("calls fetch with the correct URL and Authorization header", async () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession();
      await flushConnection();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://api.telnyx.com/v2/speech-to-text/transcription?transcription_engine=Telnyx&input_format=pcm&language=en&interim_results=true"
      );
      expect(opts.headers.Authorization).toBe("Bearer test-key");
      expect(opts.headers.Upgrade).toBe("websocket");
    });

    it("does not leak the API key in the URL", async () => {
      const stt = new TelnyxSTT({ apiKey: "KEY_abc123" });
      stt.createSession();
      await flushConnection();

      const [url] = mockFetch.mock.calls[0];
      expect(url).not.toContain("KEY_abc123");
      expect(url).not.toContain("token=");
    });

    it("includes custom engine and input format in the fetch URL", async () => {
      const stt = new TelnyxSTT({
        apiKey: "test-key",
        engine: "Deepgram",
        inputFormat: "mp3",
      });
      stt.createSession();
      await flushConnection();

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("transcription_engine=Deepgram");
      expect(url).toContain("input_format=mp3");
    });

    it("uses sttWsUrl override when provided", async () => {
      const stt = new TelnyxSTT({
        apiKey: "test-key",
        sttWsUrl: "wss://localhost:9000/stt",
      });
      stt.createSession();
      await flushConnection();

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://localhost:9000/stt?transcription_engine=Telnyx&input_format=pcm&language=en&interim_results=true"
      );
    });

    it("passes session-level language override to the URL", async () => {
      const stt = new TelnyxSTT({ apiKey: "test-key", language: "en" });
      stt.createSession({ language: "fr" });
      await flushConnection();

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("language=fr");
    });

    it("includes transcription_model when provided", async () => {
      const stt = new TelnyxSTT({
        apiKey: "test-key",
        engine: "Deepgram",
        transcriptionModel: "nova-3",
      });
      stt.createSession();
      await flushConnection();

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("transcription_model=nova-3");
    });

    it("omits transcription_model when not provided", async () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession();
      await flushConnection();

      const [url] = mockFetch.mock.calls[0];
      expect(url).not.toContain("transcription_model");
    });

    it("calls accept() on the WebSocket after registering listeners", async () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession();
      await flushConnection();

      const ws = mockWebSockets[0];
      expect(ws.accept).toHaveBeenCalledTimes(1);
      // Listeners registered before accept
      expect(ws.addEventListener).toHaveBeenCalledBefore(ws.accept);
    });
  });
});

describe("TelnyxSTTSession", () => {
  describe("feed()", () => {
    it("buffers audio chunks before connection is established", async () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();

      // Feed before the async connect() resolves — ws is not yet assigned
      const chunk = new ArrayBuffer(1024);
      session.feed(chunk);

      // The fetch mock runs synchronously, but the await hasn't resolved,
      // so the session's internal ws is still null and send is not called.
      if (mockWebSockets.length > 0) {
        expect(mockWebSockets[0].send).not.toHaveBeenCalled();
      }

      // After connection settles, the buffered chunk is flushed
      await flushConnection();
      expect(mockWebSockets[0].send).toHaveBeenCalledWith(chunk);
    });

    it("flushes buffered chunks when connection is established", async () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();

      const chunk1 = new ArrayBuffer(1024);
      const chunk2 = new ArrayBuffer(512);
      session.feed(chunk1);
      session.feed(chunk2);

      await flushConnection();

      const ws = mockWebSockets[0];
      expect(ws.send).toHaveBeenCalledTimes(2);
      expect(ws.send).toHaveBeenNthCalledWith(1, chunk1);
      expect(ws.send).toHaveBeenNthCalledWith(2, chunk2);
    });

    it("sends chunks directly when connection is already open", async () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      await flushConnection();

      const ws = mockWebSockets[0];
      const chunk = new ArrayBuffer(2048);
      session.feed(chunk);

      expect(ws.send).toHaveBeenCalledWith(chunk);
    });

    it("does nothing after close()", async () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      await flushConnection();

      session.close();

      const ws = mockWebSockets[0];
      ws.send.mockClear();

      const chunk = new ArrayBuffer(1024);
      session.feed(chunk);

      expect(ws.send).not.toHaveBeenCalled();
    });

    it("does nothing after WebSocket error", async () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      await flushConnection();

      const ws = mockWebSockets[0];
      ws.simulateError();
      ws.send.mockClear();

      const chunk = new ArrayBuffer(1024);
      session.feed(chunk);

      expect(ws.send).not.toHaveBeenCalled();
    });

    it("does nothing after fetch fails", async () => {
      mockFetch.mockImplementationOnce(() =>
        Promise.reject(new Error("network error"))
      );

      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      await flushConnection();

      const chunk = new ArrayBuffer(1024);
      session.feed(chunk);

      // No ws was created, so nothing to send on
      expect(mockWebSockets).toHaveLength(0);
    });

    it("does nothing when fetch returns no webSocket", async () => {
      mockFetch.mockImplementationOnce(() =>
        Promise.resolve({ webSocket: undefined })
      );

      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      await flushConnection();

      const chunk = new ArrayBuffer(1024);
      session.feed(chunk);

      expect(mockWebSockets).toHaveLength(0);
    });
  });

  describe("transcript callbacks", () => {
    it("fires onInterim for non-final transcripts", async () => {
      const onInterim = vi.fn();
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession({ onInterim });
      await flushConnection();

      const ws = mockWebSockets[0];
      ws.simulateMessage({ transcript: "Hello", is_final: false, confidence: 0.8 });

      expect(onInterim).toHaveBeenCalledWith("Hello");
      expect(onInterim).toHaveBeenCalledTimes(1);
    });

    it("fires onUtterance for final transcripts", async () => {
      const onUtterance = vi.fn();
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession({ onUtterance });
      await flushConnection();

      const ws = mockWebSockets[0];
      ws.simulateMessage({ transcript: "Hello world", is_final: true, confidence: 0.95 });

      expect(onUtterance).toHaveBeenCalledWith("Hello world");
      expect(onUtterance).toHaveBeenCalledTimes(1);
    });

    it("fires onInterim multiple times as transcript builds up", async () => {
      const onInterim = vi.fn();
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession({ onInterim });
      await flushConnection();

      const ws = mockWebSockets[0];
      ws.simulateMessage({ transcript: "Hel", is_final: false });
      ws.simulateMessage({ transcript: "Hello", is_final: false });
      ws.simulateMessage({ transcript: "Hello wor", is_final: false });

      expect(onInterim).toHaveBeenCalledTimes(3);
      expect(onInterim).toHaveBeenNthCalledWith(1, "Hel");
      expect(onInterim).toHaveBeenNthCalledWith(2, "Hello");
      expect(onInterim).toHaveBeenNthCalledWith(3, "Hello wor");
    });

    it("ignores messages with empty transcript", async () => {
      const onInterim = vi.fn();
      const onUtterance = vi.fn();
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession({ onInterim, onUtterance });
      await flushConnection();

      const ws = mockWebSockets[0];
      ws.simulateMessage({ transcript: "", is_final: false });
      ws.simulateMessage({ transcript: "", is_final: true });

      expect(onInterim).not.toHaveBeenCalled();
      expect(onUtterance).not.toHaveBeenCalled();
    });

    it("ignores messages without transcript field", async () => {
      const onInterim = vi.fn();
      const onUtterance = vi.fn();
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession({ onInterim, onUtterance });
      await flushConnection();

      const ws = mockWebSockets[0];
      ws.simulateMessage({ error: "something went wrong" });

      expect(onInterim).not.toHaveBeenCalled();
      expect(onUtterance).not.toHaveBeenCalled();
    });

    it("ignores unparseable messages", async () => {
      const onInterim = vi.fn();
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession({ onInterim });
      await flushConnection();

      const ws = mockWebSockets[0];
      // Trigger the message listener with raw non-JSON data
      const listeners: Record<string, Function[]> = {};
      for (const call of ws.addEventListener.mock.calls) {
        if (!listeners[call[0]]) listeners[call[0]] = [];
        listeners[call[0]].push(call[1]);
      }
      for (const handler of listeners["message"] ?? []) {
        handler(new MessageEvent("message", { data: "not json" }));
      }

      expect(onInterim).not.toHaveBeenCalled();
    });

    it("works without any callbacks provided", async () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      stt.createSession();
      await flushConnection();

      const ws = mockWebSockets[0];
      // Should not throw
      expect(() => {
        ws.simulateMessage({ transcript: "Hello", is_final: false });
        ws.simulateMessage({ transcript: "Hello", is_final: true });
      }).not.toThrow();
    });
  });

  describe("close()", () => {
    it("closes the WebSocket", async () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      await flushConnection();

      const ws = mockWebSockets[0];
      session.close();

      expect(ws.close).toHaveBeenCalledTimes(1);
    });

    it("clears pending buffer on close before connection", async () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();

      // Buffer some chunks before connection establishes
      session.feed(new ArrayBuffer(1024));
      session.feed(new ArrayBuffer(1024));

      session.close();

      await flushConnection();

      // Even after connection resolves, buffered chunks should NOT be flushed
      if (mockWebSockets.length > 0) {
        expect(mockWebSockets[0].send).not.toHaveBeenCalled();
      }
    });

    it("is idempotent — calling close() twice does not throw", async () => {
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession();
      await flushConnection();

      expect(() => {
        session.close();
        session.close();
      }).not.toThrow();

      const ws = mockWebSockets[0];
      // Only one actual close call
      expect(ws.close).toHaveBeenCalledTimes(1);
    });

    it("stops firing callbacks after close", async () => {
      const onInterim = vi.fn();
      const onUtterance = vi.fn();
      const stt = new TelnyxSTT({ apiKey: "test-key" });
      const session = stt.createSession({ onInterim, onUtterance });
      await flushConnection();

      session.close();

      const ws = mockWebSockets[0];
      ws.simulateMessage({ transcript: "Hello", is_final: false });
      ws.simulateMessage({ transcript: "Hello", is_final: true });

      expect(onInterim).not.toHaveBeenCalled();
      expect(onUtterance).not.toHaveBeenCalled();
    });
  });
});
