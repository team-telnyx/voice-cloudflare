# Basic Voice Agent Example

A deployable Cloudflare Worker that runs a voice agent with Telnyx STT and TTS. Speak into your browser microphone and hear the agent respond.

**Pipeline:** Browser mic → WebSocket → Telnyx STT → Agent logic → Telnyx TTS → Browser speaker

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- A [Telnyx account](https://portal.telnyx.com/sign-up) with an API key

## 1. Telnyx Setup

1. **Create a Telnyx account** at [portal.telnyx.com/sign-up](https://portal.telnyx.com/sign-up)
   - You'll need to verify your email and complete basic onboarding

2. **Get your API key**
   - Go to [portal.telnyx.com/#/app/api-keys](https://portal.telnyx.com/#/app/api-keys)
   - Click **Create API Key**
   - Copy the key (starts with `KEY...`) -- you'll need it in step 3

> **Note:** This example only uses STT and TTS, which require just an API key. No SIP credentials, phone numbers, or credential connections are needed.

## 2. Install Dependencies

From this directory:

```bash
# Build the library first (from the repo root)
cd ../../
npm install && npm run build
cd examples/basic-voice-agent

# Install example dependencies
npm install
```

## 3. Configure Secrets

Set your Telnyx API key as a Wrangler secret:

```bash
# For local development
echo "TELNYX_API_KEY=KEY_your_key_here" > .dev.vars

# For production (interactive prompt)
npx wrangler secret put TELNYX_API_KEY
```

## 4. Run Locally

```bash
npm run dev
```

This builds the client JS and starts a local dev server. Open the URL printed by Wrangler (usually `http://localhost:8787`).

1. Click **Connect**
2. Allow microphone access when prompted
3. Speak -- you should see your transcript appear and hear the agent respond

## 5. Deploy to Cloudflare

```bash
npm run deploy
```

The first deploy will prompt you to log in to Cloudflare. After that, your agent will be live at `https://telnyx-voice-agent.<your-subdomain>.workers.dev`.

Make sure you've set the `TELNYX_API_KEY` secret for production (step 3).

## Customization

### Change the voice

Edit `src/index.ts` and change the `voice` option:

```typescript
tts = new TelnyxTTS({
  apiKey: this.env.TELNYX_API_KEY,
  voice: "Telnyx.NaturalHD.zeus",  // try different voices
});
```

### Add LLM integration

Replace the `onTurn` method with a call to your preferred LLM:

```typescript
async onTurn(transcript: string, context: VoiceTurnContext) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful voice assistant. Keep responses short." },
        { role: "user", content: transcript },
      ],
    }),
  });
  const data = await response.json();
  return data.choices[0].message.content;
}
```

### Use the Deepgram STT engine

```typescript
transcriber = new TelnyxSTT({
  apiKey: this.env.TELNYX_API_KEY,
  engine: "Deepgram",
  transcriptionModel: "nova-3",
});
```

## Project Structure

```
basic-voice-agent/
  src/index.ts        # Worker entry point + VoiceAgent Durable Object
  client/main.ts      # Browser-side code (bundled into public/client.js)
  public/index.html   # Static HTML page
  wrangler.toml       # Cloudflare Worker configuration
```

## Troubleshooting

**"No microphone access"** -- Make sure you're accessing the page over HTTPS (or localhost). Browsers block mic access on insecure origins.

**Agent doesn't respond** -- Check the Wrangler console for errors. The most common issue is a missing or invalid `TELNYX_API_KEY`.

**WebSocket connection fails** -- Ensure the agent name in `client/main.ts` (`agent: "voice-agent"`) matches the Durable Object class routing. If using a different class name, update accordingly.
