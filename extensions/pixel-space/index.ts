/**
 * Pixel Space OpenClaw extension.
 * Registers pixel_space.*, pixel_asset.*, and pixel_avatar.set tools that call the openclaw-pixel-agents sidecar API.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk";
import { pixelApiFetch, type PixelSpaceClientConfig } from "./src/client.js";

const DEFAULT_BASE_URL = "http://localhost:8080";

function getConfig(ctx: OpenClawPluginToolContext, pluginConfig: Record<string, unknown>): PixelSpaceClientConfig {
  const baseUrl =
    (pluginConfig.baseUrl as string)?.trim() ??
    process.env.OPENCLAW_PIXEL_AGENTS_URL?.trim() ??
    DEFAULT_BASE_URL;
  const apiKey =
    (pluginConfig.apiKey as string)?.trim() ??
    process.env.OPENCLAW_PIXEL_AGENTS_API_KEY ??
    process.env.PIXEL_AGENTS_API_KEY;
  return {
    baseUrl,
    apiKey,
    agentId: ctx.agentId?.trim() || undefined,
    workspaceDir: ctx.workspaceDir?.trim() || undefined,
  };
}

function parseTilesOrBounds(args: Record<string, unknown>): {
  tiles?: Array<{ col: number; row: number }>;
  bounds?: { col: number; row: number; w: number; h: number };
} {
  const tilesRaw = args.tiles;
  const boundsRaw = args.bounds;
  if (Array.isArray(tilesRaw) && tilesRaw.length > 0) {
    const tiles: Array<{ col: number; row: number }> = [];
    for (const t of tilesRaw) {
      if (t && typeof t === "object" && "col" in t && "row" in t) {
        const col = Number((t as { col?: unknown }).col);
        const row = Number((t as { row?: unknown }).row);
        if (Number.isFinite(col) && Number.isFinite(row)) {
          tiles.push({ col, row });
        }
      }
    }
    if (tiles.length > 0) {
      return { tiles };
    }
  }
  if (boundsRaw && typeof boundsRaw === "object" && "col" in boundsRaw && "row" in boundsRaw) {
    const b = boundsRaw as { col?: unknown; row?: unknown; w?: unknown; h?: unknown };
    const col = Number(b.col) || 0;
    const row = Number(b.row) || 0;
    const w = Number(b.w) ?? 1;
    const h = Number(b.h) ?? 1;
    if (Number.isFinite(col) && Number.isFinite(row) && Number.isFinite(w) && Number.isFinite(h)) {
      return { bounds: { col, row, w, h } };
    }
  }
  throw new Error("Provide tiles (array of {col, row}) or bounds ({col, row, w?, h?})");
}

function createPixelSpaceClaimTool(
  config: PixelSpaceClientConfig,
): AnyAgentTool {
  return {
    name: "pixel_space.claim",
    label: "Pixel Space Claim",
    description:
      "Claim unclaimed tiles in the shared pixel space. Provide tiles (array of {col, row}) or bounds ({col, row, w, h}). Use as: 'agent' (mine, default) or 'shared' (anyone can texture).",
    parameters: {
      type: "object",
      properties: {
        tiles: {
          type: "array",
          items: { type: "object", properties: { col: { type: "number" }, row: { type: "number" } }, required: ["col", "row"] },
          description: "Array of tile coordinates to claim.",
        },
        bounds: {
          type: "object",
          properties: { col: { type: "number" }, row: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
          description: "Rectangular region: col, row, w, h.",
        },
        as: {
          type: "string",
          enum: ["agent", "shared"],
          description: "Claim as agent (mine) or shared (anyone can texture). Default: agent.",
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      const args = rawArgs as Record<string, unknown>;
      const { tiles, bounds } = parseTilesOrBounds(args);
      const as = (readStringParam(args, "as") ?? "agent").toLowerCase();
      const asShared = as === "shared";
      const body = bounds
        ? { bounds: { col: bounds.col, row: bounds.row, w: bounds.w, h: bounds.h }, as: asShared ? "shared" : "agent" }
        : { tiles, as: asShared ? "shared" : "agent" };
      const res = await pixelApiFetch(config, "/api/claim", { method: "POST", body });
      return jsonResult(res);
    },
  };
}

function createPixelSpaceTextureTool(config: PixelSpaceClientConfig): AnyAgentTool {
  return {
    name: "pixel_space.texture",
    label: "Pixel Space Texture",
    description:
      "Set texture asset on claimed tiles. Provide tiles or bounds, and assetId from the texture catalog.",
    parameters: {
      type: "object",
      properties: {
        tiles: {
          type: "array",
          items: { type: "object", properties: { col: { type: "number" }, row: { type: "number" } }, required: ["col", "row"] },
        },
        bounds: {
          type: "object",
          properties: { col: { type: "number" }, row: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
        },
        assetId: { type: "string", description: "Texture asset ID from pixel_asset.query or pixel_asset.register." },
      },
      required: ["assetId"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      const args = rawArgs as Record<string, unknown>;
      const assetId = readStringParam(args, "assetId", { required: true });
      const { tiles, bounds } = parseTilesOrBounds(args);
      const body = bounds
        ? { bounds: { col: bounds.col, row: bounds.row, w: bounds.w, h: bounds.h }, assetId }
        : { tiles, assetId };
      const res = await pixelApiFetch(config, "/api/texture", { method: "POST", body });
      return jsonResult(res);
    },
  };
}

function createPixelSpaceReleaseTool(config: PixelSpaceClientConfig): AnyAgentTool {
  return {
    name: "pixel_space.release",
    label: "Pixel Space Release",
    description: "Release claim on tiles (back to unclaimed). Provide tiles or bounds.",
    parameters: {
      type: "object",
      properties: {
        tiles: {
          type: "array",
          items: { type: "object", properties: { col: { type: "number" }, row: { type: "number" } }, required: ["col", "row"] },
        },
        bounds: {
          type: "object",
          properties: { col: { type: "number" }, row: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      const args = rawArgs as Record<string, unknown>;
      const { tiles, bounds } = parseTilesOrBounds(args);
      const body = bounds
        ? { bounds: { col: bounds.col, row: bounds.row, w: bounds.w, h: bounds.h } }
        : { tiles };
      const res = await pixelApiFetch(config, "/api/release", { method: "POST", body });
      return jsonResult(res);
    },
  };
}

function createPixelSpaceShiftTool(config: PixelSpaceClientConfig): AnyAgentTool {
  return {
    name: "pixel_space.shift",
    label: "Pixel Space Shift",
    description:
      "Move a square section of tiles into unclaimed space. Source: {col, row, size}. Target: {col, row} (top-left of destination).",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "object",
          properties: { col: { type: "number" }, row: { type: "number" }, size: { type: "number" } },
          required: ["col", "row", "size"],
        },
        target: {
          type: "object",
          properties: { col: { type: "number" }, row: { type: "number" } },
          required: ["col", "row"],
        },
      },
      required: ["source", "target"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      const args = rawArgs as Record<string, unknown>;
      const src = args.source as { col?: unknown; row?: unknown; size?: unknown };
      const tgt = args.target as { col?: unknown; row?: unknown };
      if (!src || !tgt) {
        throw new Error("source and target are required");
      }
      const col = readNumberParam(src as Record<string, unknown>, "col", { required: true, integer: true });
      const row = readNumberParam(src as Record<string, unknown>, "row", { required: true, integer: true });
      const size = readNumberParam(src as Record<string, unknown>, "size", { required: true, integer: true });
      const tCol = readNumberParam(tgt as Record<string, unknown>, "col", { required: true, integer: true });
      const tRow = readNumberParam(tgt as Record<string, unknown>, "row", { required: true, integer: true });
      const body = {
        source: { col, row, size },
        target: { col: tCol, row: tRow },
      };
      const res = await pixelApiFetch(config, "/api/shift", { method: "POST", body });
      return jsonResult(res);
    },
  };
}

function createPixelSpaceQueryTool(config: PixelSpaceClientConfig): AnyAgentTool {
  return {
    name: "pixel_space.query",
    label: "Pixel Space Query",
    description:
      "Discover layout, ownership, and textures. Scope: mine (my tiles), all (full grid), region (with bounds), neighbors (tiles adjacent to my home).",
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["mine", "all", "region", "neighbors"],
          description: "Query scope. Default: mine.",
        },
        bounds: {
          type: "object",
          properties: { col: { type: "number" }, row: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
          description: "Required for scope=region.",
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      const args = rawArgs as Record<string, unknown>;
      const scope = readStringParam(args, "scope") ?? "mine";
      const bounds = args.bounds as { col?: unknown; row?: unknown; w?: unknown; h?: unknown } | undefined;
      const searchParams: Record<string, string> = { scope };
      if (bounds && typeof bounds === "object") {
        const col = Number(bounds.col);
        const row = Number(bounds.row);
        const w = Number(bounds.w);
        const h = Number(bounds.h);
        if (Number.isFinite(col)) searchParams.col = String(col);
        if (Number.isFinite(row)) searchParams.row = String(row);
        if (Number.isFinite(w)) searchParams.w = String(w);
        if (Number.isFinite(h)) searchParams.h = String(h);
      }
      const res = await pixelApiFetch(config, "/api/query", { searchParams });
      return jsonResult(res);
    },
  };
}

function createPixelAssetRegisterTool(config: PixelSpaceClientConfig): AnyAgentTool {
  return {
    name: "pixel_asset.register",
    label: "Pixel Asset Register",
    description:
      "Register a texture asset. Provide path (workspace file) or base64 PNG. description and tags are required. Valid dimensions: 16×16 or 32×32.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to PNG file in workspace (relative to workspace root)." },
        base64: { type: "string", description: "Base64-encoded PNG data." },
        name: { type: "string", description: "Optional asset name." },
        description: { type: "string", description: "Human/agent-readable description (required)." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for discovery, e.g. [\"floor\", \"wood\"] (required).",
        },
        tileable: { type: "boolean", description: "Whether the texture is tileable. Default: false." },
      },
      required: ["description", "tags"],
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      const args = rawArgs as Record<string, unknown>;
      const description = readStringParam(args, "description", { required: true });
      const tagsRaw = args.tags;
      const tags: string[] = [];
      if (Array.isArray(tagsRaw)) {
        for (const t of tagsRaw) {
          if (typeof t === "string" && t.trim()) tags.push(t.trim());
        }
      }
      if (tags.length === 0) {
        throw new Error("tags is required and must be a non-empty array");
      }
      let base64 = readStringParam(args, "base64");
      const filePath = readStringParam(args, "path");
      if (filePath && !base64) {
        const workspaceDir = config.workspaceDir ?? "";
        if (!workspaceDir) {
          throw new Error("path requires workspace; use base64 when workspace is unavailable");
        }
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);
        const buf = await fs.readFile(fullPath);
        base64 = buf.toString("base64");
      }
      if (!base64) {
        throw new Error("Provide path (workspace file) or base64");
      }
      const name = readStringParam(args, "name");
      const tileable = typeof args.tileable === "boolean" ? args.tileable : false;
      const body = { base64, name: name || undefined, description, tags, tileable };
      const res = await pixelApiFetch(config, "/api/asset/register", { method: "POST", body });
      return jsonResult(res);
    },
  };
}

function createPixelAssetQueryTool(config: PixelSpaceClientConfig): AnyAgentTool {
  return {
    name: "pixel_asset.query",
    label: "Pixel Asset Query",
    description:
      "Query the texture registry. Filter by tags, search description/name, limit results. Returns assets for use with pixel_space.texture.",
    parameters: {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags (e.g. [\"floor\"] or [\"wood\", \"dark\"]).",
        },
        search: { type: "string", description: "Match description or name (substring)." },
        limit: { type: "number", description: "Max results. Default: 50." },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      const args = rawArgs as Record<string, unknown>;
      const tagsRaw = args.tags;
      const tags: string[] = [];
      if (Array.isArray(tagsRaw)) {
        for (const t of tagsRaw) {
          if (typeof t === "string" && t.trim()) tags.push(t.trim());
        }
      }
      const search = readStringParam(args, "search");
      const limit = readNumberParam(args, "limit", { integer: true });
      const searchParams: Record<string, string | string[]> = {};
      if (tags.length > 0) searchParams.tags = tags;
      if (search) searchParams.search = search;
      if (limit != null && limit > 0) searchParams.limit = String(limit);
      const res = await pixelApiFetch(config, "/api/asset/query", { searchParams });
      return jsonResult(res);
    },
  };
}

function createPixelAvatarSetTool(config: PixelSpaceClientConfig): AnyAgentTool {
  return {
    name: "pixel_avatar.set",
    label: "Pixel Avatar Set",
    description:
      "Set the agent's avatar sprite sheet. PNG 112×96 px (7 frames × 16px wide, 3 rows × 32px). Layout: row 0=down, 1=up, 2=right; frames: walk1-3, type1-2, read1-2. Provide path or base64. Optional sessionKey for per-session avatar.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to PNG in workspace." },
        base64: { type: "string", description: "Base64-encoded PNG." },
        sessionKey: { type: "string", description: "Optional: per-session avatar; else applies to all sessions." },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, rawArgs) {
      const args = rawArgs as Record<string, unknown>;
      let base64 = readStringParam(args, "base64");
      const filePath = readStringParam(args, "path");
      if (filePath && !base64) {
        const workspaceDir = config.workspaceDir ?? "";
        if (!workspaceDir) {
          throw new Error("path requires workspace; use base64 when workspace is unavailable");
        }
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);
        const buf = await fs.readFile(fullPath);
        base64 = buf.toString("base64");
      }
      if (!base64) {
        throw new Error("Provide path or base64");
      }
      const sessionKey = readStringParam(args, "sessionKey");
      const body = { base64, sessionKey: sessionKey || undefined };
      const res = await pixelApiFetch(config, "/api/avatar/set", { method: "POST", body });
      return jsonResult(res);
    },
  };
}

const plugin = {
  id: "pixel-space",
  name: "Pixel Space",
  description:
    "Tools for agents to claim, texture, and query the shared pixel space (openclaw-pixel-agents sidecar).",
  configSchema: {},
  register(api: OpenClawPluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    api.registerTool(
      (ctx) => {
        const config = getConfig(ctx, pluginCfg);
        return [
          createPixelSpaceClaimTool(config),
          createPixelSpaceTextureTool(config),
          createPixelSpaceReleaseTool(config),
          createPixelSpaceShiftTool(config),
          createPixelSpaceQueryTool(config),
          createPixelAssetRegisterTool(config),
          createPixelAssetQueryTool(config),
          createPixelAvatarSetTool(config),
        ];
      },
      { optional: true },
    );
  },
};

export default plugin;
