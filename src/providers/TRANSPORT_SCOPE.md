# AIF-115 Scope: Telnyx Transport Provider for Cloudflare Agents SDK

## Context

The Cloudflare Agents SDK voice pipeline has three pluggable provider interfaces:
- **Transcriber (STT):** `Transcriber` → `TranscriberSession` — continuous per-call STT with turn detection
- **TTS:** `TTSProvider` / `StreamingTTSProvider` — synthesize or stream audio from text
- **Transport:** `VoiceTransport` — the data channel between client and server (WebSocket, WebRTC, etc.)

The **Transport** provider is the highest-value for Telnyx because it bridges Cloudflare voice agents to real phone networks via SIP — something no other provider can offer.

## Interface to Implement

The `VoiceTransport` interface is **client-side only** — it replaces the default WebSocket transport between the browser and the Cloudflare Worker:

```typescript
interface VoiceTransport {
  sendJSON(data: Record<string, unknown>): void;
  sendBinary(data: ArrayBuffer): void;
  connect(): void;
  disconnect(): void;
  readonly connected: boolean;
  
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((error?: unknown) => void) | null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null;
}
```

There's also `VoiceAudioInput` for custom audio capture (bypasses the built-in mic):

```typescript
interface VoiceAudioInput {
  start(): Promise<void>;
  stop(): void;
  onAudioLevel: ((rms: number) => void) | null;
  onAudioData?: ((pcm: ArrayBuffer) => void) | null;
}
```

## Architecture

### Key Finding: Three Independent Connections

The Telnyx WebRTC SDK (`@telnyx/webrtc`) uses **two** connections internally, and the Cloudflare voice pipeline adds a **third**:

1. **Telnyx WebSocket signaling** (`wss://rtc.telnyx.com`) — Verto protocol for call setup (invite, answer, bye, ICE candidate exchange). Managed entirely by the SDK internally.
2. **Telnyx WebRTC media** (`RTCPeerConnection`) — Opus-encoded audio via RTP. The SDK creates/manages this automatically.
3. **Cloudflare VoiceTransport** (WebSocket/PartySocket) — JSON protocol messages + binary audio PCM between browser and Worker.

**These are independent and don't conflict.**

```
Browser
├── Telnyx SDK WebSocket (wss://rtc.telnyx.com) → Verto signaling → Telnyx Platform
├── Telnyx SDK WebRTC (RTCPeerConnection) → Opus audio → Telnyx Platform
└── Cloudflare VoiceTransport (WebSocket) → JSON + binary PCM → Cloudflare Worker
```

The Telnyx provider bridges connections 1+2 into connection 3 by tapping into the SDK's `MediaStream` and routing audio through the Cloudflare voice pipeline.

### Design: TelnyxCallBridge (implements `VoiceAudioInput`)

**Don't replace `VoiceTransport`** — keep the default `WebSocketVoiceTransport` (PartySocket). It works fine for browser↔Worker communication. The Telnyx value is in `VoiceAudioInput` (bridging phone calls), not in replacing the transport layer.

The `TelnyxCallBridge` class:
- Initializes a `TelnyxRTC` client with JWT auth
- Listens for inbound calls via `telnyx.notification` events
- Extracts PCM from `call.remoteStream` (MediaStream) via `AudioContext.createMediaStreamSource()` + `AudioWorklet`
- Feeds 16kHz mono PCM to `VoiceAudioInput.onAudioData`
- For outbound audio (agent → caller): receives PCM from VoiceTransport, creates virtual MediaStream, injects into call
- Handles call lifecycle: dial, answer, hangup, DTMF

### Call Flow: Inbound PSTN → Agent

```
PSTN Caller → Telnyx SIP → Telnyx SDK (WebRTC) → TelnyxCallBridge (VoiceAudioInput)
    SDK manages internally:                                ↓ extracts PCM via AudioContext
    - WS signaling (wss://rtc.telnyx.com)             Cloudflare Worker (VoiceAgentMixin)
    - WebRTC media (RTCPeerConnection)                    ↓ generates response audio
                                                    VoiceTransport (WebSocket → Worker)
                                                    ↓ receives binary audio
                                                    TelnyxCallBridge converts → MediaStream
                                                    ↓ injects into call
                                                    Telnyx SDK (WebRTC) → SIP → PSTN Caller
```

### Call Flow: Browser → Agent (no phone)

Uses the standard WebSocket transport. No Telnyx SDK needed.

```
Browser User → VoiceTransport (WebSocket/PartySocket)
                    ↓ JSON + binary
              Cloudflare Agent (VoiceAgentMixin)
```

### Call Flow: Agent → Outbound PSTN

```
TelnyxCallBridge.dial("+1234567890")
    ↓ client.newCall() via Telnyx SDK
    ↓ WS signaling (wss://rtc.telnyx.com)
    ↓ WebRTC peer connection established
PSTN Callee answers
    ↓ audio flows both ways via WebRTC
TelnyxCallBridge extracts PCM from call.remoteStream → VoiceAudioInput
VoiceTransport receives response audio → TelnyxCallBridge injects into call
```

## Implementation Plan

### Phase 1: TelnyxCallBridge (`VoiceAudioInput`)
**Effort:** High | **Value:** THE differentiator — bridges to real phone networks

- [ ] Create `src/providers/call-bridge.ts` with `TelnyxCallBridge` class implementing `VoiceAudioInput`
- [ ] Initialize `TelnyxRTC` client with JWT auth (Worker-generated token)
- [ ] Handle `telnyx.notification` events for call state machine: idle → ringing → active → ended
- [ ] Implement `start()` — connect to Telnyx platform, listen for inbound calls
- [ ] Implement `stop()` — disconnect Telnyx client, clean up audio context
- [ ] Implement PCM extraction from `call.remoteStream`:
  - `AudioContext.createMediaStreamSource(call.remoteStream)`
  - `AudioWorkletNode` to capture raw PCM
  - Resample from WebRTC Opus (typically 48kHz) to 16kHz mono 16-bit LE
  - Feed to `onAudioData(pcm: ArrayBuffer)` callback
  - Report RMS levels via `onAudioLevel(rms: number)` for silence/interrupt detection
- [ ] Implement outbound audio injection:
  - Receive 16kHz PCM from VoiceTransport binary messages
  - Upsample to 48kHz, create a `MediaStreamTrack` via `AudioContext` + `MediaStreamAudioDestinationNode`
  - Replace the sender track on the RTCPeerConnection
- [ ] Add `dial(destination, callerNumber)` — initiate outbound PSTN call via `client.newCall()`
- [ ] Add `answer(callId)` — answer inbound call
- [ ] Add `hangup()` — end active call
- [ ] Add `sendDTMF(digits)` — send DTMF tones via `call.dtmf()`
- Key dependencies: `@telnyx/webrtc`, `@cloudflare/voice`

### Phase 2: Server-Side JWT Endpoint
**Effort:** Low | **Value:** Required for auth

- [ ] Create `src/server/jwt-endpoint.ts` — Cloudflare Worker handler that:
  1. Receives client request for token
  2. Creates telephony credential via Telnyx API (`POST /v2/telephony_credentials`)
  3. Generates JWT (`POST /v2/telephony_credentials/:id/token`)
  4. Returns JWT to browser client
- [ ] Handle credential cleanup on session end
- [ ] Environment secrets needed: `TELNYX_API_KEY`, `TELNYX_CREDENTIAL_CONNECTION_ID`

### Phase 3: TelnyxTransportConfig Helper
**Effort:** Low | **Value:** Developer ergonomics

- [ ] Create `src/helpers/transport-config.ts` with factory function
- [ ] Wire up standard VoiceTransport (WebSocket) + TelnyxCallBridge together
- [ ] Handle JWT credential fetch from Worker endpoint
- [ ] Example: `createTelnyxVoiceConfig({ jwtEndpoint: '/api/telnyx-token' })`
- [ ] Export ready-to-use `VoiceClientOptions` configuration

### Phase 4: Examples & Docs
**Effort:** Low | **Value:** Adoption

- [ ] `examples/phone-voice-agent/` — PSTN ↔ agent bridge
- [ ] `examples/hybrid-agent/` — browser mic + phone bridge simultaneously
- [ ] README with setup guide (credential connection, JWT endpoint, usage)

## Key Technical Decisions

### VoiceTransport: Keep the default WebSocket
The default Cloudflare `WebSocketVoiceTransport` (PartySocket) works perfectly for browser↔Worker communication. There's no need to replace it with Telnyx WebRTC — they serve different purposes:
- **PartySocket:** Browser ↔ Cloudflare Worker (voice pipeline protocol: hello, start_call, audio PCM, transcripts)
- **Telnyx WebRTC SDK:** Browser ↔ Telnyx Platform (SIP signaling + audio via Verto + RTCPeerConnection)

The Telnyx value-add is the `VoiceAudioInput` (call bridge), not a new transport. Keep the default transport.

### Audio format conversion
- Cloudflare voice pipeline uses **16kHz mono 16-bit LE PCM** internally
- Telnyx WebRTC SDK produces **48kHz Opus-encoded** audio via `RTCPeerConnection`
- The `TelnyxCallBridge` must:
  1. Get `call.remoteStream` (MediaStream) from the Telnyx SDK
  2. Use `AudioContext.createMediaStreamSource()` + `AudioWorklet` to capture raw PCM
  3. Resample from 48kHz → 16kHz mono
  4. Convert Float32 → Int16 PCM for `onAudioData` callback
- For outbound audio (agent → caller): receive 16kHz PCM from VoiceTransport → upsample to 48kHz → create `MediaStreamTrack` → inject into WebRTC peer connection

### Audio routing: MediaStream tap (not raw PCM)
The Telnyx SDK does NOT expose raw PCM directly. It provides:
- `call.remoteStream`: MediaStream (read-only from RTCPeerConnection)
- `call.localStream`: MediaStream (mic input)
- HTML `<audio>` element for playback

To extract raw PCM, we must use the Web Audio API:
```typescript
const audioCtx = new AudioContext();
const source = audioCtx.createMediaStreamSource(call.remoteStream);
// AudioWorkletNode to capture raw PCM at 16kHz
// → onAudioData(pcm: ArrayBuffer)
```

For injecting outbound audio, we create a virtual MediaStream:
```typescript
const audioCtx = new AudioContext({ sampleRate: 48000 });
const destination = audioCtx.createMediaStreamDestination();
// Feed 16kHz PCM → upsample → destination.stream → replace sender track
```

### Credential management
- **Use JWT auth** — three-step auth chain:
  1. **Credential Connection** (`POST /v2/credential_connections`) — creates the SIP connection with `user_name` + `password`. Pre-created, stored as Worker env var.
  2. **Telephony Credential** (`POST /v2/telephony_credentials`) — created per-session under the connection. Returns `sip_username` (gencred*) + `sip_password`. No limit on count per connection.
  3. **JWT** (`POST /v2/telephony_credentials/:id/token`) — short-lived (24h) token sent to the browser for SDK auth.
- The Cloudflare Worker holds the API key (Worker secret) and the credential connection ID (env var)
- Per-session flow: Worker creates telephony credential → generates JWT → sends to browser
- Browser authenticates with just the JWT — no SIP credentials exposed client-side
- Connection is always known (it's the parent of the telephony credential) — no lookup needed
- Docs: [Credential Connections](https://developers.telnyx.com/docs/voice/webrtc/auth/credential-connections) → [Telephony Credentials](https://developers.telnyx.com/docs/voice/webrtc/auth/telephony-credentials) → [JWT](https://developers.telnyx.com/docs/voice/webrtc/auth/jwt)

### Why not replace VoiceTransport?
Replacing `VoiceTransport` with a Telnyx WebRTC-based transport would add complexity for no real benefit — the default WebSocket transport is simple and works. The Telnyx value is in `VoiceAudioInput` (bridging phone calls), not in replacing the browser↔Worker communication channel. Keep the default `WebSocketVoiceTransport`.

## Dependencies

| Package | Purpose | Status |
|---------|---------|--------|
| `@cloudflare/voice` | Provider interfaces | Available on npm |
| `@telnyx/webrtc` | Telnyx WebRTC SDK | Available on npm |
| `agents` | Cloudflare Agents SDK | Available on npm |

## Risk & Open Questions

1. **Cloudflare Workers runtime limitations** — Workers don't support WebRTC natively. The Telnyx WebRTC SDK runs entirely in the **browser** — the Worker only handles JWT generation and the voice pipeline protocol. No WebRTC in the Worker. This is the correct architecture.

2. **Protocol compatibility** — The Cloudflare voice protocol sends JSON messages (`hello`, `start_call`, `end_call`, `interrupt`, etc.) over the transport. Since we're keeping the default WebSocket transport, these are handled automatically. No changes needed.

3. **Server-side vs client-side** — Both `VoiceTransport` and `VoiceAudioInput` are **client-side** interfaces (browser). The server is a Cloudflare Worker running the `VoiceAgentMixin`. The Telnyx WebRTC client connects from the browser to the Telnyx platform using a JWT generated by the Worker. For SIP bridging, the browser-based WebRTC client receives call audio and feeds it to the VoiceClient via `VoiceAudioInput`.

4. **SFU pattern** — The Cloudflare Realtime SFU example shows a pattern where the server (Worker) acts as an SFU adapter, brokering WebRTC connections. This may be a better architecture for Telnyx than direct browser-to-Telnyx WebRTC — the Worker could maintain the SIP connection and relay audio. Need to prototype both.

5. **cloudflare/agents PR readiness** — The repo isn't accepting external PRs yet. We should open a GitHub Discussion proposing Telnyx as a provider, then submit PRs when they open up.

6. **Per-session credential lifecycle** — Each browser session needs a telephony credential created → JWT generated → credential cleaned up on disconnect. For high-traffic deployments, should we pre-provision a pool of credentials, or is on-demand creation fast enough? The API has no stated limit on credential count per connection.
