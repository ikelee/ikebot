/**
 * Workouts agent-level e2e: direct workouts agent path with real model.
 * Router/classifier is disabled in this suite.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../../../test/helpers/temp-home.js";
import { getReplyFromConfig } from "../../pipeline/reply.js";
import { memoFilenameForIdentifier, parseWorkoutState } from "./state.js";

const OLLAMA_BASE = "http://localhost:11434";
const LOCAL_ONLY =
  process.env.OPENCLAW_TEST_LOCAL_ONLY === "1" ||
  process.env.OPENCLAW_WORKOUTS_TEST_LOCAL_ONLY === "1";
const LOCAL_MODEL = process.env.OPENCLAW_WORKOUTS_TEST_MODEL?.trim() || "qwen2.5:14b";
const CLOUD_MODEL = process.env.OPENCLAW_WORKOUTS_TEST_CLOUD_MODEL?.trim() || "gpt-5.3-codex-spark";
const MODEL_PROVIDER = LOCAL_ONLY ? "ollama" : "openai-codex";
const MODEL_ID = LOCAL_ONLY ? LOCAL_MODEL : CLOUD_MODEL;
const MODEL_REF = `${MODEL_PROVIDER}/${MODEL_ID}`;
const EMIT_MODEL_LOGS = process.env.OPENCLAW_TEST_EMIT_MODEL_LOGS === "1";
const AUTH_HOME =
  process.env.OPENCLAW_WORKOUTS_AUTH_HOME?.trim() || os.userInfo().homedir || "/Users/ikebot";
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

async function setupWorkspaceWithFixtures(workspaceDir: string, senderId = TEST_USER) {
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
    path.join(workspaceDir, memoFilenameForIdentifier(senderId)),
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
  const providers = LOCAL_ONLY
    ? {
        ollama: {
          baseUrl: `${OLLAMA_BASE}/v1`,
          api: "openai-completions",
          models: [
            {
              id: MODEL_ID,
              name: "Qwen 2.5",
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
        routing: { enabled: false, classifierModel: "ollama/qwen2.5:14b" },
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
      providers,
    },
    session: { store: path.join(home, "sessions.json") },
  };
}

function resolvePersonalBestWeight(
  strengthPersonalBests: Record<string, unknown> | undefined,
  exercise: string,
): number | undefined {
  if (!strengthPersonalBests || typeof strengthPersonalBests !== "object") {
    return undefined;
  }
  const normalize = (value: string) =>
    value
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const target = normalize(exercise);
  const key = Object.keys(strengthPersonalBests).find(
    (candidate) => normalize(candidate) === target,
  );
  if (!key) {
    return undefined;
  }
  const entry = strengthPersonalBests[key];
  if (typeof entry === "number") {
    return Number.isFinite(entry) ? entry : undefined;
  }
  if (typeof entry === "string") {
    const parsed = Number.parseFloat(entry);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const weight = (entry as { weight?: unknown }).weight;
  if (typeof weight === "number") {
    return Number.isFinite(weight) ? weight : undefined;
  }
  if (typeof weight === "string") {
    const parsed = Number.parseFloat(weight);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function resolveEntryCount(state: ReturnType<typeof parseWorkoutState>): number {
  return Array.isArray(state.events) ? state.events.length : 0;
}

function resolveStrengthPersonalBests(state: ReturnType<typeof parseWorkoutState>) {
  const strength = state.views?.personalBests?.strength;
  if (!strength || typeof strength !== "object") {
    return undefined;
  }
  return strength as Record<string, unknown>;
}

function extractReplyText(reply: unknown): string {
  const payload = Array.isArray(reply) ? reply[0] : reply;
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function stringifyLogArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function countReqStarts(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    const match = line.match(/\[ollama-stream-fn\] req#(\d+) start\b/i);
    if (!match) {
      continue;
    }
    count += 1;
  }
  return count;
}

function buildSenderId(prefix: string): string {
  return `${TEST_USER}-${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

async function runWorkoutsAgentWithLoopCount(params: {
  workspaceDir: string;
  home: string;
  body: string;
  senderId?: string;
}): Promise<{ reply: unknown; loops: number }> {
  const maxAttempts = LOCAL_ONLY ? 1 : 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const capturedLogs: string[] = [];
    const originalLog = console.log.bind(console);
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      capturedLogs.push(args.map((entry) => stringifyLogArg(entry)).join(" "));
      if (EMIT_MODEL_LOGS) {
        originalLog(...args);
      }
    });
    const senderId = params.senderId ?? TEST_USER;
    try {
      await seedCodexCredentials(params.home);
      const reply = await getReplyFromConfig(
        {
          Body: params.body,
          From: senderId,
          To: senderId,
          Provider: "whatsapp",
        },
        {},
        workoutAgentConfig(params.workspaceDir, params.home),
      );
      const text = extractReplyText(reply).trim();
      if (!LOCAL_ONLY && attempt < maxAttempts && text.length === 0) {
        continue;
      }
      return {
        reply,
        loops: countReqStarts(capturedLogs),
      };
    } finally {
      logSpy.mockRestore();
    }
  }
  return { reply: [], loops: 0 };
}

function daysAgoIso(daysAgo: number): string {
  const timestamp = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  return new Date(timestamp).toISOString();
}

describe("workouts agent-level e2e – real model", () => {
  let canRun = false;

  beforeAll(async () => {
    const ollamaOk = LOCAL_ONLY ? await ollamaAvailable() : true;
    const modelOk = LOCAL_ONLY ? ollamaOk && (await modelAvailable()) : await codexAuthAvailable();
    canRun = modelOk;
    if (LOCAL_ONLY && !ollamaOk) {
      console.warn(
        "[workouts agent e2e] Ollama not available at localhost:11434 – skipping. Run `ollama serve`.",
      );
    } else if (LOCAL_ONLY && !modelOk) {
      console.warn(
        `[workouts agent e2e] Model ${LOCAL_MODEL} not found – skipping. Run \`ollama pull ${LOCAL_MODEL}\`.`,
      );
    } else if (!LOCAL_ONLY && !modelOk) {
      console.warn(
        `[workouts agent e2e] Codex auth not found under ${AUTH_HOME}/.openclaw/{credentials/oauth.json,agents/main/agent/auth-profiles.json} – skipping cloud-integrated mode.`,
      );
    }
  });

  it(
    "logs new strength training item and records PR in v2 views",
    { timeout: 300_000 },
    async () => {
      if (!canRun) {
        return;
      }
      await withTempHome(
        async (home) => {
          const workspaceDir = path.join(home, "openclaw");
          const senderId = buildSenderId("strength-pr");
          await setupWorkspaceWithFixtures(workspaceDir, senderId);

          const beforeRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
          const beforeState = parseWorkoutState(beforeRaw);
          const beforeCount = resolveEntryCount(beforeState);
          const beforeDeadlift = resolvePersonalBestWeight(
            resolveStrengthPersonalBests(beforeState),
            "Deadlift",
          );

          const logPrompt = "Log my deadlift workout today: 305 lb for 5 reps.";
          const run = await runWorkoutsAgentWithLoopCount({
            workspaceDir,
            home,
            body: logPrompt,
            senderId,
          });
          expect(run.loops).toBeLessThanOrEqual(3);

          let afterRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
          let afterState = parseWorkoutState(afterRaw);
          if (!LOCAL_ONLY && resolveEntryCount(afterState) <= beforeCount) {
            const retryRun = await runWorkoutsAgentWithLoopCount({
              workspaceDir,
              home,
              body: logPrompt,
              senderId,
            });
            expect(retryRun.loops).toBeLessThanOrEqual(3);
            afterRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
            afterState = parseWorkoutState(afterRaw);
          }
          expect(resolveEntryCount(afterState)).toBeGreaterThan(beforeCount);
          const afterDeadlift = resolvePersonalBestWeight(
            resolveStrengthPersonalBests(afterState),
            "Deadlift",
          );
          expect(typeof afterDeadlift).toBe("number");
          expect((afterDeadlift ?? 0) >= (beforeDeadlift ?? 0)).toBe(true);
        },
        { prefix: "workouts-agent-e2e-" },
      );
    },
  );

  it("logs running exercise entries", { timeout: 300_000 }, async () => {
    if (!canRun) {
      return;
    }
    await withTempHome(
      async (home) => {
        const workspaceDir = path.join(home, "openclaw");
        const senderId = buildSenderId("running-log");
        await setupWorkspaceWithFixtures(workspaceDir, senderId);

        const beforeRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
        const beforeState = parseWorkoutState(beforeRaw);
        const beforeCount = resolveEntryCount(beforeState);

        const run = await runWorkoutsAgentWithLoopCount({
          workspaceDir,
          home,
          body: "I ran 3.2 miles in 28 minutes today. Add that to my workout history.",
          senderId,
        });
        expect(run.loops).toBeLessThanOrEqual(3);

        const afterRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
        const afterState = parseWorkoutState(afterRaw);
        expect(resolveEntryCount(afterState)).toBeGreaterThan(beforeCount);
        const hasRunEvent = (afterState.events ?? []).some((event) => {
          const exercise = String(event.exercise ?? "").toLowerCase();
          const modality = String(event.modality ?? "").toLowerCase();
          return (
            exercise.includes("run") ||
            modality.includes("cardio") ||
            modality.includes("endurance")
          );
        });
        expect(hasRunEvent).toBe(true);
      },
      { prefix: "workouts-agent-e2e-" },
    );
  });

  it("suggests chest-day plan similar to prior exercises", { timeout: 240_000 }, async () => {
    if (!canRun) {
      return;
    }
    await withTempHome(
      async (home) => {
        const workspaceDir = path.join(home, "openclaw");
        const senderId = buildSenderId("chest-similar");
        await setupWorkspaceWithFixtures(workspaceDir, senderId);

        const run = await runWorkoutsAgentWithLoopCount({
          workspaceDir,
          home,
          body: "What should I work out today for my chest day? Keep it similar to my past exercises.",
          senderId,
        });
        expect(run.loops).toBeLessThanOrEqual(3);
        const text = extractReplyText(run.reply).toLowerCase();
        expect(text).toMatch(/chest|bench|press|dips|fly/);
        expect(text).toMatch(/bench|press/);
      },
      { prefix: "workouts-agent-e2e-" },
    );
  });

  it("suggests chest-day options that are new", { timeout: 300_000 }, async () => {
    if (!canRun) {
      return;
    }
    await withTempHome(
      async (home) => {
        const workspaceDir = path.join(home, "openclaw");
        const senderId = buildSenderId("chest-new");
        await setupWorkspaceWithFixtures(workspaceDir, senderId);

        const run = await runWorkoutsAgentWithLoopCount({
          workspaceDir,
          home,
          body: "For chest day, give me 4 options that are different from my usual bench-focused exercises.",
          senderId,
        });
        expect(run.loops).toBeLessThanOrEqual(3);
        const text = extractReplyText(run.reply).toLowerCase();
        expect(text).toMatch(/chest|press|fly|dip|push/);
        expect(text).toMatch(/incline|dumbbell|cable|machine|fly|pec|dip|push/);
      },
      { prefix: "workouts-agent-e2e-" },
    );
  });

  it("returns past-week workout records from data", { timeout: 240_000 }, async () => {
    if (!canRun) {
      return;
    }
    await withTempHome(
      async (home) => {
        const workspaceDir = path.join(home, "openclaw");
        const senderId = buildSenderId("past-week");
        await setupWorkspaceWithFixtures(workspaceDir, senderId);

        const workoutsPath = path.join(workspaceDir, "workouts.json");
        const seededRaw = await fs.readFile(workoutsPath, "utf8");
        const seededState = parseWorkoutState(seededRaw);
        const seededEvents = [
          ...(seededState.events ?? []),
          {
            id: "evt-recent-bench",
            timestamp: daysAgoIso(1),
            modality: "strength",
            exercise: "Bench Press",
            metrics: { sets: 3, reps: 5, weightLb: 195 },
          },
          {
            id: "evt-recent-row",
            timestamp: daysAgoIso(3),
            modality: "strength",
            exercise: "Dumbbell Row",
            metrics: { sets: 4, reps: 8, weightLb: 70 },
          },
          {
            id: "evt-recent-run",
            timestamp: daysAgoIso(5),
            modality: "cardio",
            exercise: "Running",
            metrics: { durationMin: 26, distanceMi: 3.2 },
          },
          {
            id: "evt-old-deadlift",
            timestamp: daysAgoIso(12),
            modality: "strength",
            exercise: "Deadlift",
            metrics: { sets: 3, reps: 5, weightLb: 275 },
          },
        ];
        const updated = {
          ...seededState,
          schemaVersion: 2,
          events: seededEvents,
        };
        await fs.writeFile(workoutsPath, JSON.stringify(updated, null, 2), "utf8");

        const run = await runWorkoutsAgentWithLoopCount({
          workspaceDir,
          home,
          body: "What workouts have I done in the last 7 days?",
          senderId,
        });
        expect(run.loops).toBeLessThanOrEqual(3);
        const text = extractReplyText(run.reply).toLowerCase();
        expect(text).toMatch(/bench|row|run|running|workout/);
      },
      { prefix: "workouts-agent-e2e-" },
    );
  });

  it("updates views.personalBests.strength when logging a PR", { timeout: 300_000 }, async () => {
    if (!canRun) {
      return;
    }
    await withTempHome(
      async (home) => {
        const workspaceDir = path.join(home, "openclaw");
        const senderId = buildSenderId("bench-pr");
        await setupWorkspaceWithFixtures(workspaceDir, senderId);

        const beforeRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
        const beforeState = parseWorkoutState(beforeRaw);
        const beforeBench = resolvePersonalBestWeight(
          resolveStrengthPersonalBests(beforeState),
          "Bench Press",
        );

        const run = await runWorkoutsAgentWithLoopCount({
          workspaceDir,
          home,
          body: "I hit a bench press PR: 195 lb for 5 reps. Add it to my records.",
          senderId,
        });
        expect(run.loops).toBeLessThanOrEqual(3);

        const afterRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
        const afterState = parseWorkoutState(afterRaw);
        const afterBench = resolvePersonalBestWeight(
          resolveStrengthPersonalBests(afterState),
          "Bench Press",
        );

        expect(typeof afterBench).toBe("number");
        expect((afterBench ?? 0) >= (beforeBench ?? 0)).toBe(true);
      },
      { prefix: "workouts-agent-e2e-" },
    );
  });
});
