import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
  context: {
    userId: "user_1",
    workspaceId: "ws_1",
    workspace: {} as Record<string, unknown>,
    role: "OWNER" as const,
  },
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: async () => workspace.context,
  canManageWorkspace: () => true,
}));

import { withZernioManagement } from "@/lib/zernio/route-handler";

const handler = withZernioManagement(async () => new Response("ok", { status: 200 }));

function post(url: string, origin?: string) {
  return new Request(url, {
    method: "POST",
    headers: origin ? { origin } : undefined,
  });
}

describe("Zernio management origin check", () => {
  beforeEach(() => {
    process.env.NEXTAUTH_URL = "https://nb-openreply.up.railway.app";
  });

  afterEach(() => {
    delete process.env.NEXTAUTH_URL;
  });

  it("allows the configured public origin when the proxied request.url is internal", async () => {
    // Behind the Railway proxy request.url keeps the internal address.
    const response = await handler(
      post("http://localhost:8080/api/zernio/settings", "https://nb-openreply.up.railway.app")
    );

    expect(response.status).toBe(200);
  });

  it("still allows the origin of request.url for direct access", async () => {
    const response = await handler(
      post("https://nb-openreply.up.railway.app/api/zernio/settings", "https://nb-openreply.up.railway.app")
    );

    expect(response.status).toBe(200);
  });

  it("rejects a foreign origin with 403", async () => {
    const response = await handler(
      post("http://localhost:8080/api/zernio/settings", "https://evil.example")
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid request origin." });
  });

  it("allows requests without an Origin header", async () => {
    const response = await handler(post("http://localhost:8080/api/zernio/settings"));

    expect(response.status).toBe(200);
  });

  it("skips the origin check for GET requests", async () => {
    const response = await handler(
      new Request("http://localhost:8080/api/zernio/settings", {
        method: "GET",
        headers: { origin: "https://evil.example" },
      })
    );

    expect(response.status).toBe(200);
  });
});
