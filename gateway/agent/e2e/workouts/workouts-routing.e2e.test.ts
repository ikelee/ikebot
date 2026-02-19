/**
 * Workouts full-flow e2e: classifier/router -> workouts agent with real model.
 * No mocks.
 *
 * Requires Ollama with qwen2.5:14b (`ollama pull qwen2.5:14b`). Uses non-streaming
 * for Ollama when tools are present (ollama-stream-fn) to avoid tool_calls
 * being dropped by Ollama's streaming API.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withTempHome } from "../../../../test/helpers/temp-home.js";
import { memoFilenameForIdentifier, parseWorkoutState } from "../../agents/workouts/state.js";
import { getReplyFromConfig } from "../../pipeline/reply.js";

const OLLAMA_BASE = "http://localhost:11434";
const MODEL = "qwen2.5:14b";
const TEST_USER = "testuser";
const FIXTURES_DIR = path.join(
  path.dirname(__filename),
  "..",
  "..",
  "agents",
  "workouts",
  "fixtures",
);
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
  // Workouts agent bootstrap: SOUL and TOOLS from workouts-agent template
  await fs.copyFile(
    path.join(TEMPLATES_DIR, "workouts-agent", "SOUL.md"),
    path.join(workspaceDir, "SOUL.md"),
  );
  await fs.copyFile(
    path.join(TEMPLATES_DIR, "workouts-agent", "TOOLS.md"),
    path.join(workspaceDir, "TOOLS.md"),
  );
}

function workoutConfig(workspaceDir: string, home: string) {
  return {
    agents: {
      defaults: {
        model: `ollama/${MODEL}`,
        routing: { enabled: true, classifierModel: `ollama/${MODEL}` },
        workspace: workspaceDir,
      },
      list: [
        { id: "main", default: true },
        {
          id: "workouts",
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

describe("workouts agent e2e – real model", () => {
  let canRun: boolean;

  beforeAll(async () => {
    const ollamaOk = await ollamaAvailable();
    const modelOk = ollamaOk && (await modelAvailable());
    canRun = modelOk;
    if (!ollamaOk) {
      console.warn(
        "[workouts e2e] Ollama not available at localhost:11434 – skipping. Run `ollama serve`.",
      );
    } else if (!modelOk) {
      console.warn(
        `[workouts e2e] Model ${MODEL} not found – skipping. Run \`ollama pull ${MODEL}\`.`,
      );
    }
  });

  it(
    "classifier routes to workouts, agent logs workout and updates workouts.json",
    { timeout: 180_000 },
    async () => {
      if (!canRun) {
        return;
      }
      await withTempHome(
        async (home) => {
          const workspaceDir = path.join(home, "openclaw");
          await setupWorkspaceWithFixtures(workspaceDir);

          const initialRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
          const initial = parseWorkoutState(initialRaw);
          const initialCount = (initial.workouts as unknown[])?.length ?? 0;

          await getReplyFromConfig(
            {
              Body: "log bench press 3x10 at 135",
              From: TEST_USER,
              To: TEST_USER,
              Provider: "whatsapp",
            },
            {},
            workoutConfig(workspaceDir, home),
          );

          const raw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
          const state = parseWorkoutState(raw);
          expect(state.workouts).toBeDefined();
          expect((state.workouts as unknown[]).length).toBeGreaterThan(initialCount);
          const last = (state.workouts as unknown[]).at(-1) as {
            exercises?: Array<{ name?: string; weight?: string }>;
          };
          expect(last?.exercises?.[0]?.name).toMatch(/bench|press/i);
          expect(last?.exercises?.[0]?.weight).toMatch(/135/);
        },
        { prefix: "workouts-e2e-" },
      );
    },
  );

  it("preserves notes and memo; agent can read restrictions", { timeout: 120_000 }, async () => {
    if (!canRun) {
      return;
    }
    await withTempHome(
      async (home) => {
        const workspaceDir = path.join(home, "openclaw");
        await setupWorkspaceWithFixtures(workspaceDir);

        await getReplyFromConfig(
          {
            Body: "what are my restrictions?",
            From: TEST_USER,
            To: TEST_USER,
            Provider: "whatsapp",
          },
          {},
          workoutConfig(workspaceDir, home),
        );

        const notes = await fs.readFile(path.join(workspaceDir, "workout-notes.txt"), "utf8");
        expect(notes).toContain("Right shoulder");
        expect(notes).toContain("knee recovery");

        const memoPath = path.join(workspaceDir, memoFilenameForIdentifier(TEST_USER));
        const memo = await fs.readFile(memoPath, "utf8");
        expect(memo).toContain("5/3/1");
        expect(memo).toContain("build muscle");
      },
      { prefix: "workouts-e2e-" },
    );
  });

  it("logs a new PR and updates personalBests in workouts.json", { timeout: 180_000 }, async () => {
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
            Body: "I hit a new bench PR today: 195 for 5 reps. Log it and update my personal best.",
            From: TEST_USER,
            To: TEST_USER,
            Provider: "whatsapp",
          },
          {},
          workoutConfig(workspaceDir, home),
        );

        const afterRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
        const afterState = parseWorkoutState(afterRaw);
        const afterBench = (
          afterState.personalBests?.["Bench Press"] as { weight?: number } | undefined
        )?.weight;

        expect(typeof afterBench).toBe("number");
        expect((afterBench ?? 0) >= (beforeBench ?? 0)).toBe(true);
        expect((afterState.workouts as unknown[])?.length ?? 0).toBeGreaterThan(
          (beforeState.workouts as unknown[])?.length ?? 0,
        );
      },
      { prefix: "workouts-e2e-" },
    );
  });
});
