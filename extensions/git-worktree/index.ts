import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createWorktreeSwapTool } from "./tool.js";

const plugin = {
  id: "git-worktree",
  name: "Git Worktree",
  description:
    "Safe worktree branch-swap tool for sandboxed agents. Switches assigned worktree to target branch with strict validation.",
  register(api: OpenClawPluginApi) {
    api.registerTool((ctx) => createWorktreeSwapTool({ api, ctx }));
  },
};

export default plugin;
