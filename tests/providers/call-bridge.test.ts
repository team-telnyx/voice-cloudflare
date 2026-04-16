import { describe, it, expect } from "vitest";
import { TelnyxCallBridge } from "../../src/providers/call-bridge.js";

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
});
