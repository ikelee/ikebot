import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const isWindows = process.platform === "win32";
const localWorkers = Math.max(4, Math.min(16, os.cpus().length));
const ciWorkers = isWindows ? 2 : 3;

export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk": path.join(repoRoot, "gateway", "plugin-sdk", "index.ts"),
    },
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: isWindows ? 180_000 : 120_000,
    pool: "forks",
    maxWorkers: isCI ? ciWorkers : localWorkers,
    include: [
      "gateway/**/*.test.ts",
      "ui/tui/**/*.test.ts",
      "extensions/**/*.test.ts",
      "test/format-error.test.ts",
    ],
    setupFiles: ["test/setup.ts"],
    exclude: [
      "dist/**",
      "apps/macos/**",
      "apps/macos/.build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "dist/OpenClaw.app/**",
      "**/*.live.test.ts",
      "**/*.e2e.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 55,
        statements: 70,
      },
      include: ["gateway/**/*.ts"],
      exclude: [
        "gateway/**/*.test.ts",
        // Entrypoints and wiring (covered by CI smoke + manual/e2e flows).
        "gateway/entry.ts",
        "gateway/index.ts",
        "gateway/runtime.ts",
        "gateway/entry/cli/**",
        "gateway/entry/commands/**",
        "gateway/daemon/**",
        "gateway/extensibility/hooks/**",
        "gateway/macos/**",

        // Some agent integrations are intentionally validated via manual/e2e runs.
        "gateway/agents/model-scan.ts",
        "gateway/agents/pi-embedded-runner.ts",
        "gateway/agents/sandbox-paths.ts",
        "gateway/agents/sandbox.ts",
        "gateway/agents/skills-install.ts",
        "gateway/agents/pi-tool-definition-adapter.ts",
        "gateway/agents/tools/discord-actions*.ts",
        "gateway/agents/tools/slack-actions.ts",

        // Gateway server integration surfaces are intentionally validated via manual/e2e runs.
        "gateway/server/control-ui.ts",
        "gateway/server/server-bridge.ts",
        "gateway/server/server-channels.ts",
        "gateway/server/server-methods/config.ts",
        "gateway/server/server-methods/send.ts",
        "gateway/server/server-methods/skills.ts",
        "gateway/server/server-methods/talk.ts",
        "gateway/server/server-methods/web.ts",
        "gateway/server/server-methods/wizard.ts",

        // Process bridges are hard to unit-test in isolation.
        "gateway/server/call.ts",
        "gateway/process/tau-rpc.ts",
        "gateway/process/exec.ts",
        // Interactive UIs/flows are intentionally validated via manual/e2e runs.
        "ui/tui/**",
        "gateway/entry/wizard/**",
        // Channel surfaces are largely integration-tested (or manually validated).
        "gateway/discord/**",
        "gateway/imessage/**",
        "gateway/signal/**",
        "gateway/slack/**",
        "gateway/browser/**",
        "gateway/channels/web/**",
        "gateway/telegram/index.ts",
        "gateway/telegram/proxy.ts",
        "gateway/telegram/webhook-set.ts",
        "gateway/telegram/**",
        "gateway/webchat/**",
        "gateway/server/server.ts",
        "gateway/server/client.ts",
        "gateway/server/protocol/**",
        "gateway/infra/tailscale.ts",
      ],
    },
  },
});
