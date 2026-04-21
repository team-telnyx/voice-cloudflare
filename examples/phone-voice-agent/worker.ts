/**
 * Example: Cloudflare Worker with Telnyx JWT endpoint + phone voice agent.
 *
 * This Worker serves the JWT endpoint that the browser calls
 * to get a Telnyx login token, and hosts the voice agent.
 *
 * The browser page uses TelnyxPhoneClient — a standalone client that
 * speaks the Cloudflare voice protocol directly and routes all audio
 * through the TelnyxCallBridge (phone ↔ agent, no browser speakers).
 *
 * Server-side agent requirements:
 *   - Use `withVoice(Agent, { audioFormat: "pcm16" })` so that
 *     audio arrives as 16kHz mono Int16 LE PCM.
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
  <h1>Telnyx Phone &harr; AI Agent</h1>
  <button id="connect">Connect</button>
  <button id="disconnect" disabled>Disconnect</button>
  <p>Status: <span id="status">Idle</span></p>
  <p>Transcript:</p>
  <div id="transcript" style="white-space:pre-wrap; font-family:monospace;"></div>

  <!--
    NOTE: This example uses bare module specifiers (e.g. "@telnyx/voice-cloudflare").
    You need a bundler (Vite, esbuild, webpack) or an import map to resolve them.
  -->
  <script type="module">
    import { TelnyxPhoneClient, createTelnyxVoiceConfig } from "@telnyx/voice-cloudflare";
    import { WebSocketVoiceTransport } from "@cloudflare/voice/client";

    let phoneClient;
    let telnyx;

    document.getElementById("connect").onclick = async () => {
      document.getElementById("status").textContent = "Connecting...";

      // 1. Fetch JWT + create call bridge
      telnyx = await createTelnyxVoiceConfig({
        jwtEndpoint: "/api/telnyx-token",
        autoAnswer: true,
      });

      // 2. Create the phone client — speaks the voice protocol directly,
      //    routes all audio through the bridge (no browser speakers).
      phoneClient = new TelnyxPhoneClient({
        transport: new WebSocketVoiceTransport({ agent: "my-voice-agent" }),
        bridge: telnyx.bridge,
      });

      // 3. Listen for events
      phoneClient.addEventListener("statuschange", (status) => {
        document.getElementById("status").textContent = status;
      });

      phoneClient.addEventListener("transcriptchange", (messages) => {
        document.getElementById("transcript").textContent = messages
          .map((m) => m.role + ": " + m.text)
          .join("\\n");
      });

      // 4. Connect, then start the call once the WebSocket is open
      phoneClient.addEventListener("connectionchange", async (connected) => {
        if (connected) {
          await phoneClient.startCall();
          document.getElementById("status").textContent = "Connected — waiting for call";
        }
      });

      phoneClient.connect();
      document.getElementById("connect").disabled = true;
      document.getElementById("disconnect").disabled = false;
    };

    document.getElementById("disconnect").onclick = async () => {
      phoneClient?.disconnect();
      await telnyx?.cleanup();
      document.getElementById("status").textContent = "Disconnected";
      document.getElementById("connect").disabled = false;
      document.getElementById("disconnect").disabled = true;
    };
  </script>
</body>
</html>`;
