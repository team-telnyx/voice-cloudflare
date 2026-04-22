import { WebSocketVoiceTransport } from "@cloudflare/voice/client";
import { TelnyxPhoneClient, createTelnyxVoiceConfig } from "@telnyx/voice-cloudflare";

const connectBtn = document.getElementById("connect") as HTMLButtonElement;
const disconnectBtn = document.getElementById("disconnect") as HTMLButtonElement;
const muteBtn = document.getElementById("mute") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;
const transcriptEl = document.getElementById("transcript") as HTMLElement;

let phoneClient: TelnyxPhoneClient | null = null;
let cleanup: (() => Promise<void>) | null = null;

connectBtn.addEventListener("click", async () => {
  statusEl.textContent = "Fetching token...";
  connectBtn.disabled = true;

  try {
    // 1. Fetch JWT + create call bridge
    const telnyx = await createTelnyxVoiceConfig({
      jwtEndpoint: "/api/telnyx-token",
      autoAnswer: true,
      debug: true,
    });
    cleanup = telnyx.cleanup;

    // 2. Create phone client — routes all audio through the bridge
    const transport = new WebSocketVoiceTransport({ agent: "voice-agent" });
    phoneClient = new TelnyxPhoneClient({
      transport,
      bridge: telnyx.bridge,
    });

    // 3. Listen for events
    phoneClient.addEventListener("statuschange", (status: string) => {
      statusEl.textContent = status;
    });

    phoneClient.addEventListener(
      "transcriptchange",
      (messages: { role: string; text: string }[]) => {
        transcriptEl.textContent = messages
          .map((m) => `${m.role}: ${m.text}`)
          .join("\n");
      }
    );

    phoneClient.addEventListener("error", (error: unknown) => {
      if (error) {
        console.error("[PhoneClient]", error);
        statusEl.textContent = `Error: ${error}`;
      }
    });

    // 4. Show the SIP username so the user knows what to call
    const sipUri = telnyx.sipUsername
      ? `sip:${telnyx.sipUsername}@sip.telnyx.com`
      : null;

    // 5. Connect, then start the call once WebSocket is open
    phoneClient.addEventListener("connectionchange", async (connected: boolean) => {
      if (connected) {
        await phoneClient!.startCall();
        statusEl.textContent = sipUri
          ? `Connected — call ${sipUri}`
          : "Connected — waiting for inbound call";
      }
    });

    phoneClient.connect();
    disconnectBtn.disabled = false;
    muteBtn.disabled = false;
  } catch (err) {
    console.error("Setup failed:", err);
    statusEl.textContent = `Setup failed: ${err}`;
    connectBtn.disabled = false;
  }
});

disconnectBtn.addEventListener("click", async () => {
  phoneClient?.disconnect();
  phoneClient = null;
  await cleanup?.();
  cleanup = null;
  statusEl.textContent = "Disconnected";
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  muteBtn.disabled = true;
  muteBtn.textContent = "Mute";
});

muteBtn.addEventListener("click", () => {
  if (!phoneClient) return;
  phoneClient.toggleMute();
  muteBtn.textContent = phoneClient.isMuted ? "Unmute" : "Mute";
});
