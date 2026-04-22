# Phone Voice Agent Example

A voice agent that handles **inbound phone calls** via Telnyx WebRTC. The browser acts as a control panel — all audio goes through the phone call, not the browser's mic/speakers.

**Flow:** Phone call → Telnyx WebRTC → TelnyxCallBridge → Cloudflare Worker (STT → Agent → TTS) → Phone call

## Prerequisites

1. **Telnyx Account** — sign up at [telnyx.com](https://telnyx.com)
2. **API Key** — Portal → API Keys
3. **SIP Credential Connection** — Portal → Voice → SIP Connections → Add → Credential
4. **Phone Number** — Portal → Numbers → Buy a number, assign it to your SIP connection

## Setup

```bash
cd examples/phone-voice-agent
npm install
```

Create a `.dev.vars` file with your credentials:

```
TELNYX_API_KEY=KEYxxxxxxxx
TELNYX_CREDENTIAL_CONNECTION_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## Run locally

```bash
npm run dev
```

Open [http://localhost:8787](http://localhost:8787), click **Connect**, then call the phone number assigned to your SIP connection. The call is auto-answered and routed through the AI agent.

## Deploy

```bash
npx wrangler secret put TELNYX_API_KEY
npx wrangler secret put TELNYX_CREDENTIAL_CONNECTION_ID
npm run deploy
```

## Customization

- **Agent logic** — edit `onTurn()` in `src/index.ts` (call an LLM, look up data, etc.)
- **Voice** — change the `voice` parameter in the `TelnyxTTS` constructor
- **STT engine** — pass `engine: "Deepgram"` and `transcriptionModel: "nova-3"` to `TelnyxSTT`
