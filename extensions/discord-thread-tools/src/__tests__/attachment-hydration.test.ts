import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateAttachmentFilePath } from "../discord-thread-helpers";

describe("validateAttachmentFilePath", () => {
  it("rejects data URLs (path-only attachments)", () => {
    expect(() =>
      validateAttachmentFilePath("data:image/png;base64,iVBORw0KGgo="),
    ).toThrow(/filesystem path only.*Base64\/data URLs are not supported/i);
    expect(() => validateAttachmentFilePath("DATA:text/plain;base64,SGVsbG8=")).toThrow(
      /filesystem path only.*Base64\/data URLs are not supported/i,
    );
  });

  it("rejects long base64-looking strings without path separators", () => {
    const longBase64 = "a".repeat(300);
    expect(() => validateAttachmentFilePath(longBase64)).toThrow(
      /Base64 or inline data is not supported/i,
    );
  });

  it("allows path under /workspace", () => {
    const p = path.sep === "/" ? "/workspace/foo.txt" : path.join(path.resolve("/workspace"), "foo.txt");
    const resolved = path.resolve(p);
    if (!resolved.includes("workspace")) {
      return; // skip on platforms where /workspace resolves elsewhere
    }
    expect(validateAttachmentFilePath(p)).toBe(resolved);
  });

  it("rejects path outside allowed roots", () => {
    expect(() => validateAttachmentFilePath("/etc/passwd")).toThrow(/not in an allowed location/);
  });

  it("rejects path that escapes root via ..", () => {
    const bad = path.join(path.resolve("/workspace"), "..", "etc", "passwd");
    expect(() => validateAttachmentFilePath(bad)).toThrow(/not in an allowed location/);
  });

  it("resolves relative path under workspaceRoot when provided", () => {
    const workspaceRoot = path.join(path.sep, "root", "agent-workspace");
    const resolved = validateAttachmentFilePath("tmp/ex-sessions/sessions.json", {
      workspaceRoot,
    });
    expect(resolved).toBe(path.resolve(workspaceRoot, "tmp", "ex-sessions", "sessions.json"));
  });

  it("rejects path that escapes workspaceRoot when workspaceRoot is set", () => {
    const workspaceRoot = path.join(path.sep, "root", "agent-workspace");
    expect(() =>
      validateAttachmentFilePath("../../../etc/passwd", { workspaceRoot }),
    ).toThrow(/must stay inside the workspace/);
  });

  it("resolves /workspace/... to workspaceRoot when sandboxed and workspaceRoot set", () => {
    const workspaceRoot = path.join(path.sep, "root", ".openclaw", "workspace-data");
    const resolved = validateAttachmentFilePath("/workspace/tmp/ex-sessions/sessions.json", {
      workspaceRoot,
      sandboxed: true,
    });
    expect(resolved).toBe(
      path.resolve(workspaceRoot, "tmp", "ex-sessions", "sessions.json"),
    );
  });

  it("does not map /workspace/... when not sandboxed; path must be under workspaceRoot", () => {
    const workspaceRoot = path.join(path.sep, "root", ".openclaw", "workspace-data");
    expect(() =>
      validateAttachmentFilePath("/workspace/tmp/file.json", {
        workspaceRoot,
        sandboxed: false,
      }),
    ).toThrow(/must stay inside the workspace/);
  });

  describe("agent data (host workspace /root/.openclaw/workspace-data, sandbox at /workspace)", () => {
    const workspaceDataRoot = path.join(path.sep, "root", ".openclaw", "workspace-data");

    it("sandboxed: accepts relative path", () => {
      const resolved = validateAttachmentFilePath("tmp/file.json", {
        workspaceRoot: workspaceDataRoot,
        sandboxed: true,
      });
      expect(resolved).toBe(path.resolve(workspaceDataRoot, "tmp", "file.json"));
    });

    it("sandboxed: accepts /workspace/... path", () => {
      const resolved = validateAttachmentFilePath("/workspace/tmp/file.json", {
        workspaceRoot: workspaceDataRoot,
        sandboxed: true,
      });
      expect(resolved).toBe(path.resolve(workspaceDataRoot, "tmp", "file.json"));
    });

    it("sandboxed: accepts host-absolute path under root", () => {
      const abs = path.join(workspaceDataRoot, "tmp", "file.json");
      const resolved = validateAttachmentFilePath(abs, {
        workspaceRoot: workspaceDataRoot,
        sandboxed: true,
      });
      expect(resolved).toBe(abs);
    });

    it("not sandboxed: accepts relative path", () => {
      const resolved = validateAttachmentFilePath("tmp/file.json", {
        workspaceRoot: workspaceDataRoot,
        sandboxed: false,
      });
      expect(resolved).toBe(path.resolve(workspaceDataRoot, "tmp", "file.json"));
    });

    it("not sandboxed: rejects /workspace/... path", () => {
      expect(() =>
        validateAttachmentFilePath("/workspace/tmp/file.json", {
          workspaceRoot: workspaceDataRoot,
          sandboxed: false,
        }),
      ).toThrow(/must stay inside the workspace/);
    });

    it("not sandboxed: accepts host-absolute path under root", () => {
      const abs = path.join(workspaceDataRoot, "tmp", "file.json");
      const resolved = validateAttachmentFilePath(abs, {
        workspaceRoot: workspaceDataRoot,
        sandboxed: false,
      });
      expect(resolved).toBe(abs);
    });
  });

  describe("agent kaylee (host workspace /root/.openclaw/agents/kaylee/workspace, sandbox at /workspace)", () => {
    const kayleeWorkspaceRoot = path.join(path.sep, "root", ".openclaw", "agents", "kaylee", "workspace");

    it("sandboxed: accepts relative path", () => {
      const resolved = validateAttachmentFilePath("tmp/file.json", {
        workspaceRoot: kayleeWorkspaceRoot,
        sandboxed: true,
      });
      expect(resolved).toBe(path.resolve(kayleeWorkspaceRoot, "tmp", "file.json"));
    });

    it("sandboxed: accepts /workspace/... path", () => {
      const resolved = validateAttachmentFilePath("/workspace/tmp/file.json", {
        workspaceRoot: kayleeWorkspaceRoot,
        sandboxed: true,
      });
      expect(resolved).toBe(path.resolve(kayleeWorkspaceRoot, "tmp", "file.json"));
    });

    it("sandboxed: accepts host-absolute path under root", () => {
      const abs = path.join(kayleeWorkspaceRoot, "tmp", "file.json");
      const resolved = validateAttachmentFilePath(abs, {
        workspaceRoot: kayleeWorkspaceRoot,
        sandboxed: true,
      });
      expect(resolved).toBe(abs);
    });

    it("not sandboxed: accepts relative path", () => {
      const resolved = validateAttachmentFilePath("tmp/file.json", {
        workspaceRoot: kayleeWorkspaceRoot,
        sandboxed: false,
      });
      expect(resolved).toBe(path.resolve(kayleeWorkspaceRoot, "tmp", "file.json"));
    });

    it("not sandboxed: rejects /workspace/... path", () => {
      expect(() =>
        validateAttachmentFilePath("/workspace/tmp/file.json", {
          workspaceRoot: kayleeWorkspaceRoot,
          sandboxed: false,
        }),
      ).toThrow(/must stay inside the workspace/);
    });

    it("not sandboxed: accepts host-absolute path under root", () => {
      const abs = path.join(kayleeWorkspaceRoot, "tmp", "file.json");
      const resolved = validateAttachmentFilePath(abs, {
        workspaceRoot: kayleeWorkspaceRoot,
        sandboxed: false,
      });
      expect(resolved).toBe(abs);
    });
  });

  describe("validateAttachmentFilePath with custom containerWorkdir (sandbox.docker.workdir)", () => {
    const workspaceRoot = path.join(path.sep, "root", "agent-workspace");

    it("maps container workdir path to workspaceRoot when containerWorkdir is set", () => {
      const resolved = validateAttachmentFilePath("/work/tmp/file.png", {
        workspaceRoot,
        sandboxed: true,
        containerWorkdir: "/work",
      });
      expect(resolved).toBe(path.resolve(workspaceRoot, "tmp", "file.png"));
    });

    it("does not map /workspace/... when containerWorkdir is /work", () => {
      expect(() =>
        validateAttachmentFilePath("/workspace/tmp/file.png", {
          workspaceRoot,
          sandboxed: true,
          containerWorkdir: "/work",
        }),
      ).toThrow(/must stay inside the workspace/);
    });

    it("maps exact container workdir to workspaceRoot", () => {
      const resolved = validateAttachmentFilePath("/work", {
        workspaceRoot,
        sandboxed: true,
        containerWorkdir: "/work",
      });
      expect(resolved).toBe(path.resolve(workspaceRoot));
    });
  });
});
