/**
 * Telnyx Voice Agent — Cloudflare Worker
 *
 * A voice agent that uses Telnyx STT and TTS on Cloudflare Workers.
 * The browser captures mic audio, streams it to this agent over a
 * WebSocket, and the agent transcribes speech, generates a response,
 * and speaks it back via TTS.
 *
 * Environment variables (set via `wrangler secret put`):
 *   TELNYX_API_KEY — your Telnyx API key
 */

import { Agent, routeAgentRequest } from "agents";
import { withVoice, type VoiceTurnContext } from "@cloudflare/voice";
import { TelnyxSTT, TelnyxTTS } from "@telnyx/voice-cloudflare";

interface Env {
  TELNYX_API_KEY: string;
  VOICE_AGENT: DurableObjectNamespace;
}

const BaseVoiceAgent = withVoice(Agent);

export class VoiceAgent extends BaseVoiceAgent<Env> {
  transcriber = new TelnyxSTT({ apiKey: this.env.TELNYX_API_KEY });
  tts = new TelnyxTTS({
    apiKey: this.env.TELNYX_API_KEY,
    voice: "Telnyx.NaturalHD.astra",
  });

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // Replace this with your own logic — call an LLM, look up data, etc.
    return `You said: ${transcript}`;
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const response = await routeAgentRequest(request, env);
    if (response) return response;
    return new Response("Not found", { status: 404 });
  },
};
