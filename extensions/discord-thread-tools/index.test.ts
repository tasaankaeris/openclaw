import { describe, expect, it, vi } from "vitest";
import plugin from "./index";

describe("discord-thread-read input validation", () => {
  async function setupReadTool() {
    let factory:
      | ((ctx: Record<string, unknown>) => Array<{ name: string; execute?: (id: string, args: unknown) => Promise<unknown> }>)
      | undefined;
    const api = {
      pluginConfig: {},
      registerTool: (f: typeof factory) => {
        factory = f;
      },
    } as unknown as {
      pluginConfig: Record<string, unknown>;
      registerTool: (
        f: (ctx: Record<string, unknown>) => Array<{ name: string; execute?: (id: string, args: unknown) => Promise<unknown> }>,
      ) => void;
    };

    plugin.register(api as any);
    expect(factory).toBeDefined();

    const ctx = {
      messageChannel: "discord",
      config: {
        channels: {
          discord: {
            accounts: {
              default: {
                enabled: true,
                token: "x",
              },
            },
          },
        },
      },
      logger: {
        debug: vi.fn(),
      },
    };
    const tools = factory!(ctx);
    const readTool = tools.find((tool) => tool.name === "discord-thread-read");
    expect(readTool?.execute).toBeDefined();
    return readTool!;
  }

  function installFetch() {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/messages?")) {
        return Promise.resolve({
          ok: true,
          json: async () => [],
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          id: "12345678901234567",
          type: 11,
          guild_id: "1469620697293652180",
          parent_id: "1469620697935511564",
        }),
      });
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;
  }

  it("rejects direction when cursor is not provided", async () => {
    const readTool = await setupReadTool();
    await expect(
      readTool.execute!("call-1", {
        accountId: "default",
        threadId: "12345678901234567",
        direction: "earlier",
      }),
    ).rejects.toThrow(/direction requires cursor/i);
  });

  it("rejects invalid aroundMessageId", async () => {
    const readTool = await setupReadTool();
    await expect(
      readTool.execute!("call-1", {
        accountId: "default",
        threadId: "12345678901234567",
        aroundMessageId: "not-a-snowflake",
      }),
    ).rejects.toThrow(/aroundMessageId must be a valid Discord message id/i);
  });

  it("rejects out-of-range limit", async () => {
    const readTool = await setupReadTool();
    await expect(
      readTool.execute!("call-1", {
        accountId: "default",
        threadId: "12345678901234567",
        limit: 101,
      }),
    ).rejects.toThrow(/limit must be between 1 and 100/i);
  });

  it("ignores contentMaxChars bounds when includeContent is false", async () => {
    const readTool = await setupReadTool();
    installFetch();
    const result = await readTool.execute!("call-1", {
      accountId: "default",
      threadId: "12345678901234567",
      includeContent: false,
      contentMaxChars: 99999,
    });
    expect((result as { details?: { ok?: boolean } }).details?.ok).toBe(true);
  });

  it("rejects cursor with aroundMessageId", async () => {
    const readTool = await setupReadTool();
    await expect(
      readTool.execute!("call-1", {
        accountId: "default",
        threadId: "12345678901234567",
        cursor: "abc",
        aroundMessageId: "12345678901234567",
      }),
    ).rejects.toThrow(/mutually exclusive/i);
  });

  it("rejects direction with aroundMessageId", async () => {
    const readTool = await setupReadTool();
    await expect(
      readTool.execute!("call-1", {
        accountId: "default",
        threadId: "12345678901234567",
        direction: "later",
        aroundMessageId: "12345678901234567",
      }),
    ).rejects.toThrow(/direction requires cursor|cannot be used with aroundmessageid/i);
  });
});
