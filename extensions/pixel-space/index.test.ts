/**
 * Pixel Space extension tests.
 * Mocks the sidecar API client to verify tool behavior.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import plugin from "./index.js";

const pixelApiFetchMock = vi.fn();

vi.mock("./src/client.js", () => ({
  pixelApiFetch: (...args: unknown[]) => pixelApiFetchMock(...args),
}));

const mockCtx = {
  agentId: "test-agent",
  workspaceDir: "/tmp/workspace",
  sessionKey: "agent:main:main",
};

function getTools() {
  const tools: ReturnType<typeof plugin.register>[] = [];
  const api = {
    pluginConfig: {},
    registerTool: (factory: (ctx: typeof mockCtx) => unknown) => {
      const result = factory(mockCtx);
      const arr = Array.isArray(result) ? result : [result];
      tools.push(...(arr as never[]));
    },
  };
  plugin.register(api as never);
  return tools;
}

describe("pixel-space plugin", () => {
  beforeEach(() => {
    pixelApiFetchMock.mockReset();
  });

  test("plugin registers 8 tools", () => {
    const tools = getTools();
    expect(tools).toHaveLength(8);
    const names = tools.map((t) => t.name);
    expect(names).toContain("pixel_space.claim");
    expect(names).toContain("pixel_space.texture");
    expect(names).toContain("pixel_space.release");
    expect(names).toContain("pixel_space.shift");
    expect(names).toContain("pixel_space.query");
    expect(names).toContain("pixel_asset.register");
    expect(names).toContain("pixel_asset.query");
    expect(names).toContain("pixel_avatar.set");
  });

  test("pixel_space.claim sends correct request", async () => {
    pixelApiFetchMock.mockResolvedValue({ claimed: 4 });
    const tools = getTools();
    const claim = tools.find((t) => t.name === "pixel_space.claim")!;
    const result = await claim.execute!("tid", {
      tiles: [{ col: 0, row: 0 }, { col: 1, row: 0 }],
      as: "agent",
    });
    expect(pixelApiFetchMock).toHaveBeenCalledWith(
      expect.anything(),
      "/api/claim",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          tiles: [{ col: 0, row: 0 }, { col: 1, row: 0 }],
          as: "agent",
        }),
      }),
    );
    expect(result).toBeDefined();
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
    expect(content?.[0]?.text).toContain("claimed");
  });

  test("pixel_space.claim with bounds", async () => {
    pixelApiFetchMock.mockResolvedValue({ claimed: 16 });
    const tools = getTools();
    const claim = tools.find((t) => t.name === "pixel_space.claim")!;
    await claim.execute!("tid", {
      bounds: { col: 0, row: 0, w: 4, h: 4 },
      as: "shared",
    });
    expect(pixelApiFetchMock).toHaveBeenCalledWith(
      expect.anything(),
      "/api/claim",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          bounds: { col: 0, row: 0, w: 4, h: 4 },
          as: "shared",
        }),
      }),
    );
  });

  test("pixel_space.claim requires tiles or bounds", async () => {
    const tools = getTools();
    const claim = tools.find((t) => t.name === "pixel_space.claim")!;
    await expect(claim.execute!("tid", {})).rejects.toThrow("Provide tiles");
  });

  test("pixel_space.texture sends correct request", async () => {
    pixelApiFetchMock.mockResolvedValue({ status: "ok" });
    const tools = getTools();
    const texture = tools.find((t) => t.name === "pixel_space.texture")!;
    await texture.execute!("tid", {
      tiles: [{ col: 1, row: 1 }],
      assetId: "asset-123",
    });
    expect(pixelApiFetchMock).toHaveBeenCalledWith(
      expect.anything(),
      "/api/texture",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          tiles: [{ col: 1, row: 1 }],
          assetId: "asset-123",
        }),
      }),
    );
  });

  test("pixel_space.texture requires assetId", async () => {
    const tools = getTools();
    const texture = tools.find((t) => t.name === "pixel_space.texture")!;
    await expect(texture.execute!("tid", { tiles: [{ col: 0, row: 0 }] })).rejects.toThrow();
  });

  test("pixel_space.release sends correct request", async () => {
    pixelApiFetchMock.mockResolvedValue({ status: "ok" });
    const tools = getTools();
    const release = tools.find((t) => t.name === "pixel_space.release")!;
    await release.execute!("tid", { bounds: { col: 0, row: 0, w: 2, h: 2 } });
    expect(pixelApiFetchMock).toHaveBeenCalledWith(
      expect.anything(),
      "/api/release",
      expect.objectContaining({
        method: "POST",
        body: { bounds: { col: 0, row: 0, w: 2, h: 2 } },
      }),
    );
  });

  test("pixel_space.shift sends correct request", async () => {
    pixelApiFetchMock.mockResolvedValue({ status: "ok" });
    const tools = getTools();
    const shift = tools.find((t) => t.name === "pixel_space.shift")!;
    await shift.execute!("tid", {
      source: { col: 0, row: 0, size: 4 },
      target: { col: 10, row: 10 },
    });
    expect(pixelApiFetchMock).toHaveBeenCalledWith(
      expect.anything(),
      "/api/shift",
      expect.objectContaining({
        method: "POST",
        body: {
          source: { col: 0, row: 0, size: 4 },
          target: { col: 10, row: 10 },
        },
      }),
    );
  });

  test("pixel_space.query sends correct request", async () => {
    pixelApiFetchMock.mockResolvedValue({ tiles: [], agentHomes: [] });
    const tools = getTools();
    const query = tools.find((t) => t.name === "pixel_space.query")!;
    await query.execute!("tid", { scope: "neighbors" });
    expect(pixelApiFetchMock).toHaveBeenCalledWith(
      expect.anything(),
      "/api/query",
      expect.objectContaining({
        searchParams: expect.objectContaining({ scope: "neighbors" }),
      }),
    );
  });

  test("pixel_asset.register with base64 sends correct request", async () => {
    pixelApiFetchMock.mockResolvedValue({ assetId: "new-asset-id" });
    const tools = getTools();
    const reg = tools.find((t) => t.name === "pixel_asset.register")!;
    await reg.execute!("tid", {
      base64: "iVBORw0KGgo=",
      description: "Wood floor",
      tags: ["floor", "wood"],
    });
    expect(pixelApiFetchMock).toHaveBeenCalledWith(
      expect.anything(),
      "/api/asset/register",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          base64: "iVBORw0KGgo=",
          description: "Wood floor",
          tags: ["floor", "wood"],
        }),
      }),
    );
  });

  test("pixel_asset.register requires description and tags", async () => {
    const tools = getTools();
    const reg = tools.find((t) => t.name === "pixel_asset.register")!;
    await expect(reg.execute!("tid", { base64: "x", description: "x" })).rejects.toThrow("tags");
    await expect(reg.execute!("tid", { base64: "x", tags: ["a"] })).rejects.toThrow("description");
  });

  test("pixel_asset.query sends correct request", async () => {
    pixelApiFetchMock.mockResolvedValue({ assets: [] });
    const tools = getTools();
    const query = tools.find((t) => t.name === "pixel_asset.query")!;
    await query.execute!("tid", { tags: ["floor"], search: "wood", limit: 10 });
    expect(pixelApiFetchMock).toHaveBeenCalledWith(
      expect.anything(),
      "/api/asset/query",
      expect.objectContaining({
        searchParams: expect.objectContaining({
          tags: ["floor"],
          search: "wood",
          limit: "10",
        }),
      }),
    );
  });

  test("pixel_avatar.set with base64 sends correct request", async () => {
    pixelApiFetchMock.mockResolvedValue({ avatarId: "avatar-1" });
    const tools = getTools();
    const set = tools.find((t) => t.name === "pixel_avatar.set")!;
    await set.execute!("tid", { base64: "iVBORw0KGgo=" });
    expect(pixelApiFetchMock).toHaveBeenCalledWith(
      expect.anything(),
      "/api/avatar/set",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({ base64: "iVBORw0KGgo=" }),
      }),
    );
  });

  test("pixel_avatar.set requires path or base64", async () => {
    const tools = getTools();
    const set = tools.find((t) => t.name === "pixel_avatar.set")!;
    await expect(set.execute!("tid", {})).rejects.toThrow("Provide path or base64");
  });
});
