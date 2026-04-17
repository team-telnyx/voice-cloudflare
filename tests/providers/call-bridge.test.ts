import { describe, it, expect, vi, beforeEach } from "vitest";
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
});
