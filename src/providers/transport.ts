/**
 * Telnyx transport provider for the Cloudflare Agents SDK.
 *
 * Implements the TransportProvider interface from @cloudflare/voice,
 * providing WebRTC + SIP connectivity for inbound/outbound phone calls.
 *
 * This is the highest-value provider — telephony is the hardest transport
 * to build and it's Telnyx's core competency. Bridges Cloudflare voice
 * agents to real phone networks via SIP.
 */

import { TelnyxClient, type TelnyxClientConfig } from "./client.js";

export interface TelnyxTransportConfig extends TelnyxClientConfig {
  /** SIP connection ID for outbound calls */
  sipConnectionId?: string;
  /** WebRTC credential ID for browser connections */
  webrtcCredentialId?: string;
}

export class TelnyxTransport {
  private client: TelnyxClient;
  private sipConnectionId?: string;
  private webrtcCredentialId?: string;

  constructor(config: TelnyxTransportConfig) {
    this.client = new TelnyxClient(config);
    this.sipConnectionId = config.sipConnectionId;
    this.webrtcCredentialId = config.webrtcCredentialId;
  }

  // TODO: Implement TransportProvider interface from @cloudflare/voice
  // - Inbound: SIP → WebRTC → voice pipeline (PSTN calls reaching the agent)
  // - Outbound: voice pipeline → WebRTC → SIP → PSTN (agent making calls)
  // - Call lifecycle: setup, answer, hangup, DTMF
  // - Audio transport: bidirectional streaming
}
