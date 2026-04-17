import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelnyxCallBridge } from "../../src/providers/call-bridge.js";

vi.mock("@telnyx/webrtc", () => {
  const mockClient = {
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  return {
    TelnyxRTC: vi.fn(() => mockClient),
    __mockClient: mockClient,
  };
});

describe("TelnyxCallBridge", () => {
  describe("config and interface", () => {
    it("creates with a login token", () => {
      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });
      expect(bridge).toBeDefined();
    });

    it("implements VoiceAudioInput interface shape", () => {
      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });
      expect(typeof bridge.start).toBe("function");
      expect(typeof bridge.stop).toBe("function");
      expect(bridge.onAudioLevel).toBeNull();
      expect(bridge.onAudioData).toBeNull();
    });

    it("exposes connected as false initially", () => {
      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });
      expect(bridge.connected).toBe(false);
    });

    it("exposes activeCall as null initially", () => {
      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });
      expect(bridge.activeCall).toBeNull();
    });

    it("accepts optional config overrides", () => {
      const bridge = new TelnyxCallBridge({
        loginToken: "test-jwt",
        autoAnswer: true,
        debug: true,
      });
      expect(bridge).toBeDefined();
    });
  });

  describe("connection lifecycle", () => {
    it("start() creates a TelnyxRTC client with login_token from config", async () => {
      const { TelnyxRTC, __mockClient } = await import("@telnyx/webrtc") as any;

      // Make on() call the "telnyx.ready" callback immediately
      __mockClient.on.mockImplementation((event: string, cb: () => void) => {
        if (event === "telnyx.ready") cb();
      });

      const bridge = new TelnyxCallBridge({ loginToken: "my-token" });
      await bridge.start();

      expect(TelnyxRTC).toHaveBeenCalledWith(
        expect.objectContaining({ login_token: "my-token" })
      );
    });

    it("start() resolves when telnyx.ready fires and connected becomes true", async () => {
      const { __mockClient } = await import("@telnyx/webrtc") as any;

      __mockClient.on.mockImplementation((event: string, cb: () => void) => {
        if (event === "telnyx.ready") cb();
      });

      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });
      await bridge.start();

      expect(bridge.connected).toBe(true);
    });

    it("stop() disconnects the client and sets connected to false", async () => {
      const { __mockClient } = await import("@telnyx/webrtc") as any;

      __mockClient.on.mockImplementation((event: string, cb: () => void) => {
        if (event === "telnyx.ready") cb();
      });

      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });
      await bridge.start();
      expect(bridge.connected).toBe(true);

      bridge.stop();

      expect(bridge.connected).toBe(false);
      expect(__mockClient.disconnect).toHaveBeenCalled();
    });

    it("stop() is safe to call without calling start() first", () => {
      const bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });
      expect(() => bridge.stop()).not.toThrow();
      expect(bridge.connected).toBe(false);
    });
  });

  describe("inbound call handling", () => {
    let bridge: TelnyxCallBridge;
    let notificationHandler: (notification: any) => void;
    let mockCall: any;

    beforeEach(async () => {
      vi.clearAllMocks();

      const { TelnyxRTC, __mockClient } = await import("@telnyx/webrtc") as any;
      const handlers: Record<string, Function> = {};

      __mockClient.on.mockImplementation((event: string, cb: Function) => {
        handlers[event] = cb;
      });

      bridge = new TelnyxCallBridge({ loginToken: "jwt", autoAnswer: true });

      const startPromise = bridge.start();
      handlers["telnyx.ready"]();
      await startPromise;

      notificationHandler = handlers["telnyx.notification"];

      mockCall = {
        id: "call-123",
        state: "ringing",
        answer: vi.fn(),
        hangup: vi.fn(),
        dtmf: vi.fn(),
        remoteStream: null,
      };
    });

    it("sets activeCall when a call starts ringing", () => {
      notificationHandler({ type: "callUpdate", call: mockCall });
      expect(bridge.activeCall).toBe(mockCall);
    });

    it("auto-answers inbound call when autoAnswer is true", () => {
      notificationHandler({ type: "callUpdate", call: mockCall });
      expect(mockCall.answer).toHaveBeenCalled();
    });

    it("does not auto-answer when autoAnswer is false", () => {
      bridge.stop();
      bridge = new TelnyxCallBridge({ loginToken: "jwt", autoAnswer: false });
      (bridge as any).handleNotification({ type: "callUpdate", call: mockCall });
      expect(mockCall.answer).not.toHaveBeenCalled();
    });

    it("clears activeCall when call state is destroy", () => {
      notificationHandler({ type: "callUpdate", call: mockCall });
      expect(bridge.activeCall).toBe(mockCall);

      mockCall.state = "destroy";
      notificationHandler({ type: "callUpdate", call: mockCall });
      expect(bridge.activeCall).toBeNull();
    });

    it("clears activeCall when call state is hangup", () => {
      notificationHandler({ type: "callUpdate", call: mockCall });
      mockCall.state = "hangup";
      notificationHandler({ type: "callUpdate", call: mockCall });
      expect(bridge.activeCall).toBeNull();
    });
  });

  describe("audio capture", () => {
    let bridge: TelnyxCallBridge;
    let notificationHandler: (notification: any) => void;
    let mockCall: any;
    let workletMessageHandler: ((event: MessageEvent) => void) | null = null;

    const mockWorkletNode = {
      port: {
        onmessage: null as ((event: MessageEvent) => void) | null,
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    const mockSourceNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    const mockAudioContext = {
      audioWorklet: {
        addModule: vi.fn().mockResolvedValue(undefined),
      },
      createMediaStreamSource: vi.fn(() => mockSourceNode),
      close: vi.fn(),
      sampleRate: 16000,
    };

    beforeEach(async () => {
      vi.clearAllMocks();

      workletMessageHandler = null;
      Object.defineProperty(mockWorkletNode.port, "onmessage", {
        get: () => workletMessageHandler,
        set: (handler) => {
          workletMessageHandler = handler;
        },
        configurable: true,
      });

      vi.stubGlobal("AudioContext", vi.fn(() => mockAudioContext));
      vi.stubGlobal("AudioWorkletNode", vi.fn(() => mockWorkletNode));
      vi.stubGlobal("URL", {
        createObjectURL: vi.fn(() => "blob:mock-url"),
        revokeObjectURL: vi.fn(),
      });
      vi.stubGlobal("Blob", vi.fn());

      const { __mockClient } = await import("@telnyx/webrtc") as any;
      const handlers: Record<string, Function> = {};
      __mockClient.on.mockImplementation((event: string, cb: Function) => {
        handlers[event] = cb;
      });

      bridge = new TelnyxCallBridge({ loginToken: "jwt", autoAnswer: true });
      const startPromise = bridge.start();
      handlers["telnyx.ready"]();
      await startPromise;
      notificationHandler = handlers["telnyx.notification"];

      mockCall = {
        id: "call-123",
        state: "active",
        remoteStream: { getAudioTracks: () => [{ kind: "audio" }] },
        answer: vi.fn(),
        hangup: vi.fn(),
        dtmf: vi.fn(),
      };
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("creates AudioContext at 16kHz when call becomes active", () => {
      notificationHandler({ type: "callUpdate", call: mockCall });
      expect(AudioContext).toHaveBeenCalledWith({ sampleRate: 16000 });
    });

    it("creates MediaStreamSource from call.remoteStream", async () => {
      notificationHandler({ type: "callUpdate", call: mockCall });
      await vi.waitFor(() => {
        expect(mockAudioContext.createMediaStreamSource).toHaveBeenCalledWith(mockCall.remoteStream);
      });
    });

    it("loads the PCM capture AudioWorklet processor", () => {
      notificationHandler({ type: "callUpdate", call: mockCall });
      expect(mockAudioContext.audioWorklet.addModule).toHaveBeenCalled();
    });

    it("calls onAudioData with Int16 PCM when worklet posts audio", async () => {
      const audioDataSpy = vi.fn();
      bridge.onAudioData = audioDataSpy;

      notificationHandler({ type: "callUpdate", call: mockCall });

      await vi.waitFor(() => {
        expect(workletMessageHandler).not.toBeNull();
      });

      const frame = new Float32Array([0.5, -0.5, 0.0, 1.0]);
      workletMessageHandler!({ data: frame } as MessageEvent);

      expect(audioDataSpy).toHaveBeenCalledTimes(1);
      const pcm = audioDataSpy.mock.calls[0][0];
      expect(pcm).toBeInstanceOf(ArrayBuffer);
      const int16View = new Int16Array(pcm);
      expect(int16View.length).toBe(4);
    });

    it("calls onAudioLevel with RMS value when worklet posts audio", async () => {
      const audioLevelSpy = vi.fn();
      bridge.onAudioLevel = audioLevelSpy;

      notificationHandler({ type: "callUpdate", call: mockCall });

      await vi.waitFor(() => {
        expect(workletMessageHandler).not.toBeNull();
      });

      const frame = new Float32Array([0.5, -0.5, 0.5, -0.5]);
      workletMessageHandler!({ data: frame } as MessageEvent);

      expect(audioLevelSpy).toHaveBeenCalledTimes(1);
      expect(audioLevelSpy.mock.calls[0][0]).toBeCloseTo(0.5, 1);
    });
  });

  describe("audio playback", () => {
    let bridge: TelnyxCallBridge;
    let notificationHandler: (notification: any) => void;
    let mockCall: any;

    const mockPlaybackWorkletNode = {
      port: {
        onmessage: null,
        postMessage: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };

    const mockDestinationNode = {
      stream: {
        getAudioTracks: () => [{ kind: "audio", id: "mock-track" }],
      },
    };

    const mockSender = {
      track: { kind: "audio" },
      replaceTrack: vi.fn().mockResolvedValue(undefined),
    };

    beforeEach(async () => {
      vi.clearAllMocks();

      // AudioContext mock returns different objects based on sampleRate
      vi.stubGlobal("AudioContext", vi.fn((opts: any) => {
        if (opts?.sampleRate === 16000) {
          return {
            audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
            createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
            close: vi.fn(),
            sampleRate: 16000,
          };
        }
        // 48kHz playback context
        return {
          audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
          createMediaStreamDestination: vi.fn(() => mockDestinationNode),
          close: vi.fn(),
          sampleRate: 48000,
        };
      }));

      vi.stubGlobal("AudioWorkletNode", vi.fn(() => mockPlaybackWorkletNode));
      vi.stubGlobal("URL", {
        createObjectURL: vi.fn(() => "blob:mock-url"),
        revokeObjectURL: vi.fn(),
      });
      vi.stubGlobal("Blob", vi.fn());

      const { __mockClient } = await import("@telnyx/webrtc") as any;
      const handlers: Record<string, Function> = {};
      __mockClient.on.mockImplementation((event: string, cb: Function) => {
        handlers[event] = cb;
      });

      bridge = new TelnyxCallBridge({ loginToken: "jwt", autoAnswer: true });
      const startPromise = bridge.start();
      handlers["telnyx.ready"]();
      await startPromise;
      notificationHandler = handlers["telnyx.notification"];

      mockCall = {
        id: "call-123",
        state: "active",
        remoteStream: { getAudioTracks: () => [{ kind: "audio" }] },
        peer: {
          instance: {
            getSenders: vi.fn(() => [mockSender]),
          },
        },
        answer: vi.fn(),
        hangup: vi.fn(),
        dtmf: vi.fn(),
      };
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("playAudio sends PCM data to the playback worklet", async () => {
      notificationHandler({ type: "callUpdate", call: mockCall });

      // Wait for async playback setup
      await vi.waitFor(() => {
        expect(mockPlaybackWorkletNode.connect).toHaveBeenCalled();
      });

      const pcm = new Int16Array([100, -100, 200, -200]).buffer;
      bridge.playAudio(pcm);

      expect(mockPlaybackWorkletNode.port.postMessage).toHaveBeenCalled();
    });

    it("playAudio replaces the sender track on the peer connection", async () => {
      notificationHandler({ type: "callUpdate", call: mockCall });

      await vi.waitFor(() => {
        expect(mockSender.replaceTrack).toHaveBeenCalled();
      });
    });

    it("playAudio is a no-op when no active call", () => {
      const pcm = new Int16Array([100]).buffer;
      expect(() => bridge.playAudio(pcm)).not.toThrow();
    });
  });
});
