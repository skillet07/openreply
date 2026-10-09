import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLongLivedToken, refreshLongLivedToken } from "@/lib/meta/client";

/**
 * Meta serves the Instagram long-lived token endpoints without a Graph API
 * version prefix. A versioned URL (`https://graph.instagram.com/v25.0/
 * access_token`) answers with `Unsupported request - method type: get`, so the
 * connect flow must hit the bare paths.
 */
function mockTokenResponse(accessToken: string, expiresIn = 5184000) {
  return vi.fn().mockResolvedValue({
    ok: true,
    url: "https://graph.instagram.com/access_token",
    json: async () => ({ access_token: accessToken, expires_in: expiresIn }),
  });
}

describe("Instagram long-lived token endpoints", () => {
  beforeEach(() => {
    process.env.INSTAGRAM_APP_SECRET = "app-secret";
    process.env.META_GRAPH_API_VERSION = "v25.0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges a short-lived token at the unversioned access_token endpoint", async () => {
    const fetchMock = mockTokenResponse("long-lived");
    vi.stubGlobal("fetch", fetchMock);

    const result = await getLongLivedToken("short-lived");

    const requested = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requested.toString()).not.toContain("/v25.0/");
    expect(requested.origin).toBe("https://graph.instagram.com");
    expect(requested.pathname).toBe("/access_token");
    expect(requested.searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(requested.searchParams.get("access_token")).toBe("short-lived");
    expect(result.accessToken).toBe("long-lived");
  });

  it("refreshes a long-lived token at the unversioned refresh_access_token endpoint", async () => {
    const fetchMock = mockTokenResponse("refreshed");
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshLongLivedToken("long-lived");

    const requested = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requested.toString()).not.toContain("/v25.0/");
    expect(requested.origin).toBe("https://graph.instagram.com");
    expect(requested.pathname).toBe("/refresh_access_token");
    expect(requested.searchParams.get("grant_type")).toBe("ig_refresh_token");
    expect(requested.searchParams.get("access_token")).toBe("long-lived");
    expect(result.accessToken).toBe("refreshed");
  });
});
