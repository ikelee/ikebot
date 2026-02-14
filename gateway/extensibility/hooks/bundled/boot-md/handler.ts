import type { CliDeps } from "../../../../entry/cli/deps.js";
import type { OpenClawConfig } from "../../../../infra/config/config.js";
import type { HookHandler } from "../../hooks.js";
import { createDefaultDeps } from "../../../../entry/cli/deps.js";
import { runBootOnce } from "../../../../server/boot.js";

type BootHookContext = {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  deps?: CliDeps;
};

const runBootChecklist: HookHandler = async (event) => {
  if (event.type !== "gateway" || event.action !== "startup") {
    return;
  }

  const context = (event.context ?? {}) as BootHookContext;
  if (!context.cfg || !context.workspaceDir) {
    return;
  }

  const deps = context.deps ?? createDefaultDeps();
  await runBootOnce({ cfg: context.cfg, deps, workspaceDir: context.workspaceDir });
};

export default runBootChecklist;
