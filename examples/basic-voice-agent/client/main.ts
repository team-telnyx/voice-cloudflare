import { VoiceClient, WebSocketVoiceTransport } from "@cloudflare/voice/client";

const connectBtn = document.getElementById("connect") as HTMLButtonElement;
const disconnectBtn = document.getElementById("disconnect") as HTMLButtonElement;
const muteBtn = document.getElementById("mute") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;
const transcriptEl = document.getElementById("transcript") as HTMLElement;

let client: VoiceClient | null = null;
let muted = false;

connectBtn.addEventListener("click", () => {
  statusEl.textContent = "Connecting...";

  const transport = new WebSocketVoiceTransport({ agent: "voice-agent" });
  client = new VoiceClient({ transport });

  client.addEventListener("statuschange", (status: string) => {
    statusEl.textContent = status;
  });

  client.addEventListener(
    "transcriptchange",
    (messages: { role: string; text: string }[]) => {
      transcriptEl.textContent = messages
        .map((m) => `${m.role}: ${m.text}`)
        .join("\n");
    }
  );

  client.addEventListener("connectionchange", async (connected: boolean) => {
    if (connected) {
      await client!.startCall();
      statusEl.textContent = "Connected — speak into your microphone";
    }
  });

  client.addEventListener("error", (error: unknown) => {
    console.error("[VoiceClient]", error);
    statusEl.textContent = `Error: ${error}`;
  });

  client.connect();

  connectBtn.disabled = true;
  disconnectBtn.disabled = false;
  muteBtn.disabled = false;
});

disconnectBtn.addEventListener("click", () => {
  client?.disconnect();
  client = null;
  statusEl.textContent = "Disconnected";
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  muteBtn.disabled = true;
  muteBtn.textContent = "Mute";
  muted = false;
});

muteBtn.addEventListener("click", () => {
  if (!client) return;
  muted = !muted;
  client.setMuted(muted);
  muteBtn.textContent = muted ? "Unmute" : "Mute";
});
