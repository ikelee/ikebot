/**
 * Calendar agent-level e2e: direct calendar agent path with real model and gog auth.
 * Router/classifier is disabled in this suite.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getReplyFromConfig } from "../../pipeline/reply.js";

const execFileAsync = promisify(execFile);
const OLLAMA_BASE = "http://localhost:11434";
const LOCAL_ONLY =
  process.env.OPENCLAW_TEST_LOCAL_ONLY === "1" ||
  process.env.OPENCLAW_CALENDAR_TEST_LOCAL_ONLY === "1";
const LOCAL_MODEL = process.env.OPENCLAW_CALENDAR_TEST_MODEL?.trim() || "qwen2.5:14b";
const CLOUD_MODEL = process.env.OPENCLAW_CALENDAR_TEST_CLOUD_MODEL?.trim() || "gpt-5.1-codex-mini";
const MODEL_PROVIDER = LOCAL_ONLY ? "ollama" : "openai-codex";
const MODEL_ID = LOCAL_ONLY ? LOCAL_MODEL : CLOUD_MODEL;
const MODEL_REF = `${MODEL_PROVIDER}/${MODEL_ID}`;
const TEST_USER = "calendar-agent-e2e-user";
const CALENDAR_TEST_ACCOUNT =
  process.env.OPENCLAW_CALENDAR_TEST_ACCOUNT?.trim() || "ikebotai@gmail.com";
const CALENDAR_TEST_ID = process.env.OPENCLAW_CALENDAR_TEST_ID?.trim() || CALENDAR_TEST_ACCOUNT;
const EMIT_MODEL_LOGS = process.env.OPENCLAW_TEST_EMIT_MODEL_LOGS === "1";
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

async function gogCalendarAuthAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("gog", ["auth", "list", "--plain"], {
      timeout: 5000,
      env: { ...process.env, HOME: AUTH_HOME },
    });
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.some((line) => /\bcalendar\b/i.test(line));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[calendar agent e2e] auth preflight failed: ${msg}`);
    return false;
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
          calendarId: CALENDAR_TEST_ID,
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

async function runGogJson(args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync("gog", args, {
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: AUTH_HOME,
      GOG_ACCOUNT: CALENDAR_TEST_ACCOUNT,
    },
  });
  return JSON.parse(stdout);
}

function extractEvents(node: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(node)) {
    return node.filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object"),
    );
  }
  if (!node || typeof node !== "object") {
    return [];
  }
  const rec = node as Record<string, unknown>;
  const directKeys = ["events", "items", "results", "data"];
  for (const key of directKeys) {
    const candidate = rec[key];
    const nested = extractEvents(candidate);
    if (nested.length > 0) {
      return nested;
    }
  }
  return [];
}

async function listEventsByQuery(query: string): Promise<Array<{ id: string; summary: string }>> {
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const payload = await runGogJson([
    "calendar",
    "events",
    CALENDAR_TEST_ID,
    "--account",
    CALENDAR_TEST_ACCOUNT,
    "--from",
    from,
    "--to",
    to,
    "--query",
    query,
    "--max",
    "50",
    "--json",
  ]);
  const events = extractEvents(payload);
  return events
    .map((event) => ({
      id: asScalarString(event.id),
      summary: asScalarString(event.summary),
    }))
    .filter((event) => event.id.length > 0);
}

async function waitForEventsByQuery(params: {
  query: string;
  minCount?: number;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<Array<{ id: string; summary: string }>> {
  const minCount = params.minCount ?? 1;
  const timeoutMs = params.timeoutMs ?? 12_000;
  const pollMs = params.pollMs ?? 600;
  const started = Date.now();
  let last: Array<{ id: string; summary: string }> = [];
  while (Date.now() - started < timeoutMs) {
    last = await listEventsByQuery(params.query);
    if (last.length >= minCount) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return last;
}

async function listRawEventsByQuery(
  query: string,
): Promise<Array<Record<string, unknown> & { id: string; summary: string }>> {
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString();
  const payload = await runGogJson([
    "calendar",
    "events",
    CALENDAR_TEST_ID,
    "--account",
    CALENDAR_TEST_ACCOUNT,
    "--from",
    from,
    "--to",
    to,
    "--query",
    query,
    "--max",
    "200",
    "--json",
  ]);
  const events = extractEvents(payload);
  return events
    .map((event) => ({
      ...event,
      id: asScalarString(event.id),
      summary: asScalarString(event.summary),
    }))
    .filter((event) => event.id.length > 0);
}

async function cleanupEventsByQuery(query: string): Promise<void> {
  const events = await listEventsByQuery(query);
  for (const event of events) {
    await execFileAsync(
      "gog",
      [
        "calendar",
        "delete",
        CALENDAR_TEST_ID,
        event.id,
        "--account",
        CALENDAR_TEST_ACCOUNT,
        "--force",
      ],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: AUTH_HOME,
          GOG_ACCOUNT: CALENDAR_TEST_ACCOUNT,
        },
      },
    );
  }
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

function asScalarString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function countReqStarts(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    if (/\[ollama-stream-fn\] req#\d+ start\b/i.test(line)) {
      count += 1;
    }
  }
  return count;
}

async function runCalendarAgentWithLoopCount(params: {
  body: string;
  from: string;
  to: string;
  sessionKey: string;
  cfg: ReturnType<typeof calendarAgentConfig>;
}): Promise<{ reply: unknown; loops: number }> {
  const capturedLogs: string[] = [];
  const originalLog = console.log.bind(console);
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    capturedLogs.push(args.map((entry) => stringifyLogArg(entry)).join(" "));
    if (EMIT_MODEL_LOGS) {
      originalLog(...args);
    }
  });
  try {
    const reply = await getReplyFromConfig(
      {
        Body: params.body,
        From: params.from,
        To: params.to,
        Provider: "webchat",
        SessionKey: params.sessionKey,
      },
      {},
      params.cfg,
    );
    return { reply, loops: countReqStarts(capturedLogs) };
  } finally {
    logSpy.mockRestore();
  }
}

function needsConfirmation(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("confirm") ||
    lower.includes("is that") ||
    lower.includes("is this correct") ||
    lower.includes("correct?") ||
    lower.includes("should i")
  );
}

function pickDateTime(event: Record<string, unknown>, key: "start" | "end"): string {
  const direct = event[key];
  if (typeof direct === "string") {
    return direct;
  }
  if (direct && typeof direct === "object") {
    const rec = direct as Record<string, unknown>;
    const dateTime = rec.dateTime;
    if (typeof dateTime === "string") {
      return dateTime;
    }
  }
  const fallbacks = [
    `${key}Local`,
    `${key}_local`,
    `${key}DateTime`,
    `${key}_date_time`,
    `${key}-local`,
  ];
  for (const candidate of fallbacks) {
    const value = event[candidate];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function toEpochMillis(isoLike: string): number | null {
  if (!isoLike) {
    return null;
  }
  const ms = Date.parse(isoLike);
  if (Number.isNaN(ms)) {
    return null;
  }
  return ms;
}

function assertNotBlockedByMutationSafety(text: string): void {
  const lower = text.toLowerCase();
  expect(lower).not.toContain("no event was changed");
  expect(lower).not.toContain("not executed the calendar command");
}

function calendarAgentConfig(workspaceDir: string, _home: string) {
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
      providers,
    },
  };
}

describe("calendar agent-level e2e – real model", () => {
  let canRun = false;
  let canRunRead = false;
  let canRunLiveWrites = false;

  beforeAll(async () => {
    const ollamaOk = LOCAL_ONLY ? await ollamaAvailable() : true;
    const modelOk = LOCAL_ONLY ? ollamaOk && (await modelAvailable()) : await codexAuthAvailable();
    const gogOk = await gogCalendarAuthAvailable();
    let calendarReadOk = false;
    if (modelOk && gogOk) {
      try {
        await runGogJson(["calendar", "calendars", "--account", CALENDAR_TEST_ACCOUNT, "--json"]);
        calendarReadOk = true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[calendar agent e2e] calendar read preflight failed for account=${CALENDAR_TEST_ACCOUNT}: ${msg}`,
        );
      }
    }
    canRun = modelOk;
    canRunRead = modelOk && calendarReadOk;
    if (canRun) {
      try {
        await runGogJson(["calendar", "calendars", "--account", CALENDAR_TEST_ACCOUNT, "--json"]);
        canRunLiveWrites = true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[calendar agent e2e] live write preflight failed for account=${CALENDAR_TEST_ACCOUNT}: ${msg}`,
        );
      }
    }
    if (!gogOk) {
      throw new Error(
        "[calendar agent e2e] gog calendar auth missing/invalid; run `gog auth add <email> --services calendar`.",
      );
    }
    if (modelOk && !calendarReadOk) {
      throw new Error(
        `[calendar agent e2e] calendar API read preflight failed for account=${CALENDAR_TEST_ACCOUNT}.`,
      );
    }
    if (modelOk && !canRunLiveWrites) {
      throw new Error(
        `[calendar agent e2e] live write preflight failed for account=${CALENDAR_TEST_ACCOUNT}.`,
      );
    }
    if (LOCAL_ONLY && !ollamaOk) {
      console.warn(
        "[calendar agent e2e] Ollama not available at localhost:11434 – skipping. Run `ollama serve`.",
      );
    } else if (!modelOk && LOCAL_ONLY) {
      console.warn(
        `[calendar agent e2e] Model ${LOCAL_MODEL} not found – skipping. Run \`ollama pull ${LOCAL_MODEL}\`.`,
      );
    } else if (!modelOk && !LOCAL_ONLY) {
      console.warn(
        `[calendar agent e2e] Codex auth not found under ${AUTH_HOME}/.openclaw/{credentials/oauth.json,agents/main/agent/auth-profiles.json} – skipping cloud-integrated mode.`,
      );
    }
  });

  it("answers calendar read queries without onboarding prompts", { timeout: 240_000 }, async () => {
    if (!canRunRead) {
      return;
    }
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-agent-e2e-"));
    const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const testUser = `${TEST_USER}-read-${runId}`;
    const testSessionKey = `agent:calendar:read-${runId}`;
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = AUTH_HOME;
      const workspaceDir = path.join(tempRoot, "openclaw-calendar");
      await setupWorkspace(workspaceDir);
      const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      const run = await runCalendarAgentWithLoopCount({
        body: `What’s on my calendar between ${from} and ${to}?`,
        from: testUser,
        to: testUser,
        sessionKey: testSessionKey,
        cfg: calendarAgentConfig(workspaceDir, tempRoot),
      });
      expect(run.loops).toBeLessThanOrEqual(2);

      const text = extractReplyText(run.reply).toLowerCase();
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("quick calendar onboarding");
    } finally {
      process.env.HOME = previousHome;
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it(
    "handles exact natural-language recurring prompt and creates weekly series",
    { timeout: 240_000 },
    async () => {
      if (!canRunLiveWrites) {
        return;
      }
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-agent-e2e-recur-"));
      const previousHome = process.env.HOME;
      const previousGogAccount = process.env.GOG_ACCOUNT;
      const query = "Singing Lesson";
      const testUser = `${TEST_USER}-recur-${Date.now()}`;
      const testSessionKey = `agent:calendar:recur-${Date.now()}`;
      try {
        process.env.HOME = AUTH_HOME;
        process.env.GOG_ACCOUNT = CALENDAR_TEST_ACCOUNT;
        const workspaceDir = path.join(tempRoot, "openclaw-calendar");
        await setupWorkspace(workspaceDir);

        const before = await listRawEventsByQuery(query);
        const beforeIds = new Set(before.map((event) => event.id));

        const cfg = calendarAgentConfig(workspaceDir, tempRoot);
        const send = async (body: string) =>
          runCalendarAgentWithLoopCount({
            body,
            from: testUser,
            to: testUser,
            sessionKey: testSessionKey,
            cfg,
          });

        const recurringStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
        recurringStart.setUTCMinutes(45, 0, 0);
        const recurringEnd = new Date(recurringStart.getTime() + 60 * 60 * 1000);
        const firstRun = await send(
          `Please add a weekly recurring event called "Singing Lesson" starting ` +
            `${recurringStart.toISOString()} and ending ${recurringEnd.toISOString()}.`,
        );
        expect(firstRun.loops).toBeLessThanOrEqual(3);
        const firstReply = extractReplyText(firstRun.reply).toLowerCase();
        if (
          firstReply.includes("confirm") ||
          firstReply.includes("is that") ||
          firstReply.includes("is this correct") ||
          firstReply.includes("should it recur")
        ) {
          const confirmRun = await send("yes");
          expect(confirmRun.loops).toBeLessThanOrEqual(3);
        }

        const after = await listRawEventsByQuery(query);
        const added = after.filter((event) => !beforeIds.has(event.id));
        expect(added.length).toBeGreaterThan(0);

        const recurringSignals = added.filter((event) => {
          const recurringEventId = asScalarString(event.recurringEventId);
          const recurrence = event.recurrence;
          return (
            recurringEventId.length > 0 ||
            (Array.isArray(recurrence) &&
              recurrence.some((entry) => String(entry).toUpperCase().includes("FREQ=WEEKLY")))
          );
        });
        expect(recurringSignals.length).toBeGreaterThan(0);

        // Cleanup newly created events/series from this test.
        const deleteIds = new Set<string>();
        for (const event of added) {
          const recurringEventId = asScalarString(event.recurringEventId).trim();
          if (recurringEventId) {
            deleteIds.add(recurringEventId);
          } else {
            deleteIds.add(event.id);
          }
        }
        for (const eventId of deleteIds) {
          await execFileAsync(
            "gog",
            [
              "calendar",
              "delete",
              CALENDAR_TEST_ID,
              eventId,
              "--account",
              CALENDAR_TEST_ACCOUNT,
              "--force",
            ],
            {
              timeout: 30_000,
              env: {
                ...process.env,
                HOME: AUTH_HOME,
                GOG_ACCOUNT: CALENDAR_TEST_ACCOUNT,
              },
            },
          );
        }
      } finally {
        process.env.HOME = previousHome;
        if (previousGogAccount === undefined) {
          delete process.env.GOG_ACCOUNT;
        } else {
          process.env.GOG_ACCOUNT = previousGogAccount;
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it(
    "creates then deletes a test event on live calendar via agent",
    { timeout: 180_000 },
    async () => {
      if (!canRunLiveWrites) {
        return;
      }
      const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const marker = `[E2E-CALENDAR ${runId}]`;
      const summary = `${marker} OpenClaw Calendar CRUD`;
      const testUser = `${TEST_USER}-crud-${runId}`;
      const testSessionKey = `agent:calendar:crud-${runId}`;
      const now = Date.now();
      const start = new Date(now + 2 * 60 * 60 * 1000);
      start.setUTCSeconds(0, 0);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      const startIso = start.toISOString();
      const endIso = end.toISOString();
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-agent-e2e-live-"));
      const previousHome = process.env.HOME;
      const previousGogAccount = process.env.GOG_ACCOUNT;
      try {
        process.env.HOME = AUTH_HOME;
        process.env.GOG_ACCOUNT = CALENDAR_TEST_ACCOUNT;
        const workspaceDir = path.join(tempRoot, "openclaw-calendar");
        await setupWorkspace(workspaceDir);
        await cleanupEventsByQuery(marker);

        const cfg = calendarAgentConfig(workspaceDir, tempRoot);
        const send = async (body: string) =>
          runCalendarAgentWithLoopCount({
            body,
            from: testUser,
            to: testUser,
            sessionKey: testSessionKey,
            cfg,
          });

        const createPrompt = `Please create a one-time calendar event called "${summary}" from ${startIso} to ${endIso}.`;
        const firstCreateRun = await send(createPrompt);
        expect(firstCreateRun.loops).toBeLessThanOrEqual(3);
        const firstCreate = extractReplyText(firstCreateRun.reply).toLowerCase();
        if (
          firstCreate.includes("confirm") ||
          firstCreate.includes("correct?") ||
          firstCreate.includes("is that")
        ) {
          const confirmRun = await send("yes, please");
          expect(confirmRun.loops).toBeLessThanOrEqual(3);
        }

        const created = await listEventsByQuery(marker);
        expect(created.length).toBeGreaterThan(0);

        const deletePrompt =
          `Please delete the calendar event whose title contains "${marker}". ` +
          `Please only remove the matching test event.`;
        const firstDeleteRun = await send(deletePrompt);
        expect(firstDeleteRun.loops).toBeLessThanOrEqual(3);
        const firstDelete = extractReplyText(firstDeleteRun.reply).toLowerCase();
        if (
          firstDelete.includes("confirm") ||
          firstDelete.includes("correct?") ||
          firstDelete.includes("is that")
        ) {
          const confirmRun = await send("yes, please");
          expect(confirmRun.loops).toBeLessThanOrEqual(3);
        }

        let remaining = await listEventsByQuery(marker);
        if (remaining.length > 0) {
          // Hard cleanup fallback: if agent deletion misses, delete by id with gog directly.
          for (const event of remaining) {
            await execFileAsync(
              "gog",
              [
                "calendar",
                "delete",
                CALENDAR_TEST_ID,
                event.id,
                "--account",
                CALENDAR_TEST_ACCOUNT,
                "--force",
              ],
              {
                timeout: 30_000,
                env: {
                  ...process.env,
                  HOME: AUTH_HOME,
                  GOG_ACCOUNT: CALENDAR_TEST_ACCOUNT,
                },
              },
            );
          }
          remaining = await listEventsByQuery(marker);
        }
        expect(remaining.length).toBe(0);
      } finally {
        try {
          await cleanupEventsByQuery(marker);
        } catch {
          // best-effort cleanup
        }
        process.env.HOME = previousHome;
        if (previousGogAccount === undefined) {
          delete process.env.GOG_ACCOUNT;
        } else {
          process.env.GOG_ACCOUNT = previousGogAccount;
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it(
    "handles exact add prompt plus add/update/reschedule/delete/cancel flows with real model",
    { timeout: 420_000 },
    async () => {
      if (!canRunLiveWrites) {
        return;
      }

      const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const summaryV1 = `[E2E-MUT ${runId}] Ani fundraiser`;
      const summaryV2 = `${summaryV1} updated`;
      const summaryV3 = `${summaryV1} rescheduled`;
      const recurringSummary = `[E2E-MUT ${runId}] Weekly check-in`;
      const testUser = `${TEST_USER}-mut-${runId}`;
      const testSessionKey = `agent:calendar:mut-${runId}`;
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-agent-e2e-mutation-"));
      const previousHome = process.env.HOME;
      const previousGogAccount = process.env.GOG_ACCOUNT;

      const now = Date.now();
      const from1 = new Date(now + 3 * 60 * 60 * 1000);
      from1.setUTCSeconds(0, 0);
      const to1 = new Date(from1.getTime() + 60 * 60 * 1000);
      const from2 = new Date(from1.getTime() + 2 * 60 * 60 * 1000);
      const to2 = new Date(from2.getTime() + 60 * 60 * 1000);
      const from3 = new Date(from2.getTime() + 2 * 60 * 60 * 1000);
      const to3 = new Date(from3.getTime() + 60 * 60 * 1000);
      const fromRecurring = new Date(now + 24 * 60 * 60 * 1000);
      fromRecurring.setUTCSeconds(0, 0);
      const toRecurring = new Date(fromRecurring.getTime() + 45 * 60 * 1000);

      try {
        process.env.HOME = AUTH_HOME;
        process.env.GOG_ACCOUNT = CALENDAR_TEST_ACCOUNT;
        const workspaceDir = path.join(tempRoot, "openclaw-calendar");
        await setupWorkspace(workspaceDir);
        await cleanupEventsByQuery("Ani");
        await cleanupEventsByQuery(summaryV1);
        await cleanupEventsByQuery(summaryV2);
        await cleanupEventsByQuery(summaryV3);
        await cleanupEventsByQuery(recurringSummary);

        const cfg = calendarAgentConfig(workspaceDir, tempRoot);
        const send = async (body: string) =>
          runCalendarAgentWithLoopCount({
            body,
            from: testUser,
            to: testUser,
            sessionKey: testSessionKey,
            cfg,
          });
        const sendWithOptionalConfirm = async (prompt: string, confirmText: string) => {
          const firstRun = await send(prompt);
          expect(firstRun.loops).toBeLessThanOrEqual(3);
          const first = extractReplyText(firstRun.reply);
          if (needsConfirmation(first)) {
            const secondRun = await send(confirmText);
            expect(secondRun.loops).toBeLessThanOrEqual(3);
            const second = extractReplyText(secondRun.reply);
            return `${first}\n${second}`;
          }
          return first;
        };

        const exactAddReply = await sendWithOptionalConfirm(
          "Add Ani’s fundraiser for march 5th 530-730",
          "yes, please",
        );
        assertNotBlockedByMutationSafety(exactAddReply);
        const aniEvents = await listRawEventsByQuery("Ani");
        const expectedFromUtc = Date.parse("2026-03-06T01:30:00Z");
        const expectedToUtc = Date.parse("2026-03-06T03:30:00Z");
        const matchingWindowCount = aniEvents.filter((event) => {
          const fromMs = toEpochMillis(pickDateTime(event, "start"));
          const toMs = toEpochMillis(pickDateTime(event, "end"));
          return fromMs === expectedFromUtc && toMs === expectedToUtc;
        }).length;
        expect(matchingWindowCount).toBeGreaterThan(0);

        const addReply = await sendWithOptionalConfirm(
          `Please create a one-time event called "${summaryV1}" from ${from1.toISOString()} to ${to1.toISOString()}. ` +
            `Thanks.`,
          "yes, please",
        );
        assertNotBlockedByMutationSafety(addReply);
        expect((await waitForEventsByQuery({ query: summaryV1 })).length).toBeGreaterThan(0);

        const updateReply = await sendWithOptionalConfirm(
          `Please update the event whose title contains "${summaryV1}". ` +
            `Change the title to "${summaryV2}" and set it to ${from2.toISOString()} through ${to2.toISOString()}.`,
          "yes, please",
        );
        assertNotBlockedByMutationSafety(updateReply);
        expect((await waitForEventsByQuery({ query: summaryV2 })).length).toBeGreaterThan(0);

        const rescheduleReply = await sendWithOptionalConfirm(
          `Please reschedule the event whose title contains "${summaryV2}". ` +
            `Rename it to "${summaryV3}" and move it to ${from3.toISOString()} through ${to3.toISOString()}.`,
          "yes, please",
        );
        assertNotBlockedByMutationSafety(rescheduleReply);
        expect((await waitForEventsByQuery({ query: summaryV3 })).length).toBeGreaterThan(0);

        const deleteReply = await sendWithOptionalConfirm(
          `Please delete the event whose title contains "${summaryV3}".`,
          "yes, please",
        );
        assertNotBlockedByMutationSafety(deleteReply);
        expect((await listEventsByQuery(summaryV3)).length).toBe(0);

        const recurringAddReply = await sendWithOptionalConfirm(
          `Please create a weekly recurring event called "${recurringSummary}" ` +
            `from ${fromRecurring.toISOString()} to ${toRecurring.toISOString()}.`,
          "yes, please",
        );
        assertNotBlockedByMutationSafety(recurringAddReply);
        const recurringEvents = await listRawEventsByQuery(recurringSummary);
        expect(recurringEvents.length).toBeGreaterThan(0);

        const cancelReply = await sendWithOptionalConfirm(
          `Please cancel and delete recurring events whose title contains "${recurringSummary}".`,
          "yes, please",
        );
        assertNotBlockedByMutationSafety(cancelReply);
        expect((await listEventsByQuery(recurringSummary)).length).toBe(0);
      } finally {
        try {
          await cleanupEventsByQuery("Ani");
          await cleanupEventsByQuery(summaryV1);
          await cleanupEventsByQuery(summaryV2);
          await cleanupEventsByQuery(summaryV3);
          await cleanupEventsByQuery(recurringSummary);
        } catch {
          // best-effort cleanup
        }
        process.env.HOME = previousHome;
        if (previousGogAccount === undefined) {
          delete process.env.GOG_ACCOUNT;
        } else {
          process.env.GOG_ACCOUNT = previousGogAccount;
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    },
  );
});
