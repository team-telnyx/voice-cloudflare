# TelnyxCallBridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `TelnyxCallBridge` — a `VoiceAudioInput` implementation that bridges Telnyx phone calls (PSTN via WebRTC) into the Cloudflare voice pipeline, enabling AI agents to talk to real phone callers.

**Architecture:** The bridge connects to the Telnyx platform via `@telnyx/webrtc` (JWT auth), extracts PCM audio from inbound phone calls via Web Audio API (`AudioWorkletNode`), feeds it to the Cloudflare pipeline through `onAudioData`, and injects response audio back into the phone call by replacing the WebRTC sender track. The default `WebSocketVoiceTransport` is kept for browser-Worker communication.

**Tech Stack:** TypeScript, `@telnyx/webrtc` (browser WebRTC SDK), `@cloudflare/voice` (provider interfaces), Web Audio API (`AudioContext`, `AudioWorkletNode`, `MediaStreamAudioDestinationNode`), Vitest (testing)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/audio/utils.ts` | Pure audio utility functions: Float32→Int16 conversion, RMS computation, AudioWorklet processor source strings |
| `src/providers/call-bridge.ts` | `TelnyxCallBridge` class implementing `VoiceAudioInput` — Telnyx SDK lifecycle, audio capture, audio injection, call actions |
| `src/index.ts` | Updated barrel exports (add `TelnyxCallBridge`, `TelnyxCallBridgeConfig`) |
| `src/providers/transport.ts` | Remove old stub (unreleased, no consumers) |
| `tests/audio/utils.test.ts` | Unit tests for audio utilities |
| `tests/providers/call-bridge.test.ts` | Unit tests for TelnyxCallBridge (mocked browser APIs + SDK) |

---

## Task 1: Audio Utility Functions

Pure functions for audio format conversion. No browser dependencies — fully testable in Node.

**Files:**
- Create: `src/audio/utils.ts`
- Create: `tests/audio/utils.test.ts`

- [ ] **Step 1: Write failing tests for audio utilities**

```typescript
// tests/audio/utils.test.ts
import { describe, it, expect } from "vitest";
import { float32ToInt16, computeRMS } from "../src/audio/utils.js";

describe("float32ToInt16", () => {
  it("converts silence (zeros) to zero Int16 samples", () => {
    const input = new Float32Array([0, 0, 0, 0]);
    const result = float32ToInt16(input);
    expect(result).toBeInstanceOf(Int16Array);
    expect(result.length).toBe(4);
    expect(Array.from(result)).toEqual([0, 0, 0, 0]);
  });

  it("converts full-scale positive to 32767", () => {
    const input = new Float32Array([1.0]);
    const result = float32ToInt16(input);
    expect(result[0]).toBe(32767);
  });

  it("converts full-scale negative to -32768", () => {
    const input = new Float32Array([-1.0]);
    const result = float32ToInt16(input);
    expect(result[0]).toBe(-32768);
  });

  it("clamps values beyond -1..1 range", () => {
    const input = new Float32Array([1.5, -1.5]);
    const result = float32ToInt16(input);
    expect(result[0]).toBe(32767);
    expect(result[1]).toBe(-32768);
  });

  it("converts a mid-range value correctly", () => {
    const input = new Float32Array([0.5]);
    const result = float32ToInt16(input);
    // 0.5 * 32767 = 16383.5, truncated to 16383
    expect(result[0]).toBe(16383);
  });
});

describe("computeRMS", () => {
  it("returns 0 for silence", () => {
    const input = new Float32Array([0, 0, 0, 0]);
    expect(computeRMS(input)).toBe(0);
  });

  it("returns 1 for full-scale DC signal", () => {
    const input = new Float32Array([1, 1, 1, 1]);
    expect(computeRMS(input)).toBeCloseTo(1.0, 5);
  });

  it("computes RMS for a known signal", () => {
    // RMS of [0.5, -0.5, 0.5, -0.5] = sqrt(mean(0.25)) = 0.5
    const input = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    expect(computeRMS(input)).toBeCloseTo(0.5, 5);
  });

  it("returns 0 for empty array", () => {
    const input = new Float32Array([]);
    expect(computeRMS(input)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/audio/utils.test.ts`
Expected: FAIL — module `../src/audio/utils.js` does not exist

- [ ] **Step 3: Implement audio utilities**

```typescript
// src/audio/utils.ts

/**
 * Convert Float32 audio samples (-1.0..1.0) to Int16 PCM (-32768..32767).
 * Clamps values outside the -1..1 range.
 */
export function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
  }
  return int16;
}

/**
 * Compute the Root Mean Square (RMS) of audio samples.
 * Returns 0 for empty input.
 */
export function computeRMS(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * AudioWorklet processor source code for capturing PCM from a MediaStream.
 *
 * This processor collects Float32 audio frames and posts them to the
 * main thread via the MessagePort. It runs in the AudioWorklet thread.
 *
 * Expected AudioContext sampleRate: 16000 (browser resamples from source).
 */
export const PCM_CAPTURE_PROCESSOR_SOURCE = /* js */ `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      // Post a copy of the Float32 channel data to the main thread
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}
registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
`;

/**
 * AudioWorklet processor source code for playing back PCM into a MediaStream.
 *
 * Receives Float32 audio frames from the main thread via MessagePort
 * and writes them to the output buffer. Buffers frames to handle timing
 * differences between the main thread and the audio thread.
 *
 * Expected AudioContext sampleRate: 48000 (matching WebRTC).
 */
export const PCM_PLAYBACK_PROCESSOR_SOURCE = /* js */ `
class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this.port.onmessage = (e) => {
      this._buffer.push(e.data);
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const channel = output[0];
    let written = 0;

    while (written < channel.length && this._buffer.length > 0) {
      const frame = this._buffer[0];
      const available = frame.length;
      const needed = channel.length - written;

      if (available <= needed) {
        channel.set(frame, written);
        written += available;
        this._buffer.shift();
      } else {
        channel.set(frame.subarray(0, needed), written);
        this._buffer[0] = frame.subarray(needed);
        written += needed;
      }
    }

    // Fill remainder with silence
    for (let i = written; i < channel.length; i++) {
      channel[i] = 0;
    }

    return true;
  }
}
registerProcessor("pcm-playback-processor", PcmPlaybackProcessor);
`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/audio/utils.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas
git add src/audio/utils.ts tests/audio/utils.test.ts
git commit -m "feat(audio): add PCM conversion utilities and AudioWorklet processor sources"
```

---

## Task 2: TelnyxCallBridge Skeleton + Config

Create the class with config handling and `VoiceAudioInput` interface shape. No SDK interaction yet.

**Files:**
- Create: `src/providers/call-bridge.ts`
- Create: `tests/providers/call-bridge.test.ts`

- [ ] **Step 1: Write failing tests for config and interface shape**

```typescript
// tests/providers/call-bridge.test.ts
import { describe, it, expect } from "vitest";
import { TelnyxCallBridge } from "../src/providers/call-bridge.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/providers/call-bridge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement TelnyxCallBridge skeleton**

```typescript
// src/providers/call-bridge.ts
import type { VoiceAudioInput } from "@cloudflare/voice/client";

/**
 * Configuration for the TelnyxCallBridge.
 *
 * Uses JWT authentication (browser-side). The JWT is generated
 * server-side from a Telnyx API key + credential connection.
 */
export interface TelnyxCallBridgeConfig {
  /** JWT token from the Telnyx telephony credentials API. */
  loginToken: string;
  /** Automatically answer inbound calls. @default false */
  autoAnswer?: boolean;
  /** Enable debug logging. @default false */
  debug?: boolean;
}

/**
 * Bridges Telnyx phone calls into the Cloudflare voice pipeline.
 *
 * Implements `VoiceAudioInput` from @cloudflare/voice — extracts PCM
 * audio from inbound phone calls and feeds it to the AI pipeline.
 * Also provides `playAudio()` for injecting response audio back
 * into the phone call.
 *
 * Usage:
 * ```typescript
 * const bridge = new TelnyxCallBridge({ loginToken: jwt });
 * const voiceClient = new VoiceClient({
 *   agent: "my-agent",
 *   audioInput: bridge,
 * });
 * ```
 */
export class TelnyxCallBridge implements VoiceAudioInput {
  // VoiceAudioInput callbacks — set by VoiceClient before start()
  onAudioLevel: ((rms: number) => void) | null = null;
  onAudioData?: ((pcm: ArrayBuffer) => void) | null = null;

  private readonly config: Required<
    Pick<TelnyxCallBridgeConfig, "loginToken">
  > &
    TelnyxCallBridgeConfig;
  private _connected = false;
  private _activeCall: unknown | null = null;

  constructor(config: TelnyxCallBridgeConfig) {
    this.config = config;
  }

  /** Whether the Telnyx client is connected to the platform. */
  get connected(): boolean {
    return this._connected;
  }

  /** The currently active Telnyx call, or null. */
  get activeCall(): unknown | null {
    return this._activeCall;
  }

  /** Connect to Telnyx and start listening for calls. */
  async start(): Promise<void> {
    // Implemented in Task 3
    throw new Error("Not implemented");
  }

  /** Disconnect from Telnyx and clean up all resources. */
  stop(): void {
    // Implemented in Task 3
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/providers/call-bridge.test.ts`
Expected: All 5 tests PASS (start() is not called in these tests)

- [ ] **Step 5: Commit**

```bash
cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas
git add src/providers/call-bridge.ts tests/providers/call-bridge.test.ts
git commit -m "feat(call-bridge): add TelnyxCallBridge skeleton implementing VoiceAudioInput"
```

---

## Task 3: Telnyx Client Connection Lifecycle (start/stop)

Wire up `TelnyxRTC` from `@telnyx/webrtc` for connect/disconnect. This task adds the SDK dependency and mocks it in tests.

**Files:**
- Modify: `package.json` (add `@telnyx/webrtc` dependency)
- Modify: `src/providers/call-bridge.ts`
- Modify: `tests/providers/call-bridge.test.ts`

- [ ] **Step 1: Add @telnyx/webrtc dependency**

```bash
cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas
npm install @telnyx/webrtc
```

- [ ] **Step 2: Write failing tests for start/stop lifecycle**

Add to `tests/providers/call-bridge.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelnyxCallBridge } from "../src/providers/call-bridge.js";

// Mock @telnyx/webrtc
vi.mock("@telnyx/webrtc", () => {
  const mockClient = {
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    TelnyxRTC: vi.fn(() => mockClient),
  };
});

// ... existing config tests ...

describe("TelnyxCallBridge", () => {
  // ... existing describe blocks ...

  describe("connection lifecycle", () => {
    let bridge: TelnyxCallBridge;

    beforeEach(() => {
      vi.clearAllMocks();
      bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });
    });

    it("start() creates TelnyxRTC client and connects", async () => {
      const { TelnyxRTC } = await import("@telnyx/webrtc");
      await bridge.start();

      expect(TelnyxRTC).toHaveBeenCalledWith(
        expect.objectContaining({ login_token: "test-jwt" })
      );
    });

    it("start() resolves when telnyx.ready fires", async () => {
      const { TelnyxRTC } = await import("@telnyx/webrtc");
      const mockInstance = (TelnyxRTC as any)();

      // Make .on() trigger the ready callback immediately for 'telnyx.ready'
      mockInstance.on.mockImplementation((event: string, cb: Function) => {
        if (event === "telnyx.ready") cb();
      });

      // Re-create bridge so it uses the fresh mock
      vi.clearAllMocks();
      mockInstance.on.mockImplementation((event: string, cb: Function) => {
        if (event === "telnyx.ready") cb();
      });

      bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });
      await bridge.start();
      expect(bridge.connected).toBe(true);
    });

    it("stop() disconnects the client", async () => {
      const { TelnyxRTC } = await import("@telnyx/webrtc");
      const mockInstance = (TelnyxRTC as any)();
      mockInstance.on.mockImplementation((event: string, cb: Function) => {
        if (event === "telnyx.ready") cb();
      });

      bridge = new TelnyxCallBridge({ loginToken: "test-jwt" });
      await bridge.start();
      bridge.stop();

      expect(bridge.connected).toBe(false);
      expect(mockInstance.disconnect).toHaveBeenCalled();
    });

    it("stop() is safe to call without start()", () => {
      expect(() => bridge.stop()).not.toThrow();
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/providers/call-bridge.test.ts`
Expected: FAIL — start() throws "Not implemented"

- [ ] **Step 4: Implement start() and stop()**

Update `src/providers/call-bridge.ts`:

```typescript
// src/providers/call-bridge.ts
import type { VoiceAudioInput } from "@cloudflare/voice/client";
import { TelnyxRTC } from "@telnyx/webrtc";

export interface TelnyxCallBridgeConfig {
  /** JWT token from the Telnyx telephony credentials API. */
  loginToken: string;
  /** Automatically answer inbound calls. @default false */
  autoAnswer?: boolean;
  /** Enable debug logging. @default false */
  debug?: boolean;
}

export class TelnyxCallBridge implements VoiceAudioInput {
  onAudioLevel: ((rms: number) => void) | null = null;
  onAudioData?: ((pcm: ArrayBuffer) => void) | null = null;

  private readonly config: TelnyxCallBridgeConfig;
  private _connected = false;
  private _activeCall: unknown | null = null;
  private client: TelnyxRTC | null = null;

  constructor(config: TelnyxCallBridgeConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  get activeCall(): unknown | null {
    return this._activeCall;
  }

  async start(): Promise<void> {
    this.client = new TelnyxRTC({
      login_token: this.config.loginToken,
      debug: this.config.debug,
    });

    return new Promise<void>((resolve, reject) => {
      this.client!.on("telnyx.ready", () => {
        this._connected = true;
        resolve();
      });

      this.client!.on("telnyx.error", (error: unknown) => {
        reject(error);
      });

      this.client!.on("telnyx.notification", (notification: any) => {
        this.handleNotification(notification);
      });

      this.client!.connect();
    });
  }

  stop(): void {
    this._activeCall = null;
    this._connected = false;

    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

  private handleNotification(notification: any): void {
    // Implemented in Task 4
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/providers/call-bridge.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas
git add package.json package-lock.json src/providers/call-bridge.ts tests/providers/call-bridge.test.ts
git commit -m "feat(call-bridge): implement start/stop lifecycle with TelnyxRTC client"
```

---

## Task 4: Inbound Call Handling + Notification State Machine

Handle `telnyx.notification` events to track call state transitions. Auto-answer support.

**Files:**
- Modify: `src/providers/call-bridge.ts`
- Modify: `tests/providers/call-bridge.test.ts`

- [ ] **Step 1: Write failing tests for call notification handling**

Add to `tests/providers/call-bridge.test.ts`:

```typescript
describe("inbound call handling", () => {
  let bridge: TelnyxCallBridge;
  let notificationHandler: (notification: any) => void;
  let mockCall: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    const { TelnyxRTC } = await import("@telnyx/webrtc");
    const handlers: Record<string, Function> = {};
    const mockClient = {
      on: vi.fn((event: string, cb: Function) => {
        handlers[event] = cb;
      }),
      off: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    (TelnyxRTC as any).mockImplementation(() => mockClient);

    bridge = new TelnyxCallBridge({ loginToken: "jwt", autoAnswer: true });

    // Capture the ready handler and notification handler
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
    // Manually trigger notification without full start flow
    // Access the private handler for testing
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/providers/call-bridge.test.ts`
Expected: FAIL — activeCall not set, answer not called

- [ ] **Step 3: Implement handleNotification**

Update `handleNotification` in `src/providers/call-bridge.ts`:

```typescript
private handleNotification(notification: any): void {
  if (notification.type !== "callUpdate" || !notification.call) return;

  const call = notification.call;

  switch (call.state) {
    case "ringing":
      this._activeCall = call;
      if (this.config.autoAnswer) {
        call.answer();
      }
      break;

    case "active":
      this._activeCall = call;
      this.startAudioCapture(call);
      break;

    case "hangup":
    case "destroy":
    case "purge":
      this.stopAudioCapture();
      this._activeCall = null;
      break;
  }
}

private startAudioCapture(_call: any): void {
  // Implemented in Task 5
}

private stopAudioCapture(): void {
  // Implemented in Task 5
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/providers/call-bridge.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas
git add src/providers/call-bridge.ts tests/providers/call-bridge.test.ts
git commit -m "feat(call-bridge): handle inbound call notifications with auto-answer"
```

---

## Task 5: PCM Audio Capture (Phone -> Pipeline)

Extract PCM from `call.remoteStream` via AudioContext + AudioWorkletNode, convert to 16kHz mono Int16 PCM, and feed to `onAudioData`/`onAudioLevel`.

**Files:**
- Modify: `src/providers/call-bridge.ts`
- Modify: `tests/providers/call-bridge.test.ts`

**Key references:**
- `call.remoteStream` is a standard `MediaStream` from `RTCPeerConnection` (set via `RTCTrackEvent` in Peer.ts:224-239)
- Creating `AudioContext({ sampleRate: 16000 })` makes the browser automatically resample from the source's native rate (48kHz) to 16kHz
- `AudioWorkletNode` runs `PcmCaptureProcessor` which posts Float32 frames to the main thread

- [ ] **Step 1: Write failing tests for audio capture**

Add to `tests/providers/call-bridge.test.ts`:

```typescript
describe("audio capture", () => {
  let bridge: TelnyxCallBridge;
  let notificationHandler: (notification: any) => void;
  let mockCall: any;
  let workletMessageHandler: ((event: MessageEvent) => void) | null;

  // Mock browser audio APIs globally for these tests
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

    // Reset worklet message handler capture
    workletMessageHandler = null;
    Object.defineProperty(mockWorkletNode.port, "onmessage", {
      get: () => workletMessageHandler,
      set: (handler) => {
        workletMessageHandler = handler;
      },
      configurable: true,
    });

    // Mock globals
    vi.stubGlobal("AudioContext", vi.fn(() => mockAudioContext));
    vi.stubGlobal(
      "AudioWorkletNode",
      vi.fn(() => mockWorkletNode)
    );
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:mock-url"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("Blob", vi.fn());

    const { TelnyxRTC } = await import("@telnyx/webrtc");
    const handlers: Record<string, Function> = {};
    const mockClient = {
      on: vi.fn((event: string, cb: Function) => {
        handlers[event] = cb;
      }),
      off: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    (TelnyxRTC as any).mockImplementation(() => mockClient);

    bridge = new TelnyxCallBridge({ loginToken: "jwt", autoAnswer: true });
    const startPromise = bridge.start();
    handlers["telnyx.ready"]();
    await startPromise;

    notificationHandler = handlers["telnyx.notification"];

    mockCall = {
      id: "call-123",
      state: "active",
      remoteStream: new MediaStream(),
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

  it("creates MediaStreamSource from call.remoteStream", () => {
    notificationHandler({ type: "callUpdate", call: mockCall });

    expect(mockAudioContext.createMediaStreamSource).toHaveBeenCalledWith(
      mockCall.remoteStream
    );
  });

  it("loads the PCM capture AudioWorklet processor", () => {
    notificationHandler({ type: "callUpdate", call: mockCall });

    expect(mockAudioContext.audioWorklet.addModule).toHaveBeenCalled();
  });

  it("calls onAudioData with Int16 PCM when worklet posts audio", async () => {
    const audioDataSpy = vi.fn();
    bridge.onAudioData = audioDataSpy;

    notificationHandler({ type: "callUpdate", call: mockCall });

    // Wait for async worklet setup
    await vi.waitFor(() => {
      expect(workletMessageHandler).not.toBeNull();
    });

    // Simulate worklet posting a Float32 frame
    const frame = new Float32Array([0.5, -0.5, 0.0, 1.0]);
    workletMessageHandler!({ data: frame } as MessageEvent);

    expect(audioDataSpy).toHaveBeenCalledTimes(1);
    const pcm = audioDataSpy.mock.calls[0][0];
    expect(pcm).toBeInstanceOf(ArrayBuffer);
    // Int16Array from the ArrayBuffer should have 4 samples
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/providers/call-bridge.test.ts`
Expected: FAIL — AudioContext not created, onAudioData not called

- [ ] **Step 3: Implement startAudioCapture and stopAudioCapture**

Update `src/providers/call-bridge.ts`:

```typescript
import { float32ToInt16, computeRMS, PCM_CAPTURE_PROCESSOR_SOURCE } from "../audio/utils.js";

// Add to class properties:
private captureContext: AudioContext | null = null;
private captureSource: MediaStreamAudioSourceNode | null = null;
private captureWorklet: AudioWorkletNode | null = null;
private captureBlobUrl: string | null = null;

// Replace startAudioCapture:
private async startAudioCapture(call: any): Promise<void> {
  const remoteStream = call.remoteStream;
  if (!remoteStream) return;

  // Create AudioContext at 16kHz — browser resamples from 48kHz automatically
  this.captureContext = new AudioContext({ sampleRate: 16000 });

  // Load the worklet processor from a Blob URL
  const blob = new Blob([PCM_CAPTURE_PROCESSOR_SOURCE], {
    type: "application/javascript",
  });
  this.captureBlobUrl = URL.createObjectURL(blob);
  await this.captureContext.audioWorklet.addModule(this.captureBlobUrl);

  // Create source → worklet pipeline
  this.captureSource = this.captureContext.createMediaStreamSource(remoteStream);
  this.captureWorklet = new AudioWorkletNode(
    this.captureContext,
    "pcm-capture-processor"
  );

  // Handle PCM frames from the worklet
  this.captureWorklet.port.onmessage = (event: MessageEvent) => {
    const float32: Float32Array = event.data;

    // Report RMS level for silence/interrupt detection
    const rms = computeRMS(float32);
    this.onAudioLevel?.(rms);

    // Convert to Int16 PCM and send to pipeline
    const int16 = float32ToInt16(float32);
    this.onAudioData?.(int16.buffer);
  };

  this.captureSource.connect(this.captureWorklet);
}

// Replace stopAudioCapture:
private stopAudioCapture(): void {
  if (this.captureWorklet) {
    this.captureWorklet.disconnect();
    this.captureWorklet = null;
  }
  if (this.captureSource) {
    this.captureSource.disconnect();
    this.captureSource = null;
  }
  if (this.captureContext) {
    this.captureContext.close();
    this.captureContext = null;
  }
  if (this.captureBlobUrl) {
    URL.revokeObjectURL(this.captureBlobUrl);
    this.captureBlobUrl = null;
  }
}
```

Also update `stop()` to call `stopAudioCapture()`:

```typescript
stop(): void {
  this.stopAudioCapture();
  this._activeCall = null;
  this._connected = false;

  if (this.client) {
    this.client.disconnect();
    this.client = null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/providers/call-bridge.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas
git add src/providers/call-bridge.ts tests/providers/call-bridge.test.ts
git commit -m "feat(call-bridge): implement PCM capture from phone call remoteStream"
```

---

## Task 6: Audio Playback Injection (Pipeline -> Phone)

Receive PCM from the Cloudflare pipeline and inject it into the Telnyx call by replacing the WebRTC sender audio track.

**Files:**
- Modify: `src/providers/call-bridge.ts`
- Modify: `tests/providers/call-bridge.test.ts`

**Key references:**
- `call.peer.instance` is the `RTCPeerConnection` (Peer.ts:53, public property)
- `call.peer.instance.getSenders()` returns `RTCRtpSender[]`
- `sender.replaceTrack(track)` replaces the audio track (BaseCall.ts:786-818 pattern)
- Playback AudioContext runs at 48kHz to match WebRTC
- Input is 16kHz Int16 PCM → needs upsampling to 48kHz Float32

- [ ] **Step 1: Write failing tests for audio playback**

Add to `tests/providers/call-bridge.test.ts`:

```typescript
describe("audio playback", () => {
  let bridge: TelnyxCallBridge;
  let notificationHandler: (notification: any) => void;
  let mockCall: any;
  let playbackWorkletMessageHandler: ((event: MessageEvent) => void) | null;

  const mockPlaybackWorkletNode = {
    port: {
      onmessage: null,
      postMessage: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const mockDestinationNode = {
    stream: new MediaStream(),
  };

  const mockPlaybackContext = {
    audioWorklet: {
      addModule: vi.fn().mockResolvedValue(undefined),
    },
    createMediaStreamDestination: vi.fn(() => mockDestinationNode),
    createMediaStreamSource: vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    close: vi.fn(),
    sampleRate: 48000,
  };

  const mockSender = {
    track: { kind: "audio" },
    replaceTrack: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    vi.stubGlobal("AudioContext", vi.fn((opts: any) => {
      if (opts?.sampleRate === 16000) {
        return {
          audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
          createMediaStreamSource: vi.fn(() => ({
            connect: vi.fn(),
            disconnect: vi.fn(),
          })),
          close: vi.fn(),
          sampleRate: 16000,
        };
      }
      return mockPlaybackContext;
    }));
    vi.stubGlobal("AudioWorkletNode", vi.fn(() => mockPlaybackWorkletNode));
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:mock-url"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("Blob", vi.fn());

    const { TelnyxRTC } = await import("@telnyx/webrtc");
    const handlers: Record<string, Function> = {};
    const mockClient = {
      on: vi.fn((event: string, cb: Function) => {
        handlers[event] = cb;
      }),
      off: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    (TelnyxRTC as any).mockImplementation(() => mockClient);

    bridge = new TelnyxCallBridge({ loginToken: "jwt", autoAnswer: true });
    const startPromise = bridge.start();
    handlers["telnyx.ready"]();
    await startPromise;

    notificationHandler = handlers["telnyx.notification"];

    mockCall = {
      id: "call-123",
      state: "active",
      remoteStream: new MediaStream(),
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
    // Activate call to set up playback pipeline
    notificationHandler({ type: "callUpdate", call: mockCall });

    // Wait for async setup
    await vi.waitFor(() => {
      expect(mockPlaybackWorkletNode.port.postMessage).toBeDefined();
    });

    const pcm = new Int16Array([100, -100, 200, -200]).buffer;
    bridge.playAudio(pcm);

    expect(mockPlaybackWorkletNode.port.postMessage).toHaveBeenCalled();
  });

  it("playAudio replaces the sender track on the peer connection", async () => {
    notificationHandler({ type: "callUpdate", call: mockCall });

    // Wait for async setup which calls replaceTrack
    await vi.waitFor(() => {
      expect(mockSender.replaceTrack).toHaveBeenCalled();
    });
  });

  it("playAudio is a no-op when no active call", () => {
    const pcm = new Int16Array([100]).buffer;
    expect(() => bridge.playAudio(pcm)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/providers/call-bridge.test.ts`
Expected: FAIL — playAudio method does not exist

- [ ] **Step 3: Implement playAudio and playback pipeline**

Add to `src/providers/call-bridge.ts`:

```typescript
import {
  float32ToInt16,
  computeRMS,
  PCM_CAPTURE_PROCESSOR_SOURCE,
  PCM_PLAYBACK_PROCESSOR_SOURCE,
} from "../audio/utils.js";

// Add to class properties:
private playbackContext: AudioContext | null = null;
private playbackWorklet: AudioWorkletNode | null = null;
private playbackBlobUrl: string | null = null;

// Add public method:

/**
 * Inject PCM audio into the active phone call (agent → caller).
 *
 * Accepts 16kHz mono Int16 PCM (same format as Cloudflare pipeline output).
 * The audio is upsampled to 48kHz and fed into the WebRTC peer connection.
 *
 * No-op if no active call.
 */
playAudio(pcm: ArrayBuffer): void {
  if (!this.playbackWorklet) return;

  // Convert Int16 PCM to Float32 for the AudioWorklet
  const int16 = new Int16Array(pcm);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }

  this.playbackWorklet.port.postMessage(float32);
}

// Add private methods:

private async startAudioPlayback(call: any): Promise<void> {
  const peerConnection = call.peer?.instance as RTCPeerConnection | undefined;
  if (!peerConnection) return;

  // Create AudioContext at 48kHz to match WebRTC
  this.playbackContext = new AudioContext({ sampleRate: 48000 });

  // Load the playback worklet processor
  const blob = new Blob([PCM_PLAYBACK_PROCESSOR_SOURCE], {
    type: "application/javascript",
  });
  this.playbackBlobUrl = URL.createObjectURL(blob);
  await this.playbackContext.audioWorklet.addModule(this.playbackBlobUrl);

  // Create worklet → destination pipeline
  this.playbackWorklet = new AudioWorkletNode(
    this.playbackContext,
    "pcm-playback-processor"
  );

  const destination = this.playbackContext.createMediaStreamDestination();
  this.playbackWorklet.connect(destination);

  // Replace the audio sender track with our virtual stream
  const audioTrack = destination.stream.getAudioTracks()[0];
  if (audioTrack) {
    const sender = peerConnection
      .getSenders()
      .find((s: RTCRtpSender) => s.track?.kind === "audio");
    if (sender) {
      await sender.replaceTrack(audioTrack);
    }
  }
}

private stopAudioPlayback(): void {
  if (this.playbackWorklet) {
    this.playbackWorklet.disconnect();
    this.playbackWorklet = null;
  }
  if (this.playbackContext) {
    this.playbackContext.close();
    this.playbackContext = null;
  }
  if (this.playbackBlobUrl) {
    URL.revokeObjectURL(this.playbackBlobUrl);
    this.playbackBlobUrl = null;
  }
}
```

Update the `"active"` case in `handleNotification`:

```typescript
case "active":
  this._activeCall = call;
  this.startAudioCapture(call);
  this.startAudioPlayback(call);
  break;
```

Update `stop()` and the hangup/destroy/purge cases in `handleNotification` to also call `stopAudioPlayback()`:

```typescript
// In stop():
stop(): void {
  this.stopAudioCapture();
  this.stopAudioPlayback();
  this._activeCall = null;
  this._connected = false;

  if (this.client) {
    this.client.disconnect();
    this.client = null;
  }
}

// In handleNotification, hangup/destroy/purge case:
case "hangup":
case "destroy":
case "purge":
  this.stopAudioCapture();
  this.stopAudioPlayback();
  this._activeCall = null;
  break;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/providers/call-bridge.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas
git add src/providers/call-bridge.ts tests/providers/call-bridge.test.ts
git commit -m "feat(call-bridge): implement audio playback injection into phone call"
```

---

## Task 7: Call Actions (answer, dial, hangup, DTMF)

Expose call lifecycle methods that delegate to the Telnyx SDK.

**Files:**
- Modify: `src/providers/call-bridge.ts`
- Modify: `tests/providers/call-bridge.test.ts`

- [ ] **Step 1: Write failing tests for call actions**

Add to `tests/providers/call-bridge.test.ts`:

```typescript
describe("call actions", () => {
  let bridge: TelnyxCallBridge;
  let notificationHandler: (notification: any) => void;
  let mockClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Stub browser globals
    vi.stubGlobal("AudioContext", vi.fn(() => ({
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
      createMediaStreamSource: vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
      createMediaStreamDestination: vi.fn(() => ({
        stream: new MediaStream(),
      })),
      close: vi.fn(),
      sampleRate: 16000,
    })));
    vi.stubGlobal("AudioWorkletNode", vi.fn(() => ({
      port: { onmessage: null, postMessage: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    })));
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("Blob", vi.fn());

    const { TelnyxRTC } = await import("@telnyx/webrtc");
    const handlers: Record<string, Function> = {};
    const mockNewCall = vi.fn(() => ({
      id: "outbound-1",
      state: "trying",
      peer: { instance: { getSenders: vi.fn(() => []) } },
      remoteStream: null,
      answer: vi.fn(),
      hangup: vi.fn(),
      dtmf: vi.fn(),
    }));

    mockClient = {
      on: vi.fn((event: string, cb: Function) => {
        handlers[event] = cb;
      }),
      off: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      newCall: mockNewCall,
    };
    (TelnyxRTC as any).mockImplementation(() => mockClient);

    bridge = new TelnyxCallBridge({ loginToken: "jwt" });
    const startPromise = bridge.start();
    handlers["telnyx.ready"]();
    await startPromise;

    notificationHandler = handlers["telnyx.notification"];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answer() answers the active inbound call", () => {
    const mockCall = {
      id: "call-1",
      state: "ringing",
      answer: vi.fn(),
      hangup: vi.fn(),
      remoteStream: null,
    };
    notificationHandler({ type: "callUpdate", call: mockCall });
    bridge.answer();
    expect(mockCall.answer).toHaveBeenCalled();
  });

  it("answer() throws when no active call", () => {
    expect(() => bridge.answer()).toThrow("No active call");
  });

  it("hangup() ends the active call", () => {
    const mockCall = {
      id: "call-1",
      state: "ringing",
      answer: vi.fn(),
      hangup: vi.fn(),
      remoteStream: null,
    };
    notificationHandler({ type: "callUpdate", call: mockCall });
    bridge.hangup();
    expect(mockCall.hangup).toHaveBeenCalled();
  });

  it("dial() initiates an outbound call", () => {
    const call = bridge.dial("+18005551234", "+15551234567");
    expect(mockClient.newCall).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationNumber: "+18005551234",
        callerNumber: "+15551234567",
      })
    );
    expect(call).toBeDefined();
  });

  it("sendDTMF() sends digits to the active call", () => {
    const mockCall = {
      id: "call-1",
      state: "active",
      remoteStream: new MediaStream(),
      peer: { instance: { getSenders: vi.fn(() => []) } },
      answer: vi.fn(),
      hangup: vi.fn(),
      dtmf: vi.fn(),
    };
    notificationHandler({ type: "callUpdate", call: mockCall });
    bridge.sendDTMF("1234#");
    expect(mockCall.dtmf).toHaveBeenCalledWith("1234#");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/providers/call-bridge.test.ts`
Expected: FAIL — answer, hangup, dial, sendDTMF methods don't exist

- [ ] **Step 3: Implement call action methods**

Add to `src/providers/call-bridge.ts`:

```typescript
/** Answer the current inbound call. */
answer(): void {
  if (!this._activeCall) throw new Error("No active call");
  (this._activeCall as any).answer();
}

/** End the active call. */
hangup(): void {
  if (!this._activeCall) return;
  (this._activeCall as any).hangup();
}

/**
 * Initiate an outbound PSTN call.
 * @param destination Phone number or SIP URI to call.
 * @param callerNumber The caller ID number to present.
 * @returns The Telnyx Call object.
 */
dial(destination: string, callerNumber?: string): unknown {
  if (!this.client) throw new Error("Not connected — call start() first");
  const call = (this.client as any).newCall({
    destinationNumber: destination,
    callerNumber,
  });
  this._activeCall = call;
  return call;
}

/** Send DTMF digits on the active call. */
sendDTMF(digits: string): void {
  if (!this._activeCall) throw new Error("No active call");
  (this._activeCall as any).dtmf(digits);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/providers/call-bridge.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas
git add src/providers/call-bridge.ts tests/providers/call-bridge.test.ts
git commit -m "feat(call-bridge): add call actions — answer, dial, hangup, sendDTMF"
```

---

## Task 8: Update Exports and Clean Up

Replace the old `TelnyxTransport` stub with the new `TelnyxCallBridge`. Update barrel exports.

**Files:**
- Modify: `src/index.ts`
- Delete: `src/providers/transport.ts`

- [ ] **Step 1: Write a test that the new exports work**

Add to `tests/providers/call-bridge.test.ts`:

```typescript
describe("package exports", () => {
  it("exports TelnyxCallBridge from the package root", async () => {
    const mod = await import("../src/index.js");
    expect(mod.TelnyxCallBridge).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run tests/providers/call-bridge.test.ts`
Expected: FAIL — TelnyxCallBridge not exported from index

- [ ] **Step 3: Update index.ts and remove old transport.ts**

```typescript
// src/index.ts
/**
 * @telnyx/voice-cloudflare
 *
 * Telnyx voice providers for the Cloudflare Agents SDK.
 */

export { TelnyxClient, type TelnyxClientConfig } from "./client.js";
export { TelnyxSTT, type TelnyxSTTConfig } from "./providers/stt.js";
export { TelnyxTTS, type TelnyxTTSConfig } from "./providers/tts.js";
export {
  TelnyxCallBridge,
  type TelnyxCallBridgeConfig,
} from "./providers/call-bridge.js";
```

Delete `src/providers/transport.ts`:

```bash
rm src/providers/transport.ts
```

- [ ] **Step 4: Run all tests to verify everything passes**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Verify TypeScript compilation**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas
git rm src/providers/transport.ts
git add src/index.ts src/providers/call-bridge.ts
git commit -m "feat: replace TelnyxTransport stub with TelnyxCallBridge

Removes the placeholder transport.ts that implemented the wrong interface
(VoiceTransport). Replaces it with TelnyxCallBridge implementing
VoiceAudioInput — the correct architecture for bridging phone calls
into the Cloudflare voice pipeline."
```

---

## Task 9: Final Integration Smoke Check

Verify the complete implementation compiles, all tests pass, and the public API is correct.

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Run TypeScript build**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && npm run build`
Expected: Clean build, `dist/` contains compiled JS + declaration files

- [ ] **Step 3: Verify dist exports**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && node -e "const m = require('./dist/index.js'); console.log(Object.keys(m))"`
Expected: Output includes `TelnyxCallBridge`, `TelnyxClient`, `TelnyxSTT`, `TelnyxTTS`

- [ ] **Step 4: Commit build artifacts if gitignored, or verify .gitignore excludes dist/**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/las-vegas && cat .gitignore | grep dist`
Expected: `dist/` is in .gitignore — no build commit needed
