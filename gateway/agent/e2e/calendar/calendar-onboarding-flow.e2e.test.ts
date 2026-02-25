/**
 * Calendar readiness e2e: calendar route should fail fast with setup instructions
 * when manual gog/config setup is incomplete.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withTempHome } from "../../../../test/helpers/temp-home.js";
import { resolveAgentWorkspaceDir } from "../../../runtime/agent-scope.js";
import { getReplyFromConfig } from "../../pipeline/reply.js";

const OLLAMA_BASE = "http://localhost:11434";
const LOCAL_ONLY =
  process.env.OPENCLAW_TEST_LOCAL_ONLY === "1" ||
  process.env.OPENCLAW_CALENDAR_TEST_LOCAL_ONLY === "1";
const LOCAL_MODEL = process.env.OPENCLAW_CALENDAR_TEST_MODEL?.trim() || "qwen2.5:14b";
const CLOUD_MODEL = process.env.OPENCLAW_CALENDAR_TEST_CLOUD_MODEL?.trim() || "gpt-5.1-codex-mini";
const MODEL_PROVIDER = LOCAL_ONLY ? "ollama" : "openai-codex";
const MODEL_ID = LOCAL_ONLY ? LOCAL_MODEL : CLOUD_MODEL;
const MODEL_REF = `${MODEL_PROVIDER}/${MODEL_ID}`;
const AUTH_HOME =
  process.env.OPENCLAW_CALENDAR_AUTH_HOME?.trim() || os.userInfo().homedir || "/Users/ikebot";
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
          baseUrl: `${OLLAMA_BASE}/v1`,
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
        {
          id: "calendar",
          skills: ["gog"],
          tools: { allow: ["exec"], exec: { security: "allowlist", safeBins: ["gog"] } },
        },
      ],
    },
    channels: { webchat: { allowFrom: ["*"] } },
    models: { providers },
    session: { store: path.join(home, "sessions.json") },
  };
}

describe("calendar readiness e2e", () => {
  let canRun = false;

  beforeAll(async () => {
    if (LOCAL_ONLY) {
      const ollamaOk = await ollamaAvailable();
      const modelOk = ollamaOk && (await modelAvailable());
      canRun = modelOk;
      if (!ollamaOk) {
        console.warn(
          "[calendar readiness e2e] Ollama not available at localhost:11434 – skipping. Run `ollama serve`.",
        );
      } else if (!modelOk) {
        console.warn(
          `[calendar readiness e2e] Model ${LOCAL_MODEL} not found – skipping. Run \`ollama pull ${LOCAL_MODEL}\`.`,
        );
      }
      return;
    }
    canRun = await codexAuthAvailable();
    if (!canRun) {
      console.warn(
        "[calendar readiness e2e] OpenAI Codex auth not found. Set ~/.openclaw credentials/auth-profiles.",
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
          await seedCodexCredentials(home);
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
