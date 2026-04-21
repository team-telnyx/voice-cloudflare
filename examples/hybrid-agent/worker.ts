/**
 * Example: Hybrid agent — browser mic AND phone bridge simultaneously.
 *
 * This shows how to run a VoiceClient with default mic capture for
 * the browser user, while also bridging a PSTN phone call through
 * a TelnyxCallBridge. The bridge operates independently from the
 * VoiceClient — it captures phone audio and can play audio back.
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

    if (url.pathname === "/api/telnyx-token") {
      const jwt = new TelnyxJWTEndpoint({
        apiKey: env.TELNYX_API_KEY,
        credentialConnectionId: env.TELNYX_CREDENTIAL_CONNECTION_ID,
      });
      return jwt.handleRequest(request);
    }

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
<head><title>Hybrid Agent</title></head>
<body>
  <h1>Hybrid: Browser Mic + Phone Bridge</h1>

  <section>
    <h2>Browser Voice Agent</h2>
    <button id="browser-connect">Connect (Mic)</button>
    <p>Uses the default browser microphone via VoiceClient.</p>
  </section>

  <section>
    <h2>Phone Bridge</h2>
    <button id="phone-connect">Connect Phone Bridge</button>
    <button id="phone-dial" disabled>Dial +1234567890</button>
    <button id="phone-hangup" disabled>Hangup</button>
    <p>Status: <span id="phone-status">Idle</span></p>
  </section>

  <!--
    NOTE: This example uses bare module specifiers (e.g. "@telnyx/voice-cloudflare").
    You need a bundler (Vite, esbuild, webpack) or an import map to resolve them.
  -->
  <script type="module">
    import { TelnyxCallBridge } from "@telnyx/voice-cloudflare";
    import { VoiceClient } from "@cloudflare/voice/client";

    // -- Browser agent (default mic) --
    document.getElementById("browser-connect").onclick = async () => {
      // No audioInput -> VoiceClient uses its built-in mic capture
      const voiceClient = new VoiceClient({ agent: "my-voice-agent" });
      voiceClient.connect();
      voiceClient.addEventListener("connectionchange", async (connected) => {
        if (connected) {
          await voiceClient.startCall();
          document.getElementById("browser-connect").textContent = "Connected (Mic)";
        }
      });
    };

    // -- Phone bridge (separate TelnyxCallBridge, independent of VoiceClient) --
    let bridge;
    let credentialId;

    document.getElementById("phone-connect").onclick = async () => {
      document.getElementById("phone-status").textContent = "Fetching token...";

      // Fetch JWT from server
      const res = await fetch("/api/telnyx-token", { method: "POST" });
      const data = await res.json();
      credentialId = data.credentialId;

      // Create bridge manually (not as VoiceClient audioInput)
      bridge = new TelnyxCallBridge({ loginToken: data.token });
      await bridge.start();

      document.getElementById("phone-status").textContent = "Connected — ready to dial";
      document.getElementById("phone-dial").disabled = false;
    };

    document.getElementById("phone-dial").onclick = () => {
      if (!bridge) return;
      bridge.dial("+1234567890", "+10987654321");
      document.getElementById("phone-status").textContent = "Dialing...";
      document.getElementById("phone-hangup").disabled = false;
    };

    document.getElementById("phone-hangup").onclick = async () => {
      bridge?.hangup();
      bridge?.stop();
      // Clean up server-side credential
      if (credentialId) {
        await fetch("/api/telnyx-token", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credentialId }),
        });
      }
      document.getElementById("phone-status").textContent = "Disconnected";
      document.getElementById("phone-dial").disabled = true;
      document.getElementById("phone-hangup").disabled = true;
    };
  </script>
</body>
</html>`;
