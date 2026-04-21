# @telnyx/voice-cloudflare

Telnyx voice providers for the [Cloudflare Agents SDK](https://github.com/cloudflare/agents).

Gives [`@cloudflare/voice`](https://blog.cloudflare.com/voice-agents/) agents access to Telnyx carrier-grade voice infrastructure -- real-time speech-to-text, text-to-speech, and PSTN phone bridging.

## Installation

```bash
npm install @telnyx/voice-cloudflare
```

Requires `@cloudflare/voice` as a peer dependency:

```bash
npm install @cloudflare/voice
```

## Quick Start

### Browser Voice Agent (STT + TTS)

Use Telnyx STT and TTS with a Cloudflare voice agent:

```typescript
import { Agent, routeAgentRequest } from "agents";
import { withVoice, type VoiceTurnContext } from "@cloudflare/voice";
import { TelnyxSTT, TelnyxTTS } from "@telnyx/voice-cloudflare";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  transcriber = new TelnyxSTT({ apiKey: this.env.TELNYX_API_KEY });
  tts = new TelnyxTTS({ apiKey: this.env.TELNYX_API_KEY });

  async onTurn(transcript: string, context: VoiceTurnContext) {
    return `You said: ${transcript}`;
  }
}
```

### Phone Voice Agent (PSTN Bridge)

Route phone calls to an AI agent using `TelnyxPhoneClient`. This speaks the Cloudflare voice protocol directly and routes all audio through a PSTN bridge -- no browser speakers needed.

**Server (Cloudflare Worker):**

```typescript
import { TelnyxJWTEndpoint } from "@telnyx/voice-cloudflare";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/telnyx-token") {
      const jwt = new TelnyxJWTEndpoint({
        apiKey: env.TELNYX_API_KEY,
        credentialConnectionId: env.TELNYX_CREDENTIAL_CONNECTION_ID,
      });
      return jwt.handleRequest(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
```

**Client:**

```typescript
import { TelnyxPhoneClient, createTelnyxVoiceConfig } from "@telnyx/voice-cloudflare";
import { WebSocketVoiceTransport } from "@cloudflare/voice/client";

// 1. Set up the call bridge
const telnyx = await createTelnyxVoiceConfig({
  jwtEndpoint: "/api/telnyx-token",
  autoAnswer: true,
});

// 2. Create a phone client
const phoneClient = new TelnyxPhoneClient({
  transport: new WebSocketVoiceTransport({ agent: "my-voice-agent" }),
  bridge: telnyx.bridge,
});

// 3. Listen for events
phoneClient.addEventListener("transcriptchange", (messages) => {
  console.log(messages);
});

// 4. Connect and start the call
phoneClient.connect();
phoneClient.addEventListener("connectionchange", async (connected) => {
  if (connected) await phoneClient.startCall();
});
```

## API Reference

### Providers

#### `TelnyxSTT`

Real-time speech-to-text. Implements the `Transcriber` interface from `@cloudflare/voice`.

```typescript
const stt = new TelnyxSTT({
  apiKey: "...",
  engine: "Telnyx",           // or "Deepgram"
  language: "en",
  transcriptionModel: "nova-3", // Deepgram model (when engine is "Deepgram")
  interimResults: true,
});
```

#### `TelnyxTTS`

Text-to-speech with REST and WebSocket backends. Implements `TTSProvider` and `StreamingTTSProvider`.

```typescript
const tts = new TelnyxTTS({
  apiKey: "...",
  voice: "Telnyx.NaturalHD.astra",
  backend: "rest",  // "rest" (default, works everywhere) or "websocket" (lower latency, Workers only)
});
```

### Phone Bridge

#### `TelnyxCallBridge`

Captures and plays PCM audio from PSTN phone calls via TelnyxRTC WebRTC. Implements `VoiceAudioInput`.

```typescript
const bridge = new TelnyxCallBridge({
  loginToken: "jwt-from-server",
  autoAnswer: true,
});
```

#### `TelnyxPhoneClient`

Standalone client that speaks the Cloudflare voice protocol directly and routes all audio through a `TelnyxCallBridge`. Includes silence detection, interrupt detection, transcript management, and mute.

```typescript
const client = new TelnyxPhoneClient({
  transport: new WebSocketVoiceTransport({ agent: "my-agent" }),
  bridge: myBridge,
  silenceThreshold: 0.04,
  silenceDurationMs: 500,
});
```

Events: `statuschange`, `transcriptchange`, `interimtranscript`, `metricschange`, `audiolevelchange`, `connectionchange`, `error`, `mutechange`, `custommessage`.

#### `TelnyxPhoneTransport`

Lightweight transport wrapper. Wraps any `VoiceTransport`, intercepts server audio, and routes it to a `TelnyxCallBridge` for PSTN playback. Use this when you want `VoiceClient` for status/transcript management but need audio routed to a phone instead of browser speakers.

```typescript
const transport = new TelnyxPhoneTransport({
  inner: new WebSocketVoiceTransport({ agent: "my-agent" }),
  bridge: myBridge,
});
```

### Server Utilities

#### `TelnyxJWTEndpoint`

Server-side endpoint that generates Telnyx WebRTC login tokens. Keeps your API key secure on the server.

```typescript
const jwt = new TelnyxJWTEndpoint({
  apiKey: "...",
  credentialConnectionId: "...",
});
const response = await jwt.handleRequest(request);
```

#### `createTelnyxVoiceConfig(options)`

Convenience factory that fetches a JWT and creates a ready-to-use `TelnyxCallBridge`.

```typescript
const { bridge, audioInput, cleanup } = await createTelnyxVoiceConfig({
  jwtEndpoint: "/api/telnyx-token",
  autoAnswer: true,
});
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TELNYX_API_KEY` | Your Telnyx API key (server-side only) |
| `TELNYX_CREDENTIAL_CONNECTION_ID` | Credential connection UUID for WebRTC auth |

Set these via `wrangler secret put` for Cloudflare Workers.

## Examples

See the [`examples/`](./examples) directory:

- **[`phone-voice-agent`](./examples/phone-voice-agent)** -- Phone call routed to an AI agent via `TelnyxPhoneClient`
- **[`hybrid-agent`](./examples/hybrid-agent)** -- Browser mic + phone bridge running side-by-side

## Related

- [Cloudflare Voice Agents Blog Post](https://blog.cloudflare.com/voice-agents/)
- [Cloudflare Agents SDK](https://github.com/cloudflare/agents)
- [Telnyx API Docs](https://developers.telnyx.com/)

## License

MIT
