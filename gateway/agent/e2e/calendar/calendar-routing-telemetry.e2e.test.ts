import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getReplyFromConfig } from "../../pipeline/reply.js";

type TelemetryEvent = {
  runId?: string;
  stream?: string;
  source?: "live" | "test" | "unknown";
  sessionKey?: string;
  data?: Record<string, unknown>;
};

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

async function firstExistingPath(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return undefined;
}

async function seedCodexAuthForStateDir(stateDir: string): Promise<void> {
  if (LOCAL_ONLY) {
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
  const targetOauth = path.join(stateDir, "credentials", "oauth.json");
  const targetMainAuthProfiles = path.join(
    stateDir,
    "agents",
    "main",
    "agent",
    "auth-profiles.json",
  );
  const targetCalendarAuthProfiles = path.join(
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
    await fs.mkdir(path.dirname(targetMainAuthProfiles), { recursive: true });
    await fs.mkdir(path.dirname(targetCalendarAuthProfiles), { recursive: true });
    await fs.copyFile(sourceAuthProfiles, targetMainAuthProfiles);
    await fs.copyFile(sourceAuthProfiles, targetCalendarAuthProfiles);
  }
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

function buildConfig(mainWorkspace: string, calendarWorkspace: string) {
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
          workspace: calendarWorkspace,
          skills: ["gog"],
          tools: { allow: ["exec"], exec: { security: "allowlist", safeBins: ["gog"] } },
        },
      ],
    },
    channels: { webchat: { allowFrom: ["*"] } },
    models: { providers },
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

async function waitForLatestRunTelemetryEnd(
  telemetryPath: string,
  sessionKey: string,
  timeoutMs = 10_000,
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
      if (runEvents.some((evt) => evt.data?.kind === "user_input.end")) {
        return runEvents;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return [];
}

describe("calendar routing telemetry e2e (cloud default, fake gog)", () => {
  let canRun = false;

  beforeAll(async () => {
    if (LOCAL_ONLY) {
      const ollamaOk = await ollamaAvailable();
      const modelOk = ollamaOk && (await modelAvailable());
      canRun = modelOk;
      if (!ollamaOk) {
        console.warn(
          "[calendar routing telemetry e2e] Ollama not available at localhost:11434 – skipping. Run `ollama serve`.",
        );
      } else if (!modelOk) {
        console.warn(
          `[calendar routing telemetry e2e] Model ${LOCAL_MODEL} not found – skipping. Run \`ollama pull ${LOCAL_MODEL}\`.`,
        );
      }
      return;
    }
    canRun = await codexAuthAvailable();
    if (!canRun) {
      console.warn(
        "[calendar routing telemetry e2e] OpenAI Codex auth not found. Set ~/.openclaw credentials/auth-profiles.",
      );
    }
  });

  it(
    "routes to calendar update flow and preserves telemetry hierarchy links",
    { timeout: 180_000 },
    async () => {
      if (!canRun) {
        return;
      }
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-routing-telemetry-"));
      const mainWorkspace = path.join(tempRoot, "workspace-main");
      const calendarWorkspace = path.join(tempRoot, "workspace-calendar");
      const fakeBinDir = path.join(tempRoot, "bin");
      const fakeGogPath = path.join(fakeBinDir, "gog");
      const commandLogPath = path.join(tempRoot, "fake-gog-commands.log");
      const stateDir = path.join(tempRoot, "state");
      const telemetryPath = path.join(stateDir, "logs", "telemetry.jsonl");
      const sessionKey = `e2e:calendar:routing:telemetry:${Date.now()}`;

      const previousPath = process.env.PATH ?? "";
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      try {
        await fs.mkdir(mainWorkspace, { recursive: true });
        await setupWorkspace(calendarWorkspace);
        await fs.mkdir(fakeBinDir, { recursive: true });

        const script = `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${commandLogPath}"
summary=""
from=""
to=""
event_id=""
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
  elif [ "$a" = "--event-id" ] || [ "$a" = "--id" ] || [ "$a" = "--event" ]; then
    i=$((i+1)); event_id="\${args[$i]}"
  fi
  i=$((i+1))
done
if [ -z "$event_id" ]; then
  event_id="fake-event-id"
fi
if [ -z "$summary" ]; then
  summary="Ani's fundraiser (updated)"
fi
if [ -z "$from" ]; then
  from="2026-03-06T02:00:00Z"
fi
if [ -z "$to" ]; then
  to="2026-03-06T04:00:00Z"
fi
echo -e "id\t$event_id"
echo -e "summary\t$summary"
echo -e "timezone\tUTC"
echo -e "start\t$from"
echo -e "start-local\t$from"
echo -e "end\t$to"
echo -e "end-local\t$to"
echo -e "link\thttps://www.google.com/calendar/event?eid=fake"
`;
        await fs.writeFile(fakeGogPath, script, { encoding: "utf8", mode: 0o755 });

        process.env.PATH = `${fakeBinDir}:${previousPath}`;
        process.env.OPENCLAW_STATE_DIR = stateDir;
        await seedCodexAuthForStateDir(stateDir);

        const cfg = buildConfig(mainWorkspace, calendarWorkspace);
        const reply = await getReplyFromConfig(
          {
            Body: "[Fri 2026-02-20 12:30 PST] Please update my calendar event fake-event-id: set summary to Ani's fundraiser (updated), start 2026-03-06T02:00:00Z, end 2026-03-06T04:00:00Z.",
            From: "calendar-routing-telemetry-user",
            To: "calendar-routing-telemetry-user",
            Provider: "webchat",
            SessionKey: sessionKey,
          },
          {},
          cfg,
        );
        const replyText = extractReplyText(reply).toLowerCase();
        expect(replyText.length).toBeGreaterThan(0);
        expect(replyText).toMatch(/(updated|event|schedule|calendar)/);

        const rawCommandLog = await fs.readFile(commandLogPath, "utf8");
        const commandLines = rawCommandLog
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        expect(commandLines.length).toBeGreaterThan(0);
        expect(commandLines.some((line) => /\bcalendar\b/i.test(line))).toBe(true);
        expect(commandLines.some((line) => line.includes("fake-event-id"))).toBe(true);

        const runEvents = await waitForLatestRunTelemetryEnd(telemetryPath, sessionKey);
        expect(runEvents.length).toBeGreaterThan(0);
        expect(runEvents.every((evt) => evt.source === "test")).toBe(true);

        const kinds = runEvents
          .map((evt) => (typeof evt.data?.kind === "string" ? evt.data.kind : ""))
          .filter(Boolean);
        expect(kinds).toContain("user_input.start");
        expect(kinds).toContain("agent_loop.start");
        expect(kinds).toContain("tool_loop.start");
        expect(kinds).toContain("model_call.start");
        expect(kinds).toContain("model_call.end");
        expect(kinds).toContain("tool_loop.end");
        expect(kinds).toContain("agent_loop.end");
        expect(kinds).toContain("user_input.end");

        const userInputIds = new Set<string>();
        const agentLoopIds = new Set<string>();
        const toolLoopIds = new Set<string>();
        const modelCallStartsById = new Map<string, TelemetryEvent>();
        const modelCallEndsByToolLoopId = new Map<string, number>();
        const toolLoopEndsByAgentLoopId = new Map<string, number>();
        const agentLoopEndsByUserInputId = new Map<string, number>();

        for (const evt of runEvents) {
          const kind = evt.data?.kind;
          if (kind === "user_input.start" && typeof evt.data.userInputId === "string") {
            userInputIds.add(evt.data.userInputId);
          }
          if (kind === "agent_loop.start" && typeof evt.data.agentLoopId === "string") {
            agentLoopIds.add(evt.data.agentLoopId);
            expect(evt.data.agentId).toBe("calendar");
            if (typeof evt.data.userInputId === "string") {
              expect(userInputIds.has(evt.data.userInputId)).toBe(true);
            }
          }
          if (kind === "tool_loop.start" && typeof evt.data.toolLoopId === "string") {
            toolLoopIds.add(evt.data.toolLoopId);
            if (typeof evt.data.agentLoopId === "string") {
              expect(agentLoopIds.has(evt.data.agentLoopId)).toBe(true);
            }
            if (typeof evt.data.userInputId === "string") {
              expect(userInputIds.has(evt.data.userInputId)).toBe(true);
            }
          }
          if (kind === "model_call.start" && typeof evt.data.modelCallId === "string") {
            modelCallStartsById.set(evt.data.modelCallId, evt);
            if (typeof evt.data.toolLoopId === "string") {
              expect(toolLoopIds.has(evt.data.toolLoopId)).toBe(true);
            }
            if (typeof evt.data.agentLoopId === "string") {
              expect(agentLoopIds.has(evt.data.agentLoopId)).toBe(true);
            }
            if (typeof evt.data.userInputId === "string") {
              expect(userInputIds.has(evt.data.userInputId)).toBe(true);
            }
          }
          if (kind === "model_call.end") {
            const modelCallId = String(evt.data?.modelCallId ?? "");
            const toolLoopId = String(evt.data?.toolLoopId ?? "");
            expect(modelCallStartsById.has(modelCallId)).toBe(true);
            expect(toolLoopIds.has(toolLoopId)).toBe(true);
            modelCallEndsByToolLoopId.set(
              toolLoopId,
              (modelCallEndsByToolLoopId.get(toolLoopId) ?? 0) + 1,
            );
          }
          if (kind === "tool_loop.end") {
            const toolLoopId = String(evt.data?.toolLoopId ?? "");
            const agentLoopId = String(evt.data?.agentLoopId ?? "");
            expect(toolLoopIds.has(toolLoopId)).toBe(true);
            expect(agentLoopIds.has(agentLoopId)).toBe(true);
            const observedModelCalls = modelCallEndsByToolLoopId.get(toolLoopId) ?? 0;
            expect(evt.data?.modelCallCount).toBe(observedModelCalls);
            toolLoopEndsByAgentLoopId.set(
              agentLoopId,
              (toolLoopEndsByAgentLoopId.get(agentLoopId) ?? 0) + 1,
            );
          }
          if (kind === "agent_loop.end") {
            const agentLoopId = String(evt.data?.agentLoopId ?? "");
            const userInputId = String(evt.data?.userInputId ?? "");
            expect(agentLoopIds.has(agentLoopId)).toBe(true);
            expect(userInputIds.has(userInputId)).toBe(true);
            const observedToolLoops = toolLoopEndsByAgentLoopId.get(agentLoopId) ?? 0;
            expect(evt.data?.toolLoopCount).toBe(observedToolLoops);
            agentLoopEndsByUserInputId.set(
              userInputId,
              (agentLoopEndsByUserInputId.get(userInputId) ?? 0) + 1,
            );
          }
          if (kind === "user_input.end") {
            const userInputId = String(evt.data?.userInputId ?? "");
            expect(userInputIds.has(userInputId)).toBe(true);
            const observedAgentLoops = agentLoopEndsByUserInputId.get(userInputId) ?? 0;
            expect(evt.data?.agentLoopCount).toBe(observedAgentLoops);
          }
        }

        expect(modelCallStartsById.size).toBeGreaterThan(0);
      } finally {
        process.env.PATH = previousPath;
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
