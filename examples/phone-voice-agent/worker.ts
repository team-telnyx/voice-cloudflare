/**
 * Example: Cloudflare Worker with Telnyx JWT endpoint.
 *
 * This Worker serves the JWT endpoint that the browser calls
 * to get a Telnyx login token, and hosts the voice agent.
 *
 * Environment variables (set via `wrangler secret put`):
 *   TELNYX_API_KEY              — your Telnyx API key
 *   TELNYX_CREDENTIAL_CONNECTION_ID — credential connection UUID
 */

import { TelnyxJWTEndpoint } from "@telnyx/voice-cloudflare";

interface Env {
  TELNYX_API_KEY: string;
  TELNYX_CREDENTIAL_CONNECTION_ID: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // JWT endpoint for browser auth
    if (url.pathname === "/api/telnyx-token") {
      const jwt = new TelnyxJWTEndpoint({
        apiKey: env.TELNYX_API_KEY,
        credentialConnectionId: env.TELNYX_CREDENTIAL_CONNECTION_ID,
      });
      return jwt.handleRequest(request);
    }

    // Serve the client HTML
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(CLIENT_HTML, {
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

const CLIENT_HTML = `<!DOCTYPE html>
<html>
<head><title>Phone Voice Agent</title></head>
<body>
  <h1>Telnyx Phone ↔ AI Agent</h1>
  <button id="connect">Connect</button>
  <button id="disconnect" disabled>Disconnect</button>
  <p>Status: <span id="status">Idle</span></p>

  <script type="module">
    import { createTelnyxVoiceConfig } from "@telnyx/voice-cloudflare";
    import { VoiceClient } from "@cloudflare/voice/client";

    let voiceClient;
    let telnyx;

    document.getElementById("connect").onclick = async () => {
      document.getElementById("status").textContent = "Connecting...";

      // 1. Fetch JWT + create call bridge
      telnyx = await createTelnyxVoiceConfig({
        jwtEndpoint: "/api/telnyx-token",
        autoAnswer: true,  // automatically answer inbound calls
      });

      // 2. Create the voice client with the bridge as audio input
      voiceClient = new VoiceClient({
        agent: "my-voice-agent",
        audioInput: telnyx.audioInput,
      });

      // 3. Route agent audio back into the phone call
      voiceClient.on("audio", (pcm) => telnyx.bridge.playAudio(pcm));

      await voiceClient.connect();
      document.getElementById("status").textContent = "Connected — waiting for call";
      document.getElementById("connect").disabled = true;
      document.getElementById("disconnect").disabled = false;
    };

    document.getElementById("disconnect").onclick = async () => {
      voiceClient?.disconnect();
      await telnyx?.cleanup();
      document.getElementById("status").textContent = "Disconnected";
      document.getElementById("connect").disabled = false;
      document.getElementById("disconnect").disabled = true;
    };
  </script>
</body>
</html>`;
