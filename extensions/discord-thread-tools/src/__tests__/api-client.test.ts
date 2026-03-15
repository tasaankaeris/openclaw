import { describe, expect, it, vi } from "vitest";
import { discordFetch } from "../discord-thread-helpers";

describe("discordFetch", () => {
  it("retries on 503 with Retry-After and succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: { get: () => "0" },
          text: async () => "service unavailable",
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true }),
      });
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    const res = await discordFetch("bot-token", "https://discord.com/api/v10/channels/x", {
      method: "GET",
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("does not retry non-idempotent POST on 503", async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      calls += 1;
      return Promise.resolve({
        ok: false,
        status: 503,
        headers: { get: () => "0" },
        text: async () => "service unavailable",
      });
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    const res = await discordFetch("bot-token", "https://discord.com/api/v10/channels/x/messages", {
      method: "POST",
      body: JSON.stringify({ content: "hello" }),
    });
    expect(res.status).toBe(503);
    expect(calls).toBe(1);
  });
});
