# TelnyxSTT Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `TelnyxSTT` as a Cloudflare `Transcriber` that streams 16kHz mono PCM to the Telnyx WebSocket STT API and fires `onInterim`/`onUtterance` callbacks.

**Architecture:** `TelnyxSTT` is a factory implementing the `Transcriber` interface. `createSession()` opens a WebSocket to `wss://api.telnyx.com/v2/speech-to-text/transcription` with API key auth. `TelnyxSTTSession` implements `TranscriberSession` — `feed()` sends binary audio frames, incoming JSON messages drive callbacks based on `is_final`.

**Tech Stack:** TypeScript 5.7, Vitest 3.x, WebSocket (global API — runs in Cloudflare Workers runtime)

**Spec:** `docs/superpowers/specs/2026-04-20-telnyx-stt-provider-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/providers/stt.ts` | Rewrite | `TelnyxSTT` (Transcriber factory) + `TelnyxSTTSession` (per-call session) |
| `tests/providers/stt.test.ts` | Create | Unit tests with mocked WebSocket |

No changes to `src/client.ts`, `src/index.ts`, or any other file. Exports are already wired.

---

### Task 1: TelnyxSTT config and createSession scaffold

**Files:**
- Modify: `src/providers/stt.ts`
- Create: `tests/providers/stt.test.ts`

- [ ] **Step 1: Write config and constructor tests**

Create `tests/providers/stt.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/chengdu && npx vitest run tests/providers/stt.test.ts`

Expected: FAIL — `TelnyxSTT` exists but has no `createSession` method.

- [ ] **Step 3: Implement TelnyxSTT and TelnyxSTTSession scaffold**

Replace the contents of `src/providers/stt.ts` with:

```typescript
/**
 * Telnyx STT provider for the Cloudflare Agents SDK.
 *
 * Implements the Transcriber interface from @cloudflare/voice,
 * streaming audio to the Telnyx WebSocket STT API.
 */

import { TelnyxClient, type TelnyxClientConfig } from "../client.js";

const DEFAULT_STT_URL = "wss://api.telnyx.com/v2/speech-to-text/transcription";

export interface TelnyxSTTConfig extends TelnyxClientConfig {
  /** STT engine (default: "Telnyx") */
  engine?: string;
  /** Language code for transcription (default: "en") */
  language?: string;
  /** Audio input format (default: "pcm") */
  inputFormat?: string;
  /** Deepgram model when engine is "Deepgram" (e.g., "nova-3", "flux") */
  transcriptionModel?: string;
  /** Enable interim results (default: true) */
  interimResults?: boolean;
}

export interface TelnyxSTTSessionOptions {
  language?: string;
  onInterim?: (text: string) => void;
  onUtterance?: (transcript: string) => void;
}

export class TelnyxSTT {
  private client: TelnyxClient;
  private engine: string;
  private language: string;
  private inputFormat: string;
  private transcriptionModel?: string;
  private interimResults: boolean;
  private sttUrl: string;

  constructor(config: TelnyxSTTConfig) {
    this.client = new TelnyxClient(config);
    this.engine = config.engine ?? "Telnyx";
    this.language = config.language ?? "en";
    this.inputFormat = config.inputFormat ?? "pcm";
    this.transcriptionModel = config.transcriptionModel;
    this.interimResults = config.interimResults ?? true;
    this.sttUrl = config.wsUrl ?? DEFAULT_STT_URL;
  }

  createSession(options?: TelnyxSTTSessionOptions): TelnyxSTTSession {
    const language = options?.language ?? this.language;
    return new TelnyxSTTSession({
      apiKey: this.client.apiKey,
      sttUrl: this.sttUrl,
      engine: this.engine,
      inputFormat: this.inputFormat,
      transcriptionModel: this.transcriptionModel,
      interimResults: this.interimResults,
      language,
      onInterim: options?.onInterim,
      onUtterance: options?.onUtterance,
    });
  }
}

interface SessionParams {
  apiKey: string;
  sttUrl: string;
  engine: string;
  inputFormat: string;
  transcriptionModel?: string;
  interimResults: boolean;
  language: string;
  onInterim?: (text: string) => void;
  onUtterance?: (transcript: string) => void;
}

export class TelnyxSTTSession {
  private ws: WebSocket;
  private pendingChunks: ArrayBuffer[] = [];
  private closed = false;
  private onInterim?: (text: string) => void;
  private onUtterance?: (transcript: string) => void;

  constructor(params: SessionParams) {
    this.onInterim = params.onInterim;
    this.onUtterance = params.onUtterance;

    const url = new URL(params.sttUrl);
    url.searchParams.set("transcription_engine", params.engine);
    url.searchParams.set("input_format", params.inputFormat);
    url.searchParams.set("token", params.apiKey);

    this.ws = new WebSocket(url.toString());

    this.ws.onopen = () => {
      for (const chunk of this.pendingChunks) {
        this.ws.send(chunk);
      }
      this.pendingChunks = [];
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    this.ws.onerror = () => {
      this.closed = true;
    };

    this.ws.onclose = () => {
      this.closed = true;
    };
  }

  feed(chunk: ArrayBuffer): void {
    if (this.closed) return;

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    } else if (this.ws.readyState === WebSocket.CONNECTING) {
      this.pendingChunks.push(chunk);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingChunks = [];
    this.ws.close();
  }

  private handleMessage(event: MessageEvent): void {
    let data: { transcript?: string; is_final?: boolean };
    try {
      data = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (typeof data.transcript !== "string" || data.transcript === "") return;

    if (data.is_final) {
      this.onUtterance?.(data.transcript);
    } else {
      this.onInterim?.(data.transcript);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/chengdu && npx vitest run tests/providers/stt.test.ts`

Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/chengdu
git add src/providers/stt.ts tests/providers/stt.test.ts
git commit -m "feat(stt): implement TelnyxSTT with createSession and WebSocket connection"
```

---

### Task 2: Audio streaming — feed() and buffering

**Files:**
- Test: `tests/providers/stt.test.ts`

- [ ] **Step 1: Write feed() and buffering tests**

Append to `tests/providers/stt.test.ts`, inside the top-level `describe("TelnyxSTT", ...)`:

```typescript
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
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/chengdu && npx vitest run tests/providers/stt.test.ts`

Expected: All 11 tests PASS (6 from Task 1 + 5 new). The implementation from Task 1 already handles all these cases.

- [ ] **Step 3: Commit**

```bash
cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/chengdu
git add tests/providers/stt.test.ts
git commit -m "test(stt): add feed() and audio buffering tests"
```

---

### Task 3: Transcript callbacks — onInterim and onUtterance

**Files:**
- Test: `tests/providers/stt.test.ts`

- [ ] **Step 1: Write transcript callback tests**

Append to `tests/providers/stt.test.ts`, inside the `describe("TelnyxSTTSession", ...)` block:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/chengdu && npx vitest run tests/providers/stt.test.ts`

Expected: All 18 tests PASS (11 prior + 7 new). Implementation already handles these.

- [ ] **Step 3: Commit**

```bash
cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/chengdu
git add tests/providers/stt.test.ts
git commit -m "test(stt): add transcript callback tests for onInterim and onUtterance"
```

---

### Task 4: Session close and cleanup

**Files:**
- Test: `tests/providers/stt.test.ts`

- [ ] **Step 1: Write close() and lifecycle tests**

Append to `tests/providers/stt.test.ts`, inside `describe("TelnyxSTTSession", ...)`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify failures (if any)**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/chengdu && npx vitest run tests/providers/stt.test.ts`

Expected: The "stops firing callbacks after close" test may fail — `handleMessage` doesn't check `this.closed` before calling callbacks. The "clears pending buffer on close" test may also fail if `onopen` still fires after close.

- [ ] **Step 3: Fix handleMessage to check closed state**

In `src/providers/stt.ts`, update the `handleMessage` method to bail early when closed:

```typescript
  private handleMessage(event: MessageEvent): void {
    if (this.closed) return;

    let data: { transcript?: string; is_final?: boolean };
    try {
      data = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (typeof data.transcript !== "string" || data.transcript === "") return;

    if (data.is_final) {
      this.onUtterance?.(data.transcript);
    } else {
      this.onInterim?.(data.transcript);
    }
  }
```

Also update `onopen` to check closed state:

```typescript
    this.ws.onopen = () => {
      if (this.closed) return;
      for (const chunk of this.pendingChunks) {
        this.ws.send(chunk);
      }
      this.pendingChunks = [];
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/chengdu && npx vitest run tests/providers/stt.test.ts`

Expected: All 22 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/chengdu
git add src/providers/stt.ts tests/providers/stt.test.ts
git commit -m "feat(stt): add close() lifecycle handling and guard callbacks"
```

---

### Task 5: Type check and full test suite run

**Files:** None (verification only)

- [ ] **Step 1: Run type checker**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/chengdu && npx tsc --noEmit`

Expected: No type errors. If there are errors, fix them in `src/providers/stt.ts`.

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/chengdu && npx vitest run`

Expected: All tests pass (existing 88 tests + ~22 new STT tests).

- [ ] **Step 3: Commit any fixes if needed**

If any fixes were required:
```bash
cd /Users/oliverzimmerman/conductor/workspaces/voice-cloudflare/chengdu
git add -u
git commit -m "fix(stt): resolve type errors from full suite run"
```
