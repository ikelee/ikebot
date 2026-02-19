/**
 * Workouts agent-level e2e: direct workouts agent path with real model.
 * Router/classifier is disabled in this suite.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withTempHome } from "../../../../test/helpers/temp-home.js";
import { getReplyFromConfig } from "../../pipeline/reply.js";
import { memoFilenameForIdentifier, parseWorkoutState } from "./state.js";

const OLLAMA_BASE = "http://localhost:11434";
const MODEL = "qwen2.5:14b";
const TEST_USER = "testuser";
const FIXTURES_DIR = path.join(path.dirname(__filename), "fixtures");
const TEMPLATES_DIR = path.join(
  path.dirname(__filename),
  "..",
  "..",
  "..",
  "..",
  "docs",
  "reference",
  "templates",
);

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

async function setupWorkspaceWithFixtures(workspaceDir: string) {
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.copyFile(
    path.join(FIXTURES_DIR, "workouts.json"),
    path.join(workspaceDir, "workouts.json"),
  );
  await fs.copyFile(
    path.join(FIXTURES_DIR, "workout-notes.txt"),
    path.join(workspaceDir, "workout-notes.txt"),
  );
  await fs.copyFile(
    path.join(FIXTURES_DIR, "workout-memo-testuser.md"),
    path.join(workspaceDir, memoFilenameForIdentifier(TEST_USER)),
  );
  await fs.copyFile(
    path.join(TEMPLATES_DIR, "workouts-agent", "SOUL.md"),
    path.join(workspaceDir, "SOUL.md"),
  );
  await fs.copyFile(
    path.join(TEMPLATES_DIR, "workouts-agent", "TOOLS.md"),
    path.join(workspaceDir, "TOOLS.md"),
  );
}

function workoutAgentConfig(workspaceDir: string, home: string) {
  return {
    agents: {
      defaults: {
        model: `ollama/${MODEL}`,
        routing: { enabled: false, classifierModel: `ollama/${MODEL}` },
        workspace: workspaceDir,
      },
      list: [
        {
          id: "workouts",
          default: true,
          workspace: workspaceDir,
          skills: [],
          tools: {
            files: {
              allowedPaths: [
                "workouts.json",
                "workout-notes.txt",
                "workout-memo-*.md",
                "history/",
                "*.json",
              ],
            },
          },
        },
      ],
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    models: {
      providers: {
        ollama: {
          baseUrl: `${OLLAMA_BASE}/v1`,
          api: "openai-completions",
          models: [
            {
              id: MODEL,
              name: "Qwen3",
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

describe("workouts agent-level e2e – real model", () => {
  let canRun = false;

  beforeAll(async () => {
    const ollamaOk = await ollamaAvailable();
    const modelOk = ollamaOk && (await modelAvailable());
    canRun = modelOk;
    if (!ollamaOk) {
      console.warn(
        "[workouts agent e2e] Ollama not available at localhost:11434 – skipping. Run `ollama serve`.",
      );
    } else if (!modelOk) {
      console.warn(
        `[workouts agent e2e] Model ${MODEL} not found – skipping. Run \`ollama pull ${MODEL}\`.`,
      );
    }
  });

  it("logs workout and updates workouts.json without router", { timeout: 180_000 }, async () => {
    if (!canRun) {
      return;
    }
    await withTempHome(
      async (home) => {
        const workspaceDir = path.join(home, "openclaw");
        await setupWorkspaceWithFixtures(workspaceDir);

        const beforeRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
        const beforeState = parseWorkoutState(beforeRaw);
        const beforeCount = (beforeState.workouts as unknown[])?.length ?? 0;

        await getReplyFromConfig(
          {
            Body: "Use read and write tools to append this workout to workouts.json: Bench Press 3x10 at 135 lb. Preserve existing keys.",
            From: TEST_USER,
            To: TEST_USER,
            Provider: "whatsapp",
          },
          {},
          workoutAgentConfig(workspaceDir, home),
        );

        const afterRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
        const afterState = parseWorkoutState(afterRaw);
        expect((afterState.workouts as unknown[])?.length ?? 0).toBeGreaterThan(beforeCount);
      },
      { prefix: "workouts-agent-e2e-" },
    );
  });

  it("updates personalBests when logging a PR", { timeout: 180_000 }, async () => {
    if (!canRun) {
      return;
    }
    await withTempHome(
      async (home) => {
        const workspaceDir = path.join(home, "openclaw");
        await setupWorkspaceWithFixtures(workspaceDir);

        const beforeRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
        const beforeState = parseWorkoutState(beforeRaw);
        const beforeBench = (
          beforeState.personalBests?.["Bench Press"] as { weight?: number } | undefined
        )?.weight;

        await getReplyFromConfig(
          {
            Body: "Use read and write tools to log this PR in workouts.json and update personalBests: Bench Press 195 for 5 reps.",
            From: TEST_USER,
            To: TEST_USER,
            Provider: "whatsapp",
          },
          {},
          workoutAgentConfig(workspaceDir, home),
        );

        const afterRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
        const afterState = parseWorkoutState(afterRaw);
        const afterBench = (
          afterState.personalBests?.["Bench Press"] as { weight?: number } | undefined
        )?.weight;

        expect(typeof afterBench).toBe("number");
        expect((afterBench ?? 0) >= (beforeBench ?? 0)).toBe(true);
      },
      { prefix: "workouts-agent-e2e-" },
    );
  });
});
