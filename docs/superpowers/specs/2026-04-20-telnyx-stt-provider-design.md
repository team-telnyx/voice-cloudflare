# TelnyxSTT Provider Design

## Summary

Implement `TelnyxSTT` as a Cloudflare `Transcriber` provider that streams audio to Telnyx's standalone WebSocket STT API and emits interim/final transcripts.

**Linear ticket:** AIF-113 — Implement Telnyx STT provider for Cloudflare Agents SDK

## Target API

```typescript
import { TelnyxSTT } from "@telnyx/voice-cloudflare";

// In a Cloudflare Agent:
transcriber = new TelnyxSTT({ apiKey: this.env.TELNYX_API_KEY });
```

## Interface to implement

The Cloudflare `Transcriber` interface from `@cloudflare/voice`:

```typescript
interface Transcriber {
  createSession(options?: TranscriberSessionOptions): TranscriberSession;
}

interface TranscriberSessionOptions {
  language?: string;
  onInterim?: (text: string) => void;
  onUtterance?: (transcript: string) => void;
}

interface TranscriberSession {
  feed(chunk: ArrayBuffer): void;  // 16kHz mono PCM
  close(): void;
}
```

## Telnyx STT WebSocket API

**Endpoint:** `wss://api.telnyx.com/v2/speech-to-text/transcription`

**Authentication:** API key passed as `token` query parameter (the standard `WebSocket` constructor in browser/Workers runtimes does not support custom headers, so we use query param auth instead of the `Authorization` header shown in the Python docs).

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `transcription_engine` | string | `Telnyx`, `Deepgram`, `Google`, `Azure` |
| `input_format` | string | Audio format (`pcm`, `mp3`, `wav`) |

**Protocol:**

- **Client sends:** Binary audio frames (raw PCM bytes via `ArrayBuffer`)
- **Server sends:** JSON messages:
  ```json
  {
    "transcript": "Hello world",
    "is_final": true,
    "confidence": 0.97
  }
  ```

**Mapping to Cloudflare interface:**

| Server message | Callback |
|----------------|----------|
| `is_final: false` | `onInterim(transcript)` |
| `is_final: true` | `onUtterance(transcript)` |

## Architecture

```
TelnyxSTT (Transcriber)
  └── createSession(options) → TelnyxSTTSession (TranscriberSession)
        ├── feed(chunk)  →  binary WebSocket frame
        ├── close()      →  close WebSocket + clear buffer
        └── onmessage    →  parse JSON → onInterim / onUtterance
```

Each `createSession()` call opens a new WebSocket connection. Sessions are independent and scoped to a single call/conversation.

## Configuration

```typescript
export interface TelnyxSTTConfig extends TelnyxClientConfig {
  /** STT engine (default: "Telnyx") */
  engine?: string;
  /** Language code (default: "en") */
  language?: string;
  /** Audio input format (default: "pcm") */
  inputFormat?: string;
  /** Deepgram model when engine is "Deepgram" (e.g., "nova-3", "flux") */
  transcriptionModel?: string;
  /** Enable interim results (default: true) */
  interimResults?: boolean;
}
```

`TelnyxClientConfig` provides `apiKey`, `baseUrl`, and `wsUrl`. The STT provider constructs its WebSocket URL from the base domain, defaulting to `wss://api.telnyx.com/v2/speech-to-text/transcription`.

## Session lifecycle

1. **Create:** `createSession(options)` constructs a `TelnyxSTTSession`, initiates WebSocket with auth header and query params.
2. **Buffer:** Audio chunks received via `feed()` before the socket is open are queued in a pending buffer. Flushed once connected.
3. **Stream:** `feed(chunk)` sends each `ArrayBuffer` as a binary WebSocket frame.
4. **Receive:** Server JSON messages are parsed. `is_final: false` fires `onInterim`, `is_final: true` fires `onUtterance`.
5. **Close:** `close()` closes the WebSocket and clears the pending buffer. Subsequent `feed()` calls are no-ops.

## Files

| File | Change |
|------|--------|
| `src/providers/stt.ts` | Replace skeleton with full implementation |
| `tests/providers/stt.test.ts` | New test file |
| `src/index.ts` | No change (already exports TelnyxSTT) |
| `src/client.ts` | No change |

## Error handling

- WebSocket `onerror`/`onclose`: Session becomes inoperable. `feed()` becomes a no-op. No auto-reconnect — the voice pipeline creates new sessions as needed.
- Server error messages (`{ "error": ... }`): Logged, no callback fired. Matches Cloudflare's pattern.

## Test plan

Unit tests with mocked WebSocket:

- Config defaults (engine: "Telnyx", language: "en", inputFormat: "pcm")
- Config overrides (custom engine, language, model)
- WebSocket URL construction with query params
- Auth header on connection
- Audio buffering before socket open, flush on open
- Binary frame sending via `feed()`
- `onInterim` callback for `is_final: false`
- `onUtterance` callback for `is_final: true`
- `close()` cleans up WebSocket and buffer
- No-op `feed()` after `close()`
- Error/disconnect handling
