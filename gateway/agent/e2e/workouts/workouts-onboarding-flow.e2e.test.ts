/**
 * Workouts onboarding E2E: from top-level/main message into workouts onboarding,
 * with a clean default state and no pre-seeded files.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withTempHome } from "../../../../test/helpers/temp-home.js";
import { resolveAgentWorkspaceDir } from "../../../runtime/agent-scope.js";
import { parseWorkoutState } from "../../agents/workouts/state.js";
import { getReplyFromConfig } from "../../pipeline/reply.js";

const TEST_USER = "onboarding-e2e-user";
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
  const providers = LOCAL_ONLY
    ? {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          models: [
            {
              id: MODEL_ID,
              name: "Qwen 2.5 14B",
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
        workspace: mainWorkspace,
      },
      list: [
        { id: "main", default: true, workspace: mainWorkspace },
        { id: "workouts", skills: [], tools: {} },
      ],
    },
    channels: { webchat: { allowFrom: ["*"] } },
    models: { providers },
    session: { store: path.join(home, "sessions.json") },
  };
}

describe("workouts onboarding e2e", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = LOCAL_ONLY ? true : await codexAuthAvailable();
    if (!canRun) {
      console.warn(
        "[workouts onboarding e2e] OpenAI Codex auth not found. Set ~/.openclaw credentials/auth-profiles.",
      );
    }
  });

  it("starts from main-level prompt, initializes workouts files, and completes onboarding", async () => {
    if (!canRun) {
      return;
    }
    await withTempHome(
      async (home) => {
        await seedCodexCredentials(home);
        const mainWorkspace = path.join(home, "openclaw-main");
        await fs.mkdir(mainWorkspace, { recursive: true });
        const cfg = buildConfig(home, mainWorkspace);
        const workoutsWorkspace = resolveAgentWorkspaceDir(cfg, "workouts");

        const decoratedBody = [
          "[Wed 2026-02-18 23:16 PST] let's start logging my workouts",
          "",
          "Conversation info (context only; reply to the user's message above—do not output this JSON):",
          "```json",
          '{ "conversation_label": "openclaw-tui" }',
          "```",
        ].join("\n");

        const first = await getReplyFromConfig(
          {
            Body: decoratedBody,
            From: TEST_USER,
            To: TEST_USER,
            Provider: "webchat",
          },
          {},
          cfg,
        );
        const firstText = extractReplyText(first);
        expect(firstText.toLowerCase()).toContain("quick workouts onboarding");
        expect(firstText.toLowerCase()).toContain("program:");
        expect(firstText.toLowerCase()).not.toContain("goals:");

        await expect(fs.stat(path.join(workoutsWorkspace, "workouts.json"))).resolves.toBeDefined();
        await expect(
          fs.stat(path.join(workoutsWorkspace, "workout-notes.txt")),
        ).resolves.toBeDefined();
        const createdFiles = await fs.readdir(workoutsWorkspace);
        const memoFile = createdFiles.find((name) => /^workout-memo-.*\.md$/i.test(name));
        expect(memoFile).toBeDefined();

        const second = await getReplyFromConfig(
          {
            Body: "531",
            From: TEST_USER,
            To: TEST_USER,
            Provider: "webchat",
          },
          {},
          cfg,
        );
        const secondText = extractReplyText(second).toLowerCase();
        expect(secondText).toContain("goals:");

        const third = await getReplyFromConfig(
          {
            Body: "goals: gain muscle and increase my prs",
            From: TEST_USER,
            To: TEST_USER,
            Provider: "webchat",
          },
          {},
          cfg,
        );
        const thirdText = extractReplyText(third).toLowerCase();
        expect(thirdText).toContain("bodyweight:");

        const fourth = await getReplyFromConfig(
          {
            Body: "165lb",
            From: TEST_USER,
            To: TEST_USER,
            Provider: "webchat",
          },
          {},
          cfg,
        );
        const fourthText = extractReplyText(fourth).toLowerCase();
        expect(fourthText).toContain("style:");
        expect(fourthText).toContain("supportive|assertive|aggressive");

        const fifth = await getReplyFromConfig(
          {
            Body: "assertive",
            From: TEST_USER,
            To: TEST_USER,
            Provider: "webchat",
          },
          {},
          cfg,
        );
        const fifthText = extractReplyText(fifth).toLowerCase();
        expect(fifthText).toContain("onboarding saved");

        const sixth = await getReplyFromConfig(
          {
            Body: "do i have any workouts logged yet? show me workouts from the past few days",
            From: TEST_USER,
            To: TEST_USER,
            Provider: "webchat",
          },
          {},
          cfg,
        );
        const sixthText = extractReplyText(sixth).toLowerCase();
        expect(sixthText).not.toContain("quick workouts onboarding");
        expect(sixthText).not.toContain("style: supportive|assertive|aggressive");

        const workoutsRaw = await fs.readFile(
          path.join(workoutsWorkspace, "workouts.json"),
          "utf8",
        );
        const state = parseWorkoutState(workoutsRaw);
        expect(state.schemaVersion).toBe(2);
        expect(state.profile?.program).toBe("5/3/1");
        expect(state.program?.name).toBe("5/3/1");
        const goals = Array.isArray(state.profile?.goals) ? state.profile.goals : [];
        expect(goals.length).toBeGreaterThan(0);
        expect(goals.join(" ").toLowerCase()).toMatch(/muscle|strength|pr/);
        expect(state.profile?.bodyWeightLb).toBe(165);
        expect(state.profile?.coachingStyle).toBe("assertive");
      },
      { prefix: "workouts-onboarding-e2e-" },
    );
  });
});
