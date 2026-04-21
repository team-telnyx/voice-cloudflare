import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelnyxPhoneTransport } from "../../src/transport/phone-transport.js";
import type { VoiceTransport } from "@cloudflare/voice/client";
import type { TelnyxCallBridge } from "../../src/providers/call-bridge.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

function createMockTransport(): VoiceTransport & {
  _fireMessage: (data: string | ArrayBuffer | Blob) => void;
  _fireOpen: () => void;
  _fireClose: () => void;
  _fireError: (err?: unknown) => void;
} {
  const transport = {
    connected: false,
    onopen: null as (() => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as ((error?: unknown) => void) | null,
    onmessage: null as ((data: string | ArrayBuffer | Blob) => void) | null,
    sendJSON: vi.fn(),
    sendBinary: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    _fireMessage(data: string | ArrayBuffer | Blob) {
      transport.onmessage?.(data);
    },
    _fireOpen() {
      transport.onopen?.();
    },
    _fireClose() {
      transport.onclose?.();
    },
    _fireError(err?: unknown) {
      transport.onerror?.(err);
    },
  };
  return transport;
}

function createMockBridge(): TelnyxCallBridge {
  return {
    playAudio: vi.fn(),
    onAudioLevel: null,
    onAudioData: null,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  } as unknown as TelnyxCallBridge;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("TelnyxPhoneTransport", () => {
  let inner: ReturnType<typeof createMockTransport>;
  let bridge: ReturnType<typeof createMockBridge>;
  let transport: TelnyxPhoneTransport;

  beforeEach(() => {
    inner = createMockTransport();
    bridge = createMockBridge();
    transport = new TelnyxPhoneTransport({ inner, bridge });
  });

  describe("VoiceTransport delegation", () => {
    it("delegates sendJSON to inner transport", () => {
      transport.sendJSON({ type: "hello" });
      expect(inner.sendJSON).toHaveBeenCalledWith({ type: "hello" });
    });

    it("delegates sendBinary to inner transport", () => {
      const data = new ArrayBuffer(16);
      transport.sendBinary(data);
      expect(inner.sendBinary).toHaveBeenCalledWith(data);
    });

    it("delegates connect to inner transport", () => {
      transport.connect();
      expect(inner.connect).toHaveBeenCalled();
    });

    it("delegates disconnect to inner transport", () => {
      transport.disconnect();
      expect(inner.disconnect).toHaveBeenCalled();
    });

    it("reads connected from inner transport", () => {
      expect(transport.connected).toBe(false);
      inner.connected = true;
      expect(transport.connected).toBe(true);
    });
  });

  describe("callback proxying", () => {
    it("proxies onopen to VoiceClient handler", () => {
      const onopen = vi.fn();
      transport.onopen = onopen;
      transport.connect();
      inner._fireOpen();
      expect(onopen).toHaveBeenCalled();
    });

    it("proxies onclose to VoiceClient handler", () => {
      const onclose = vi.fn();
      transport.onclose = onclose;
      transport.connect();
      inner._fireClose();
      expect(onclose).toHaveBeenCalled();
    });

    it("proxies onerror to VoiceClient handler", () => {
      const onerror = vi.fn();
      transport.onerror = onerror;
      transport.connect();
      inner._fireError("fail");
      expect(onerror).toHaveBeenCalledWith("fail");
    });

    it("forwards JSON messages to VoiceClient handler", () => {
      const onmessage = vi.fn();
      transport.onmessage = onmessage;
      transport.connect();
      inner._fireMessage('{"type":"status","status":"listening"}');
      expect(onmessage).toHaveBeenCalledWith(
        '{"type":"status","status":"listening"}'
      );
    });

    it("forwards binary messages to VoiceClient handler", () => {
      const onmessage = vi.fn();
      transport.onmessage = onmessage;
      transport.connect();

      // Send audio_config first so transport knows format
      inner._fireMessage('{"type":"audio_config","format":"pcm16"}');

      const audio = new ArrayBuffer(320);
      inner._fireMessage(audio);
      expect(onmessage).toHaveBeenCalledWith(audio);
    });
  });

  describe("audio routing to bridge", () => {
    it("routes pcm16 audio to bridge.playAudio()", () => {
      transport.onmessage = vi.fn();
      transport.connect();

      // Declare pcm16 format
      inner._fireMessage('{"type":"audio_config","format":"pcm16"}');

      const audio = new ArrayBuffer(320);
      inner._fireMessage(audio);
      expect(bridge.playAudio).toHaveBeenCalledWith(audio);
    });

    it("does not route audio before audio_config is received", () => {
      transport.onmessage = vi.fn();
      transport.connect();

      const audio = new ArrayBuffer(320);
      inner._fireMessage(audio);
      expect(bridge.playAudio).not.toHaveBeenCalled();
    });

    it("does not route non-pcm16 audio to bridge", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      transport.onmessage = vi.fn();
      transport.connect();

      inner._fireMessage('{"type":"audio_config","format":"mp3"}');
      inner._fireMessage(new ArrayBuffer(320));

      expect(bridge.playAudio).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Server audio format is "mp3"')
      );
      warnSpy.mockRestore();
    });

    it("warns only once for non-pcm16 format", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      transport.onmessage = vi.fn();
      transport.connect();

      inner._fireMessage('{"type":"audio_config","format":"mp3"}');
      inner._fireMessage(new ArrayBuffer(320));
      inner._fireMessage(new ArrayBuffer(320));
      inner._fireMessage(new ArrayBuffer(320));

      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it("resets warning when audio_config changes", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      transport.onmessage = vi.fn();
      transport.connect();

      // First format: mp3 — triggers warning
      inner._fireMessage('{"type":"audio_config","format":"mp3"}');
      inner._fireMessage(new ArrayBuffer(320));
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Switch to pcm16 — should route to bridge
      inner._fireMessage('{"type":"audio_config","format":"pcm16"}');
      const audio = new ArrayBuffer(320);
      inner._fireMessage(audio);
      expect(bridge.playAudio).toHaveBeenCalledWith(audio);

      warnSpy.mockRestore();
    });

    it("routes Blob audio to bridge after converting to ArrayBuffer", async () => {
      transport.onmessage = vi.fn();
      transport.connect();

      inner._fireMessage('{"type":"audio_config","format":"pcm16"}');

      const data = new Uint8Array([1, 2, 3, 4]);
      const blob = new Blob([data]);
      inner._fireMessage(blob);

      // Blob.arrayBuffer() is async — wait for microtask
      await new Promise((r) => setTimeout(r, 0));
      expect(bridge.playAudio).toHaveBeenCalled();
    });
  });

  describe("onServerAudio callback", () => {
    it("calls onServerAudio for every binary frame regardless of format", () => {
      const onServerAudio = vi.fn();
      transport = new TelnyxPhoneTransport({ inner, bridge, onServerAudio });
      transport.onmessage = vi.fn();
      transport.connect();

      // mp3 format — won't go to bridge, but should go to callback
      inner._fireMessage('{"type":"audio_config","format":"mp3"}');
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const audio = new ArrayBuffer(320);
      inner._fireMessage(audio);

      expect(onServerAudio).toHaveBeenCalledWith(audio);
      expect(bridge.playAudio).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("does not call onServerAudio for JSON messages", () => {
      const onServerAudio = vi.fn();
      transport = new TelnyxPhoneTransport({ inner, bridge, onServerAudio });
      transport.onmessage = vi.fn();
      transport.connect();

      inner._fireMessage('{"type":"status","status":"speaking"}');
      expect(onServerAudio).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("handles malformed JSON gracefully", () => {
      transport.onmessage = vi.fn();
      transport.connect();

      // Should not throw
      inner._fireMessage("not json at all {{{");
      expect(transport.onmessage).toHaveBeenCalledWith("not json at all {{{");
    });

    it("works when no onmessage handler is set", () => {
      transport.connect();

      // Should not throw even without onmessage set
      inner._fireMessage('{"type":"audio_config","format":"pcm16"}');
      inner._fireMessage(new ArrayBuffer(320));
      expect(bridge.playAudio).toHaveBeenCalled();
    });
  });
});
