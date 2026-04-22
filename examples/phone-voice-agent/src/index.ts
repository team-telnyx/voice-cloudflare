/**
 * Telnyx Phone Voice Agent — Cloudflare Worker
 *
 * A voice agent that handles phone calls via Telnyx WebRTC.
 * The browser connects to Telnyx via a JWT, receives phone audio
 * through a TelnyxCallBridge, and routes it to this agent for
 * STT → agent logic → TTS. Response audio is played back into
 * the phone call (not through browser speakers).
 *
 * Environment variables (set via `wrangler secret put`):
 *   TELNYX_API_KEY                  — your Telnyx API key
 *   TELNYX_CREDENTIAL_CONNECTION_ID — SIP credential connection UUID
 */

import { Agent, routeAgentRequest } from "agents";
import { withVoice, type VoiceTurnContext } from "@cloudflare/voice";
import { TelnyxSTT, TelnyxTTS, TelnyxJWTEndpoint } from "@telnyx/voice-cloudflare";

interface Env {
  TELNYX_API_KEY: string;
  TELNYX_CREDENTIAL_CONNECTION_ID: string;
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
    const url = new URL(request.url);

    // JWT endpoint — the browser calls this to get a Telnyx login token
    if (url.pathname === "/api/telnyx-token") {
      const jwt = new TelnyxJWTEndpoint({
        apiKey: env.TELNYX_API_KEY,
        credentialConnectionId: env.TELNYX_CREDENTIAL_CONNECTION_ID,
      });
      return jwt.handleRequest(request);
    }

    // Route agent requests (WebSocket upgrade for voice)
    const response = await routeAgentRequest(request, env);
    if (response) return response;

    return new Response("Not found", { status: 404 });
  },
};
