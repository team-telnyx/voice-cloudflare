# @telnyx/voice-cloudflare

> Telnyx voice providers for the Cloudflare Agents SDK

## Linear

- **AIF-112**: [Add Telnyx as a provider to Cloudflare Agents SDK voice pipeline](https://linear.app/telnyx/issue/AIF-112/add-telnyx-as-a-provider-to-cloudflare-agents-sdk-voice-pipeline)
- **AIF-113**: [Implement Telnyx STT provider](https://linear.app/telnyx/issue/AIF-113/implement-telnyx-stt-provider-for-cloudflare-agents-sdk)
- **AIF-114**: [Implement Telnyx TTS provider](https://linear.app/telnyx/issue/AIF-114/implement-telnyx-tts-provider-for-cloudflare-agents-sdk)
- **AIF-115**: [Implement Telnyx Transport provider](https://linear.app/telnyx/issue/AIF-115/implement-telnyx-transport-provider-for-cloudflare-agents-sdk)

## Architecture Decision

**Single repo, single package.** All three providers (STT, TTS, Transport) live in `@telnyx/voice-cloudflare` because:

- All three share Telnyx auth, client setup, and types
- Follows the same pattern as `@cloudflare/voice` itself
- One version, one install, one CI pipeline
- Users pick the providers they need: `import { TelnyxSTT, TelnyxTransport } from "@telnyx/voice-cloudflare"`

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
