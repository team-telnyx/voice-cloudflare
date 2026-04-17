import { describe, it, expect } from "vitest";
import { TelnyxClient } from "../src/client.js";

describe("TelnyxClient", () => {
  it("uses default URLs when none provided", () => {
    const client = new TelnyxClient({ apiKey: "test-key" });
    expect(client.apiKey).toBe("test-key");
    expect(client.baseUrl).toBe("https://api.telnyx.com/v2");
    expect(client.wsUrl).toBe("wss://api.telnyx.com/v2/stream");
  });

  it("allows overriding URLs", () => {
    const client = new TelnyxClient({
      apiKey: "test-key",
      baseUrl: "http://localhost:8080",
      wsUrl: "ws://localhost:8080/stream",
    });
    expect(client.baseUrl).toBe("http://localhost:8080");
    expect(client.wsUrl).toBe("ws://localhost:8080/stream");
  });
});
