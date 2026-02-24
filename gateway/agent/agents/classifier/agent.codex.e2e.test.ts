/**
 * Classifier E2E: real OpenAI Codex model classification.
 *
 * Run via:
 * `pnpm test:e2e gateway/agent/agents/classifier/agent.codex.e2e.test.ts`
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseModelRef } from "../../../models/model-selection.js";
import { resolveOpenClawAgentDir } from "../../../runtime/agent-paths.js";
import { resolveModel } from "../../../runtime/pi-embedded-runner/model.js";
import { executeAgent } from "../../core/agent-executor.js";
import { RouterAgent } from "./agent.js";

const MODEL_PROVIDER = "openai-codex";
const MODEL = process.env.OPENCLAW_CLASSIFIER_CLOUD_MODEL?.trim() || "gpt-5.1-codex-mini";
const AUTH_HOME =
  process.env.OPENCLAW_CLASSIFIER_AUTH_HOME?.trim() || os.userInfo().homedir || "/Users/ikebot";

const cfg = {
  models: {
    providers: {
      "openai-codex": {
        api: "openai-codex-responses" as const,
        models: [
          {
            id: MODEL,
            name: MODEL,
            api: "openai-codex-responses" as const,
            contextWindow: 200000,
            cost: { input: 0, output: 0 },
          },
        ],
      },
    },
  },
};

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

async function firstExistingPath(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return undefined;
}

async function seedCodexAuthForTestHome(): Promise<void> {
  const testHome = process.env.HOME?.trim();
  if (!testHome) {
    return;
  }
  const sourceOauth = await firstExistingPath([
    path.join(AUTH_HOME, ".openclaw", "credentials", "oauth.json"),
    path.join(os.userInfo().homedir, ".openclaw", "credentials", "oauth.json"),
  ]);
  const sourceAuthProfiles = await firstExistingPath([
    path.join(AUTH_HOME, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
    path.join(os.userInfo().homedir, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
  ]);
  const targetOauth = path.join(testHome, ".openclaw", "credentials", "oauth.json");
  const targetAuthProfiles = path.join(
    testHome,
    ".openclaw",
    "agents",
    "main",
    "agent",
    "auth-profiles.json",
  );
  if (sourceOauth) {
    await fs.mkdir(path.dirname(targetOauth), { recursive: true });
    await fs.copyFile(sourceOauth, targetOauth);
  }
  if (sourceAuthProfiles) {
    await fs.mkdir(path.dirname(targetAuthProfiles), { recursive: true });
    await fs.copyFile(sourceAuthProfiles, targetAuthProfiles);
  }
}

function createModelResolver() {
  const modelRef = parseModelRef(`${MODEL_PROVIDER}/${MODEL}`, MODEL_PROVIDER);
  if (!modelRef) {
    return () => Promise.resolve(undefined);
  }
  const agentDir = resolveOpenClawAgentDir();
  return async () => {
    const resolved = resolveModel(modelRef.provider, modelRef.model, agentDir, cfg as any);
    return resolved.model;
  };
}

describe("RouterAgent e2e – codex classification", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await codexAuthAvailable();
    if (!canRun) {
      console.warn(
        "[classifier codex e2e] OpenAI Codex auth not available – skipping model tests.",
      );
    }
  });

  it(
    "routes calendar intent with codex (or deterministic fallback on empty model output)",
    { timeout: 120_000 },
    async () => {
      if (!canRun) {
        return;
      }
      await seedCodexAuthForTestHome();
      const modelResolver = createModelResolver();
      const agent = new RouterAgent(modelResolver);
      const output = await executeAgent(
        agent,
        { userIdentifier: "user", message: "Add Sam smith concert tomorrow at 7pm" },
        {
          recordTrace: false,
          config: cfg as Record<string, unknown>,
        },
      );

      expect(output.decision).toBe("calendar");
    },
  );
});
