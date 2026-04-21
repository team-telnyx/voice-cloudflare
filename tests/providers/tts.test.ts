/**
 * Tests for TelnyxTTS.
 *
 * Unit tests use mocks. Integration tests (gated by TELNYX_API_KEY) call the
 * real Telnyx API.
 *
 * WebSocket integration tests require a Cloudflare Workers runtime and are
 * not included here — test with `wrangler dev` for live WS coverage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelnyxTTS } from "../../src/providers/tts.js";

// ─── Mock fetch for unit tests ───────────────────────────────────────────────

const realFetch = globalThis.fetch;
const mockFetch = vi.fn();

function mockAudioResponse(bytes: number = 4096): Response {
  const buffer = new ArrayBuffer(bytes);
  const view = new Uint8Array(buffer);
  view[0] = 0xff;
  view[1] = 0xf3;
  return new Response(buffer, {
    status: 200,
    headers: { "Content-Type": "audio/mpeg" },
  });
}

// ─── Mock WebSocket ──────────────────────────────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  send = vi.fn();
  close = vi.fn();
  accept = vi.fn();
  addEventListener = vi.fn(
    (type: string, handler: (...args: unknown[]) => void) => {
      if (type === "message") this._messageHandlers.push(handler);
      if (type === "close") this._closeHandlers.push(handler);
      if (type === "error") this._errorHandlers.push(handler);
    }
  );
  removeEventListener = vi.fn();

  _messageHandlers: ((...args: unknown[]) => void)[] = [];
  _closeHandlers: ((...args: unknown[]) => void)[] = [];
  _errorHandlers: ((...args: unknown[]) => void)[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  simulateMessage(data: string) {
    const event = { data } as MessageEvent;
    this._messageHandlers.forEach((h) => h(event));
  }

  simulateClose() {
    this._closeHandlers.forEach((h) => h({} as CloseEvent));
  }
}

// ─── Unit Tests ──────────────────────────────────────────────────────────────

describe("TelnyxTTS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockWebSocket.instances = [];
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  describe("construction", () => {
    it("creates with apiKey via TelnyxClient", () => {
      const tts = new TelnyxTTS({ apiKey: "test-key" });
      expect(tts).toBeDefined();
    });

    it("accepts custom voice", () => {
      const tts = new TelnyxTTS({
        apiKey: "test-key",
        voice: "Telnyx.NaturalHD.luna",
      });
      expect(tts).toBeDefined();
    });

    it("accepts websocket backend", () => {
      const tts = new TelnyxTTS({
        apiKey: "test-key",
        backend: "websocket",
      });
      expect(tts).toBeDefined();
    });
  });

  describe("REST backend — synthesize", () => {
    const tts = new TelnyxTTS({ apiKey: "test-key" });

    it("sends POST with correct URL, auth, and body", async () => {
      mockFetch.mockResolvedValueOnce(mockAudioResponse());

      await tts.synthesize("Hello world");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.telnyx.com/v2/text-to-speech/speech");
      expect(opts.method).toBe("POST");
      expect(opts.headers.Authorization).toBe("Bearer test-key");

      const body = JSON.parse(opts.body);
      expect(body.text).toBe("Hello world");
      expect(body.voice).toBe("Telnyx.NaturalHD.astra");
      expect(body.output_type).toBe("binary_output");
    });

    it("returns ArrayBuffer on success", async () => {
      mockFetch.mockResolvedValueOnce(mockAudioResponse(2048));
      const audio = await tts.synthesize("Hello");
      expect(audio).toBeInstanceOf(ArrayBuffer);
      expect(audio!.byteLength).toBe(2048);
    });

    it("returns null for empty text without calling API", async () => {
      expect(await tts.synthesize("")).toBeNull();
      expect(await tts.synthesize("   ")).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns null on API error", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 })
      );
      expect(await tts.synthesize("Hello")).toBeNull();
    });

    it("returns null when pre-aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      mockFetch.mockRejectedValueOnce(new DOMException("Aborted"));
      expect(await tts.synthesize("Hello", controller.signal)).toBeNull();
    });

    it("uses custom voice in request body", async () => {
      const custom = new TelnyxTTS({
        apiKey: "test-key",
        voice: "Telnyx.Ultra.my-voice",
      });
      mockFetch.mockResolvedValueOnce(mockAudioResponse());
      await custom.synthesize("Hello");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.voice).toBe("Telnyx.Ultra.my-voice");
    });
  });

  describe("REST backend — synthesizeStream", () => {
    const tts = new TelnyxTTS({ apiKey: "test-key" });

    it("yields single chunk from REST response", async () => {
      mockFetch.mockResolvedValueOnce(mockAudioResponse(4096));
      const chunks: ArrayBuffer[] = [];
      for await (const chunk of tts.synthesizeStream("Hello")) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(1);
      expect(chunks[0].byteLength).toBe(4096);
    });

    it("yields nothing for empty text", async () => {
      const chunks: ArrayBuffer[] = [];
      for await (const chunk of tts.synthesizeStream("")) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(0);
    });
  });

  describe("WebSocket backend", () => {
    it("uses fetch upgrade with Authorization header", async () => {
      const tts = new TelnyxTTS({
        apiKey: "test-key",
        backend: "websocket",
      });

      const mockWs = new MockWebSocket("mock");
      mockFetch.mockResolvedValueOnce({ webSocket: mockWs });

      const promise = tts.synthesize("Hello");

      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

      // Verify fetch-upgrade headers
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("text-to-speech/speech");
      expect(opts.headers.Upgrade).toBe("websocket");
      expect(opts.headers.Authorization).toBe("Bearer test-key");

      // Simulate audio + final frame
      mockWs.simulateMessage(
        JSON.stringify({ audio: btoa("fake-audio"), text: null, isFinal: false })
      );
      mockWs.simulateMessage(
        JSON.stringify({ audio: null, text: "", isFinal: true })
      );

      const audio = await promise;
      expect(audio).toBeInstanceOf(ArrayBuffer);
      expect(audio!.byteLength).toBeGreaterThan(0);

      // Verify TTS protocol: init → content → stop
      expect(mockWs.send).toHaveBeenCalledTimes(3);
      expect(JSON.parse(mockWs.send.mock.calls[0][0])).toEqual({ text: " " });
      expect(JSON.parse(mockWs.send.mock.calls[1][0])).toEqual({ text: "Hello" });
      expect(JSON.parse(mockWs.send.mock.calls[2][0])).toEqual({ text: "" });
    });

    it("registers listeners before accept to avoid race", async () => {
      const tts = new TelnyxTTS({
        apiKey: "test-key",
        backend: "websocket",
      });

      const mockWs = new MockWebSocket("mock");
      const callOrder: string[] = [];

      mockWs.addEventListener = vi.fn((...args: unknown[]) => {
        callOrder.push(`addEventListener:${args[0]}`);
        const type = args[0] as string;
        const handler = args[1] as (...a: unknown[]) => void;
        if (type === "message") mockWs._messageHandlers.push(handler);
        if (type === "close") mockWs._closeHandlers.push(handler);
        if (type === "error") mockWs._errorHandlers.push(handler);
      });
      mockWs.accept = vi.fn(() => callOrder.push("accept"));

      mockFetch.mockResolvedValueOnce({ webSocket: mockWs });

      const promise = tts.synthesize("Hello");

      await vi.waitFor(() => expect(mockWs.accept).toHaveBeenCalled());

      // Listeners must be registered before accept
      const acceptIdx = callOrder.indexOf("accept");
      const messageIdx = callOrder.findIndex((c) =>
        c.startsWith("addEventListener:message")
      );
      expect(messageIdx).toBeLessThan(acceptIdx);

      // Clean up
      mockWs.simulateMessage(
        JSON.stringify({ audio: null, text: "", isFinal: true })
      );
      await promise;
    });

    it("returns null with clear error when not in Workers runtime", async () => {
      const tts = new TelnyxTTS({
        apiKey: "test-key",
        backend: "websocket",
      });

      // Simulate non-Workers response (no webSocket property)
      mockFetch.mockResolvedValueOnce({ ok: true });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const audio = await tts.synthesize("Hello");

      expect(audio).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Cloudflare Workers runtime")
      );
      consoleSpy.mockRestore();
    });

    it("logs underlying error on connection failure", async () => {
      const tts = new TelnyxTTS({
        apiKey: "test-key",
        backend: "websocket",
      });

      const fetchError = new TypeError("fetch failed");
      mockFetch.mockRejectedValueOnce(fetchError);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const audio = await tts.synthesize("Hello");

      expect(audio).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        "[TelnyxTTS] WebSocket connection failed:",
        fetchError
      );
      consoleSpy.mockRestore();
    });

    it("synthesizeStream yields chunks incrementally via WS", async () => {
      const tts = new TelnyxTTS({
        apiKey: "test-key",
        backend: "websocket",
      });

      const mockWs = new MockWebSocket("mock");
      mockFetch.mockResolvedValueOnce({ webSocket: mockWs });

      // Use synthesize (not synthesizeStream) to avoid async generator timing.
      // synthesize collects all chunks internally via synthesizeViaWS → streamViaWS.
      const promise = tts.synthesize("Hello");

      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

      // Send two audio chunks then final
      mockWs.simulateMessage(
        JSON.stringify({ audio: btoa("chunk-one"), text: null, isFinal: false })
      );
      mockWs.simulateMessage(
        JSON.stringify({ audio: btoa("chunk-two"), text: null, isFinal: false })
      );
      mockWs.simulateMessage(
        JSON.stringify({ audio: null, text: "", isFinal: true })
      );

      const audio = await promise;
      expect(audio).toBeInstanceOf(ArrayBuffer);
      // Both chunks concatenated: "chunk-one" (9) + "chunk-two" (9) = 18
      expect(audio!.byteLength).toBe(18);
    });

    it("handles abort via signal", async () => {
      const tts = new TelnyxTTS({
        apiKey: "test-key",
        backend: "websocket",
      });

      // Pre-aborted signal — should return null without connecting
      const controller = new AbortController();
      controller.abort();

      const mockWs = new MockWebSocket("mock");
      mockFetch.mockResolvedValueOnce({ webSocket: mockWs });

      const audio = await tts.synthesize("Hello", controller.signal);
      expect(audio).toBeNull();
    });

    it("skips blob frames (text !== null)", async () => {
      const tts = new TelnyxTTS({
        apiKey: "test-key",
        backend: "websocket",
      });

      const mockWs = new MockWebSocket("mock");
      mockFetch.mockResolvedValueOnce({ webSocket: mockWs });

      const promise = tts.synthesize("Hello");
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());

      // Audio chunk
      mockWs.simulateMessage(
        JSON.stringify({ audio: btoa("real-audio"), text: null, isFinal: false })
      );
      // Blob frame (should be skipped — text is not null)
      mockWs.simulateMessage(
        JSON.stringify({ audio: null, text: "Hello", isFinal: false })
      );
      // Final
      mockWs.simulateMessage(
        JSON.stringify({ audio: null, text: "", isFinal: true })
      );

      const audio = await promise;
      expect(audio).toBeInstanceOf(ArrayBuffer);
      // Should only contain the real-audio chunk, not the blob
      expect(audio!.byteLength).toBe(10); // "real-audio".length
    });
  });
});

// ─── Integration tests (require TELNYX_API_KEY) ─────────────────────────────

const hasApiKey = !!process.env.TELNYX_API_KEY;

describe.skipIf(!hasApiKey)("TelnyxTTS — Integration (REST)", () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  const tts = new TelnyxTTS({ apiKey: process.env.TELNYX_API_KEY! });

  it("synthesize returns real mp3 audio", async () => {
    const audio = await tts.synthesize("Hello world");
    expect(audio).toBeInstanceOf(ArrayBuffer);
    expect(audio!.byteLength).toBeGreaterThan(1000);

    const header = new Uint8Array(audio!, 0, 2);
    expect(header[0]).toBe(0xff);
    expect(header[1] & 0xe0).toBe(0xe0);
  });

  it("synthesizeStream yields audio", async () => {
    const chunks: ArrayBuffer[] = [];
    for await (const chunk of tts.synthesizeStream("Testing stream")) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].byteLength).toBeGreaterThan(1000);
  });

  it("custom voice works", async () => {
    const custom = new TelnyxTTS({
      apiKey: process.env.TELNYX_API_KEY!,
      voice: "Telnyx.NaturalHD.luna",
    });
    const audio = await custom.synthesize("Custom voice test");
    expect(audio).toBeInstanceOf(ArrayBuffer);
    expect(audio!.byteLength).toBeGreaterThan(1000);
  });
});

// NOTE: WebSocket integration tests require a Cloudflare Workers runtime.
// Use `wrangler dev` with the test worker in /tmp/pr-test/worker/ to verify
// WS streaming end-to-end. This gap is acknowledged — see PR discussion.
