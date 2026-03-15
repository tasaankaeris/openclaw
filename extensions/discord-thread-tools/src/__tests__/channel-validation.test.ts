import { describe, expect, it, vi } from "vitest";
import {
  assertThreadBelongsToAllowedParent,
  normalizeReactionEmoji,
} from "../discord-thread-helpers";

describe("assertThreadBelongsToAllowedParent", () => {
  it("passes when guild and parent are allowed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "thread-1",
        type: 11,
        guild_id: "guild-1",
        parent_id: "parent-1",
      }),
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    await expect(
      assertThreadBelongsToAllowedParent({
        token: "t",
        threadId: "thread-1",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when guild does not match", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "thread-1",
        type: 11,
        guild_id: "guild-2",
        parent_id: "parent-1",
      }),
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    await expect(
      assertThreadBelongsToAllowedParent({
        token: "t",
        threadId: "thread-1",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
      }),
    ).rejects.toThrowError(/is in guild guild-2, not allowed guild guild-1/);
  });

  it("throws when parent channel is not allowed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "thread-1",
        type: 11,
        guild_id: "guild-1",
        parent_id: "other-parent",
      }),
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    await expect(
      assertThreadBelongsToAllowedParent({
        token: "t",
        threadId: "thread-1",
        allowedGuildId: "guild-1",
        allowedParentChannelIds: ["parent-1"],
      }),
    ).rejects.toThrowError(/which is not in the allowed parent channel list/);
  });

  it("throws when channel is not a thread (e.g. text channel type 0)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "chan-1",
        type: 0,
        guild_id: "guild-1",
        parent_id: null,
      }),
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    await expect(
      assertThreadBelongsToAllowedParent({
        token: "t",
        threadId: "chan-1",
      }),
    ).rejects.toThrowError(/is not a thread.*type 0/);
  });
});

describe("normalizeReactionEmoji", () => {
  it("encodes unicode emoji for URL", () => {
    expect(normalizeReactionEmoji("✅")).toBe("%E2%9C%85");
  });

  it("strips variation selectors from unicode emoji", () => {
    // ⭐️ = U+2B50 U+FE0F; Discord expects U+2B50 only
    expect(normalizeReactionEmoji("⭐️")).toBe("%E2%AD%90");
  });

  it("converts custom emoji format to name:id and encodes", () => {
    expect(normalizeReactionEmoji("<:party_blob:123>")).toBe("party_blob%3A123");
    expect(normalizeReactionEmoji("<a:custom_animated:456>")).toBe("custom_animated%3A456");
  });

  it("throws when emoji is empty", () => {
    expect(() => normalizeReactionEmoji("")).toThrow(/emoji is required/);
    expect(() => normalizeReactionEmoji("   ")).toThrow(/emoji is required/);
  });
});
