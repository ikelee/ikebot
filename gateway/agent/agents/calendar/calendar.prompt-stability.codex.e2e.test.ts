import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getReplyFromConfig } from "../../pipeline/reply.js";

type TelemetryEvent = {
  runId?: string;
  stream?: string;
  sessionKey?: string;
  data?: Record<string, unknown>;
};

const MODEL_PROVIDER = "openai-codex";
const MODEL = process.env.OPENCLAW_CALENDAR_TEST_CLOUD_MODEL?.trim() || "gpt-5.1-codex-mini";
const AUTH_HOME =
  process.env.OPENCLAW_CALENDAR_AUTH_HOME?.trim() || os.userInfo().homedir || "/Users/ikebot";
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

async function setupWorkspace(workspaceDir: string) {
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "calendar-settings.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        profile: {
          calendarId: "test@example.com",
          timezone: "America/Los_Angeles",
          defaultDurationMin: 30,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(workspaceDir, "calendar-notes.txt"), "", "utf8");
  await fs.writeFile(
    path.join(workspaceDir, "calendar-memo-default.md"),
    "# Calendar Memo\n",
    "utf8",
  );
  await fs.copyFile(
    path.join(TEMPLATES_DIR, "calendar-agent", "SOUL.md"),
    path.join(workspaceDir, "SOUL.md"),
  );
  await fs.copyFile(
    path.join(TEMPLATES_DIR, "calendar-agent", "TOOLS.md"),
    path.join(workspaceDir, "TOOLS.md"),
  );
}

async function seedCodexAuthForStateDir(stateDir: string): Promise<void> {
  const sourceOauth = await firstExistingPath([
    path.join(AUTH_HOME, ".openclaw", "credentials", "oauth.json"),
    path.join(os.userInfo().homedir, ".openclaw", "credentials", "oauth.json"),
  ]);
  const sourceAuthProfiles = await firstExistingPath([
    path.join(AUTH_HOME, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
    path.join(os.userInfo().homedir, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
  ]);
  const targetOauth = path.join(stateDir, "credentials", "oauth.json");
  const targetAuthProfiles = path.join(
    stateDir,
    "agents",
    "calendar",
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

function calendarAgentConfig(workspaceDir: string) {
  return {
    agents: {
      defaults: {
        model: `${MODEL_PROVIDER}/${MODEL}`,
        routing: { enabled: false, classifierModel: `${MODEL_PROVIDER}/${MODEL}` },
        workspace: workspaceDir,
      },
      list: [
        {
          id: "calendar",
          default: true,
          workspace: workspaceDir,
          skills: ["gog"],
          tools: { allow: ["exec"], exec: { security: "allowlist", safeBins: ["gog"] } },
        },
      ],
    },
    channels: { webchat: { allowFrom: ["*"] } },
    models: {
      providers: {
        "openai-codex": {
          api: "openai-codex-responses",
          models: [
            {
              id: MODEL,
              name: "OpenAI Codex",
              api: "openai-codex-responses",
              contextWindow: 200_000,
              cost: { input: 0, output: 0 },
            },
          ],
        },
      },
    },
  };
}

function extractReplyText(reply: unknown): string {
  const payload = Array.isArray(reply) ? reply[0] : reply;
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function extractFlagValue(command: string, flag: "--from" | "--to"): string {
  const re = new RegExp(`${flag}\\s+([^\\s]+)`);
  const match = command.match(re);
  return match?.[1] ?? "";
}

async function readTelemetryEvents(pathname: string): Promise<TelemetryEvent[]> {
  const raw = await fs.readFile(pathname, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TelemetryEvent;
      } catch {
        return {};
      }
    });
}

async function waitForRunTelemetryEnd(
  telemetryPath: string,
  sessionKey: string,
  timeoutMs = 6000,
): Promise<TelemetryEvent[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const events = await readTelemetryEvents(telemetryPath);
      const runStart = [...events]
        .toReversed()
        .find(
          (evt) =>
            evt.stream === "telemetry" &&
            evt.sessionKey === sessionKey &&
            evt.data?.kind === "user_input.start" &&
            typeof evt.runId === "string",
        );
      if (!runStart?.runId) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      const runEvents = events.filter(
        (evt) => evt.stream === "telemetry" && evt.runId === runStart.runId,
      );
      const hasUserEnd = runEvents.some((evt) => evt.data?.kind === "user_input.end");
      if (hasUserEnd) {
        return runEvents;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return [];
}

describe("calendar prompt stability (codex, fake gog)", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await codexAuthAvailable();
  });

  it(
    "uses deterministic UTC window and emits model-call telemetry for Ani prompt",
    { timeout: 180_000 },
    async () => {
      if (!canRun) {
        return;
      }
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-prompt-stability-codex-"));
      const workspaceDir = path.join(tempRoot, "workspace-calendar");
      const fakeBinDir = path.join(tempRoot, "bin");
      const fakeGogPath = path.join(fakeBinDir, "gog");
      const commandLogPath = path.join(tempRoot, "fake-gog-commands.log");
      const stateDir = path.join(tempRoot, "state");
      const telemetryPath = path.join(stateDir, "logs", "telemetry.jsonl");
      const sessionKey = `agent:calendar:prompt-stability:codex:${Date.now()}`;

      const previousPath = process.env.PATH ?? "";
      const previousLogPath = process.env.OPENCLAW_FAKE_GOG_LOG;
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;

      try {
        await setupWorkspace(workspaceDir);
        await seedCodexAuthForStateDir(stateDir);
        await fs.mkdir(fakeBinDir, { recursive: true });
        const script = `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${commandLogPath}"
summary=""
from=""
to=""
args=("$@")
i=0
while [ $i -lt $# ]; do
  a="\${args[$i]}"
  if [ "$a" = "--summary" ]; then
    i=$((i+1)); summary="\${args[$i]}"
  elif [ "$a" = "--from" ]; then
    i=$((i+1)); from="\${args[$i]}"
  elif [ "$a" = "--to" ]; then
    i=$((i+1)); to="\${args[$i]}"
  fi
  i=$((i+1))
done
echo -e "id\tfake-event-id"
echo -e "summary\t\${summary:-Ani’s fundraiser}"
echo -e "timezone\tUTC"
echo -e "start\t\${from:-2026-03-06T01:30:00Z}"
echo -e "start-local\t\${from:-2026-03-06T01:30:00Z}"
echo -e "end\t\${to:-2026-03-06T03:30:00Z}"
echo -e "end-local\t\${to:-2026-03-06T03:30:00Z}"
echo -e "link\thttps://www.google.com/calendar/event?eid=fake"
`;
        await fs.writeFile(fakeGogPath, script, { encoding: "utf8", mode: 0o755 });

        process.env.PATH = `${fakeBinDir}:${previousPath}`;
        process.env.OPENCLAW_FAKE_GOG_LOG = commandLogPath;
        process.env.OPENCLAW_STATE_DIR = stateDir;

        const reply = await getReplyFromConfig(
          {
            Body: "[Fri 2026-02-20 12:30 PST] Add Ani’s fundraiser for march 5th 530-730",
            From: "calendar-prompt-stability-codex-user",
            To: "calendar-prompt-stability-codex-user",
            Provider: "webchat",
            SessionKey: sessionKey,
          },
          {},
          calendarAgentConfig(workspaceDir),
        );

        const text = extractReplyText(reply).toLowerCase();
        expect(text.length).toBeGreaterThan(20);
        expect(text).toContain("ani");
        expect(text).toMatch(/(fundraiser|scheduled|added|calendar)/);

        const rawCommandLog = await fs.readFile(commandLogPath, "utf8");
        const lines = rawCommandLog
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const firstCreate = lines.find((line) => line.startsWith("calendar create "));
        expect(firstCreate).toBeTruthy();

        const fromVal = extractFlagValue(firstCreate ?? "", "--from");
        const toVal = extractFlagValue(firstCreate ?? "", "--to");
        expect(Date.parse(fromVal)).toBe(Date.parse("2026-03-06T01:30:00Z"));
        expect(Date.parse(toVal)).toBe(Date.parse("2026-03-06T03:30:00Z"));

        const sessionEvents = await waitForRunTelemetryEnd(telemetryPath, sessionKey);
        expect(sessionEvents.length).toBeGreaterThan(0);

        const kinds = sessionEvents
          .map((evt) => (typeof evt.data?.kind === "string" ? evt.data.kind : ""))
          .filter(Boolean);
        expect(kinds).toContain("user_input.start");
        expect(kinds).toContain("agent_loop.start");
        expect(kinds).toContain("tool_loop.start");
        expect(kinds).toContain("model_call.end");
        expect(kinds).toContain("tool_loop.end");
        expect(kinds).toContain("agent_loop.end");
        expect(kinds).toContain("user_input.end");

        const modelCallEnds = sessionEvents.filter((evt) => evt.data?.kind === "model_call.end");
        expect(modelCallEnds.length).toBeGreaterThanOrEqual(2);
        expect(
          modelCallEnds.every(
            (evt) =>
              evt.data?.provider === MODEL_PROVIDER &&
              typeof evt.data?.model === "string" &&
              (evt.data?.model).length > 0,
          ),
        ).toBe(true);

        const toolLoopEnd = sessionEvents.find((evt) => evt.data?.kind === "tool_loop.end");
        expect(toolLoopEnd?.data?.modelCallCount).toBe(modelCallEnds.length);
        expect(Number(toolLoopEnd?.data?.toolCallCount ?? 0)).toBeGreaterThanOrEqual(1);

        const agentLoopEnd = sessionEvents.find((evt) => evt.data?.kind === "agent_loop.end");
        expect(agentLoopEnd?.data?.toolLoopCount).toBe(1);
        expect(agentLoopEnd?.data?.modelCallCount).toBe(modelCallEnds.length);
      } finally {
        process.env.PATH = previousPath;
        if (previousLogPath === undefined) {
          delete process.env.OPENCLAW_FAKE_GOG_LOG;
        } else {
          process.env.OPENCLAW_FAKE_GOG_LOG = previousLogPath;
        }
        if (previousStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = previousStateDir;
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    },
  );
});
