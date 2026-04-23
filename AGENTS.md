# @telnyx/voice-cloudflare

> Telnyx voice providers for the Cloudflare Agents SDK

## Linear

- **AIF-112**: [Add Telnyx as a provider to Cloudflare Agents SDK voice pipeline](https://linear.app/telnyx/issue/AIF-112/add-telnyx-as-a-provider-to-cloudflare-agents-sdk-voice-pipeline)
- **AIF-113**: [Implement Telnyx STT provider](https://linear.app/telnyx/issue/AIF-113/implement-telnyx-stt-provider-for-cloudflare-agents-sdk)
- **AIF-114**: [Implement Telnyx TTS provider](https://linear.app/telnyx/issue/AIF-114/implement-telnyx-tts-provider-for-cloudflare-agents-sdk)
- **AIF-115**: [Implement Telnyx Transport provider](https://linear.app/telnyx/issue/AIF-115/implement-telnyx-transport-provider-for-cloudflare-agents-sdk)

## Architecture Decision

**Single repo, single package with subpath exports.** All three capabilities (STT, TTS, Telephony) live in `@telnyx/voice-cloudflare` with independent entry points:

- `@telnyx/voice-cloudflare/stt` — STT only, no `@telnyx/webrtc` dependency
- `@telnyx/voice-cloudflare/tts` — TTS only, no `@telnyx/webrtc` dependency
- `@telnyx/voice-cloudflare/telephony` — PSTN bridge, phone client, JWT endpoint
- `@telnyx/voice-cloudflare` — everything (main entrypoint)

**Why monolith with subpaths:**
- Matches the `@cloudflare/voice-{provider}` naming convention (Deepgram, ElevenLabs, Twilio)
- One version, one install, one CI pipeline
- Subpath exports let users avoid pulling `@telnyx/webrtc` into their bundle when they only need STT/TTS
- Can split into separate packages later if needed — can't easily merge back

**Not a fork of cloudflare/agents.** Provider interfaces are designed to be implemented externally — no modifications to the Cloudflare SDK needed. The PR to `cloudflare/agents` will be for documentation/example listing as a third-party provider.

## Development

```bash
npm install
npm run build
npm test
```

## Publishing

```bash
npm run build
npm publish --access public
```
