/**
 * Calendar readiness e2e: calendar route should fail fast with setup instructions
 * when manual gog/config setup is incomplete.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withTempHome } from "../../../../test/helpers/temp-home.js";
import { resolveAgentWorkspaceDir } from "../../../runtime/agent-scope.js";
import { getReplyFromConfig } from "../../pipeline/reply.js";

const OLLAMA_BASE = "http://localhost:11434";
const MODEL = process.env.OPENCLAW_CALENDAR_TEST_MODEL?.trim() || "qwen2.5:14b";
const TEST_USER = "calendar-onboarding-e2e-user";

async function ollamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function modelAvailable(): Promise<boolean> {
  try {
    const tags = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    }).then((r) => r.json());
    const models = (tags?.models ?? []) as Array<{ name?: string; model?: string }>;
    return models.some(
      (m) => (m.name ?? "").startsWith(MODEL) || (m.model ?? "").startsWith(MODEL),
    );
  } catch {
    return false;
  }
}

function extractReplyText(reply: unknown): string {
  if (Array.isArray(reply)) {
    return extractReplyText(reply[0]);
  }
  if (!reply || typeof reply !== "object") {
    return "";
  }
  const text = (reply as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function buildConfig(home: string, mainWorkspace: string) {
  return {
    agents: {
      defaults: {
        model: `ollama/${MODEL}`,
        routing: { enabled: true, classifierModel: `ollama/${MODEL}` },
        workspace: mainWorkspace,
      },
      list: [
        { id: "main", default: true, workspace: mainWorkspace },
        {
          id: "calendar",
          skills: ["gog"],
          tools: { exec: { security: "allowlist", safeBins: ["gog"] } },
        },
      ],
    },
    channels: { webchat: { allowFrom: ["*"] } },
    models: {
      providers: {
        ollama: {
          baseUrl: `${OLLAMA_BASE}/v1`,
          api: "openai-completions",
          models: [
            {
              id: MODEL,
              name: "Qwen 2.5 14B",
              api: "openai-completions",
              contextWindow: 32768,
              cost: { input: 0, output: 0 },
            },
          ],
        },
      },
    },
    session: { store: path.join(home, "sessions.json") },
  };
}

describe("calendar readiness e2e", () => {
  let canRun = false;

  beforeAll(async () => {
    const ollamaOk = await ollamaAvailable();
    const modelOk = ollamaOk && (await modelAvailable());
    canRun = modelOk;
    if (!ollamaOk) {
      console.warn(
        "[calendar readiness e2e] Ollama not available at localhost:11434 – skipping. Run `ollama serve`.",
      );
    } else if (!modelOk) {
      console.warn(
        `[calendar readiness e2e] Model ${MODEL} not found – skipping. Run \`ollama pull ${MODEL}\`.`,
      );
    }
  });

  it(
    "returns setup instructions when calendar is not manually configured",
    { timeout: 120_000 },
    async () => {
      if (!canRun) {
        return;
      }
      await withTempHome(
        async (home) => {
          const mainWorkspace = path.join(home, "openclaw-main");
          await fs.mkdir(mainWorkspace, { recursive: true });
          const cfg = buildConfig(home, mainWorkspace);
          const calendarWorkspace = resolveAgentWorkspaceDir(cfg, "calendar");

          const first = await getReplyFromConfig(
            {
              Body: "what's on my calendar today?",
              From: TEST_USER,
              To: TEST_USER,
              Provider: "webchat",
            },
            {},
            cfg,
          );
          const firstText = extractReplyText(first).toLowerCase();
          expect(firstText).toContain("calendar agent is not ready yet");
          expect(firstText).toContain("gog auth add");
          expect(firstText).toContain("calendar-settings.json");

          await expect(
            fs.stat(path.join(calendarWorkspace, "calendar-settings.json")),
          ).resolves.toBeDefined();
          await expect(
            fs.stat(path.join(calendarWorkspace, "calendar-notes.txt")),
          ).resolves.toBeDefined();
        },
        { prefix: "calendar-readiness-e2e-" },
      );
    },
  );
});
