# @telnyx/voice-cloudflare

Telnyx voice providers for the [Cloudflare Agents SDK](https://github.com/cloudflare/agents).

Adds Telnyx as a speech, telephony, and transport provider for the [`@cloudflare/voice`](https://blog.cloudflare.com/voice-agents/) pipeline, giving Cloudflare Agents SDK users access to Telnyx carrier-grade voice infrastructure.

## Installation

```bash
npm install @telnyx/voice-cloudflare
```

## Usage

```typescript
import { Agent, routeAgentRequest } from "agents";
import {
  withVoice,
  type VoiceTurnContext,
} from "@cloudflare/voice";
import { TelnyxSTT, TelnyxTTS, TelnyxTransport } from "@telnyx/voice-cloudflare";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  transcriber = new TelnyxSTT({ apiKey: this.env.TELNYX_API_KEY });
  tts = new TelnyxTTS({ apiKey: this.env.TELNYX_API_KEY });
  // Optional: bridge to real phone networks
  // transport = new TelnyxTransport({ apiKey: this.env.TELNYX_API_KEY });

  async onTurn(transcript: string, context: VoiceTurnContext) {
    return `You said: ${transcript}`;
  }
}
```

## Providers

| Provider | Class | Description |
|----------|-------|-------------|
| **STT** | `TelnyxSTT` | Real-time transcription with turn detection via Telnyx |
| **TTS** | `TelnyxTTS` | Streaming text-to-speech via Telnyx |
| **Transport** | `TelnyxTransport` | WebRTC + SIP bridge to PSTN for inbound/outbound phone calls |

## Architecture

This package implements the provider interfaces defined in `@cloudflare/voice`:

- `STTProvider` — continuous speech-to-text with turn detection
- `TTSProvider` — streaming text-to-speech synthesis
- `TransportProvider` — audio transport and call lifecycle management

All three providers share a common Telnyx client for authentication and connection management.

## Related

- [Cloudflare Agents SDK](https://github.com/cloudflare/agents)
- [Cloudflare Voice Blog Post](https://blog.cloudflare.com/voice-agents/)
- [Telnyx API Docs](https://developers.telnyx.com/)

## License

MIT
