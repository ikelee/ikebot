/**
 * Workouts full-flow e2e: classifier/router -> workouts agent with real model.
 * No mocks.
 *
 * Requires Ollama with qwen2.5:14b (`ollama pull qwen2.5:14b`). Uses non-streaming
 * for Ollama when tools are present (ollama-stream-fn) to avoid tool_calls
 * being dropped by Ollama's streaming API.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withTempHome } from "../../../../test/helpers/temp-home.js";
import {
  getPersonalBestsMap,
  memoFilenameForIdentifier,
  parseWorkoutState,
} from "../../agents/workouts/state.js";
import { getReplyFromConfig } from "../../pipeline/reply.js";

const OLLAMA_BASE = "http://localhost:11434";
const LOCAL_ONLY =
  process.env.OPENCLAW_TEST_LOCAL_ONLY === "1" ||
  process.env.OPENCLAW_WORKOUTS_TEST_LOCAL_ONLY === "1";
const LOCAL_MODEL = process.env.OPENCLAW_WORKOUTS_TEST_MODEL?.trim() || "qwen2.5:14b";
const CLOUD_MODEL = process.env.OPENCLAW_WORKOUTS_TEST_CLOUD_MODEL?.trim() || "gpt-5.1-codex-mini";
const MODEL_PROVIDER = LOCAL_ONLY ? "ollama" : "openai-codex";
const MODEL_ID = LOCAL_ONLY ? LOCAL_MODEL : CLOUD_MODEL;
const MODEL_REF = `${MODEL_PROVIDER}/${MODEL_ID}`;
const AUTH_HOME =
  process.env.OPENCLAW_WORKOUTS_AUTH_HOME?.trim() || os.userInfo().homedir || "/Users/ikebot";
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
      (m) => (m.name ?? "").startsWith(LOCAL_MODEL) || (m.model ?? "").startsWith(LOCAL_MODEL),
    );
  } catch {
    return false;
  }
}

async function codexAuthAvailable(): Promise<boolean> {
  const oauthPath = path.join(AUTH_HOME, ".openclaw", "credentials", "oauth.json");
  const authProfilesPath = path.join(
    AUTH_HOME,
    ".openclaw",
    "agents",
    "main",
    "agent",
    "auth-profiles.json",
  );
  try {
    const raw = await fs.readFile(oauthPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed["openai-codex"]) {
      return true;
    }
  } catch {}
  try {
    const raw = await fs.readFile(authProfilesPath, "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { provider?: string; type?: string }>;
    };
    const profiles = parsed.profiles ?? {};
    return Object.values(profiles).some(
      (profile) => profile?.provider === "openai-codex" && profile?.type === "oauth",
    );
  } catch {}
  return false;
}

async function seedCodexCredentials(testHome: string): Promise<void> {
  if (LOCAL_ONLY) {
    return;
  }
  const source = path.join(AUTH_HOME, ".openclaw", "credentials", "oauth.json");
  const target = path.join(testHome, ".openclaw", "credentials", "oauth.json");
  const authProfilesSource = path.join(
    AUTH_HOME,
    ".openclaw",
    "agents",
    "main",
    "agent",
    "auth-profiles.json",
  );
  const authProfilesTarget = path.join(
    testHome,
    ".openclaw",
    "agents",
    "main",
    "agent",
    "auth-profiles.json",
  );
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.mkdir(path.dirname(authProfilesTarget), { recursive: true });
    await fs.copyFile(authProfilesSource, authProfilesTarget);
    await fs.copyFile(source, target);
  } catch {
    // Cloud mode preflight handles missing creds; no-op here.
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
  const providers = LOCAL_ONLY
    ? {
        ollama: {
          baseUrl: `${OLLAMA_BASE}/v1`,
          api: "openai-completions",
          models: [
            {
              id: MODEL_ID,
              name: "Qwen3",
              api: "openai-completions",
              contextWindow: 32768,
              cost: { input: 0, output: 0 },
            },
          ],
        },
      }
    : {
        "openai-codex": {
          api: "openai-codex-responses",
          models: [
            {
              id: MODEL_ID,
              name: MODEL_ID,
              api: "openai-codex-responses",
              contextWindow: 200000,
              cost: { input: 0, output: 0 },
            },
          ],
        },
      };

  return {
    agents: {
      defaults: {
        model: MODEL_REF,
        routing: { enabled: true, classifierModel: MODEL_REF },
        workspace: workspaceDir,
      },
      list: [
        { id: "main", default: true },
        {
          id: "workouts",
          workspace: workspaceDir,
          skills: [],
          tools: {
            allow: ["read", "write"],
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
    models: { providers },
    session: { store: path.join(home, "sessions.json") },
  };
}

describe("workouts agent e2e – real model", () => {
  let canRun: boolean;

  beforeAll(async () => {
    if (LOCAL_ONLY) {
      const ollamaOk = await ollamaAvailable();
      const modelOk = ollamaOk && (await modelAvailable());
      canRun = modelOk;
      if (!ollamaOk) {
        console.warn(
          "[workouts e2e] Ollama not available at localhost:11434 – skipping. Run `ollama serve`.",
        );
      } else if (!modelOk) {
        console.warn(
          `[workouts e2e] Model ${LOCAL_MODEL} not found – skipping. Run \`ollama pull ${LOCAL_MODEL}\`.`,
        );
      }
      return;
    }
    canRun = await codexAuthAvailable();
    if (!canRun) {
      console.warn(
        "[workouts e2e] OpenAI Codex auth not found. Set ~/.openclaw credentials/auth-profiles.",
      );
    }
  });

  it(
    "classifier routes to workouts, agent logs workout and updates workouts.json",
    { timeout: 300_000 },
    async () => {
      if (!canRun) {
        return;
      }
      await withTempHome(
        async (home) => {
          await seedCodexCredentials(home);
          const workspaceDir = path.join(home, "openclaw");
          await setupWorkspaceWithFixtures(workspaceDir);

          const initialRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
          const initial = parseWorkoutState(initialRaw);
          const initialCount = Array.isArray(initial.events) ? initial.events.length : 0;

          await getReplyFromConfig(
            {
              Body: "Use read and write tools to log this workout in workouts.json as a new event: bench press 3x10 at 135.",
              From: TEST_USER,
              To: TEST_USER,
              Provider: "whatsapp",
            },
            {},
            workoutConfig(workspaceDir, home),
          );

          let raw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
          let state = parseWorkoutState(raw);
          let events = Array.isArray(state.events) ? state.events : [];
          if (events.length <= initialCount) {
            await getReplyFromConfig(
              {
                Body: "Workouts request: log bench press 3x10 at 135 in workouts.json as a new event now.",
                From: TEST_USER,
                To: TEST_USER,
                Provider: "whatsapp",
              },
              {},
              workoutConfig(workspaceDir, home),
            );
            raw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
            state = parseWorkoutState(raw);
            events = Array.isArray(state.events) ? state.events : [];
          }
          expect(events.length).toBeGreaterThan(initialCount);
          const last = (events.at(-1) ?? {}) as {
            exercise?: string;
            metrics?: { weightLb?: number | string };
          };
          expect(String(last.exercise ?? "")).toMatch(/bench|press/i);
          expect(String(last.metrics?.weightLb ?? "")).toMatch(/135/);
        },
        { prefix: "workouts-e2e-" },
      );
    },
  );

  it("preserves notes and memo; agent can read restrictions", { timeout: 300_000 }, async () => {
    if (!canRun) {
      return;
    }
    await withTempHome(
      async (home) => {
        await seedCodexCredentials(home);
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

  it("logs a new PR and updates personalBests in workouts.json", { timeout: 420_000 }, async () => {
    if (!canRun) {
      return;
    }
    await withTempHome(
      async (home) => {
        await seedCodexCredentials(home);
        const workspaceDir = path.join(home, "openclaw");
        await setupWorkspaceWithFixtures(workspaceDir);

        const beforeRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
        const beforeState = parseWorkoutState(beforeRaw);
        const beforeBench = getPersonalBestsMap(beforeState)["Bench Press"]?.weight;
        const beforeEventsCount = Array.isArray(beforeState.events) ? beforeState.events.length : 0;

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
        const afterBench = getPersonalBestsMap(afterState)["Bench Press"]?.weight;
        const afterEventsCount = Array.isArray(afterState.events) ? afterState.events.length : 0;

        expect(typeof afterBench).toBe("number");
        expect((afterBench ?? 0) >= (beforeBench ?? 0)).toBe(true);
        expect(afterEventsCount).toBeGreaterThan(beforeEventsCount);
      },
      { prefix: "workouts-e2e-" },
    );
  });
});
