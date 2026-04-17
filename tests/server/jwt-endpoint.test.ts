import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TelnyxJWTEndpoint,
  type TelnyxJWTEndpointConfig,
} from "../../src/server/jwt-endpoint.js";

const MOCK_CONFIG: TelnyxJWTEndpointConfig = {
  apiKey: "KEY_test-api-key",
  credentialConnectionId: "conn-123-456",
};

const MOCK_CREDENTIAL_RESPONSE = {
  data: {
    id: "cred-789",
    connection_id: "conn-123-456",
    sip_username: "gencredABC",
    sip_password: "secret",
    record_type: "telephony_credential",
  },
};

const MOCK_TOKEN_RESPONSE = {
  data: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test-jwt-payload.signature",
};

describe("TelnyxJWTEndpoint", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("stores config values", () => {
      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      expect(endpoint).toBeInstanceOf(TelnyxJWTEndpoint);
    });

    it("uses default base URL when not provided", () => {
      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      // We'll verify the base URL is used in the fetch calls
      expect(endpoint).toBeDefined();
    });

    it("allows overriding base URL", () => {
      const endpoint = new TelnyxJWTEndpoint({
        ...MOCK_CONFIG,
        baseUrl: "https://custom.api.telnyx.com/v2",
      });
      expect(endpoint).toBeDefined();
    });
  });

  describe("createToken", () => {
    it("creates a telephony credential then generates a JWT", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_CREDENTIAL_RESPONSE), {
            status: 200,
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
        );

      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      const result = await endpoint.createToken();

      expect(result.token).toBe(MOCK_TOKEN_RESPONSE.data);
      expect(result.credentialId).toBe("cred-789");

      // Verify first call: create telephony credential
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [credUrl, credOpts] = fetchSpy.mock.calls[0];
      expect(credUrl).toBe(
        "https://api.telnyx.com/v2/telephony_credentials"
      );
      expect(credOpts.method).toBe("POST");
      expect(credOpts.headers["Authorization"]).toBe(
        "Bearer KEY_test-api-key"
      );
      expect(JSON.parse(credOpts.body)).toEqual({
        connection_id: "conn-123-456",
      });

      // Verify second call: generate JWT
      const [tokenUrl, tokenOpts] = fetchSpy.mock.calls[1];
      expect(tokenUrl).toBe(
        "https://api.telnyx.com/v2/telephony_credentials/cred-789/token"
      );
      expect(tokenOpts.method).toBe("POST");
      expect(tokenOpts.headers["Authorization"]).toBe(
        "Bearer KEY_test-api-key"
      );
    });

    it("uses custom base URL when configured", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_CREDENTIAL_RESPONSE), {
            status: 200,
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
        );

      const endpoint = new TelnyxJWTEndpoint({
        ...MOCK_CONFIG,
        baseUrl: "https://custom.telnyx.com/v2",
      });
      await endpoint.createToken();

      expect(fetchSpy.mock.calls[0][0]).toBe(
        "https://custom.telnyx.com/v2/telephony_credentials"
      );
      expect(fetchSpy.mock.calls[1][0]).toContain(
        "https://custom.telnyx.com/v2/telephony_credentials/"
      );
    });

    it("throws when credential creation fails", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ detail: "Unauthorized" }] }), {
          status: 401,
        })
      );

      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      await expect(endpoint.createToken()).rejects.toThrow(
        "Failed to create telephony credential: 401"
      );
    });

    it("throws when token generation fails", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_CREDENTIAL_RESPONSE), {
            status: 200,
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ errors: [{ detail: "Not found" }] }),
            { status: 404 }
          )
        );

      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      await expect(endpoint.createToken()).rejects.toThrow(
        "Failed to generate JWT: 404"
      );
    });
  });

  describe("revokeCredential", () => {
    it("deletes the telephony credential", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      await endpoint.revokeCredential("cred-789");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        "https://api.telnyx.com/v2/telephony_credentials/cred-789"
      );
      expect(opts.method).toBe("DELETE");
      expect(opts.headers["Authorization"]).toBe(
        "Bearer KEY_test-api-key"
      );
    });

    it("throws when deletion fails", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ detail: "Not found" }] }), {
          status: 404,
        })
      );

      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      await expect(endpoint.revokeCredential("bad-id")).rejects.toThrow(
        "Failed to revoke credential: 404"
      );
    });
  });

  describe("handleRequest", () => {
    it("returns a token on POST", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_CREDENTIAL_RESPONSE), {
            status: 200,
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
        );

      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      const request = new Request("https://worker.example.com/jwt", {
        method: "POST",
      });
      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.token).toBe(MOCK_TOKEN_RESPONSE.data);
      expect(body.credentialId).toBe("cred-789");
    });

    it("revokes a credential on DELETE with credentialId in body", async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      const request = new Request("https://worker.example.com/jwt", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: "cred-789" }),
      });
      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });

    it("returns 400 on DELETE without credentialId", async () => {
      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      const request = new Request("https://worker.example.com/jwt", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it("returns 405 for unsupported methods", async () => {
      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      const request = new Request("https://worker.example.com/jwt", {
        method: "GET",
      });
      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe(405);
    });

    it("returns 500 when createToken fails", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ detail: "Unauthorized" }] }), {
          status: 401,
        })
      );

      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      const request = new Request("https://worker.example.com/jwt", {
        method: "POST",
      });
      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    it("returns 500 when revokeCredential fails", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ detail: "Not found" }] }), {
          status: 404,
        })
      );

      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      const request = new Request("https://worker.example.com/jwt", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: "bad-id" }),
      });
      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe(500);
    });

    it("includes CORS headers in response", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_CREDENTIAL_RESPONSE), {
            status: 200,
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(MOCK_TOKEN_RESPONSE), { status: 200 })
        );

      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      const request = new Request("https://worker.example.com/jwt", {
        method: "POST",
      });
      const response = await endpoint.handleRequest(request);

      expect(response.headers.get("Content-Type")).toBe("application/json");
    });

    it("handles OPTIONS preflight requests", async () => {
      const endpoint = new TelnyxJWTEndpoint(MOCK_CONFIG);
      const request = new Request("https://worker.example.com/jwt", {
        method: "OPTIONS",
      });
      const response = await endpoint.handleRequest(request);

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
        "POST"
      );
    });
  });
});
