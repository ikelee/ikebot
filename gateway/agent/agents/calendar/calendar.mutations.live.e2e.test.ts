import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { getReplyFromConfig } from "../../pipeline/reply.js";

const execFileAsync = promisify(execFile);
const OLLAMA_BASE = "http://localhost:11434";
const MODEL = process.env.OPENCLAW_CALENDAR_TEST_MODEL?.trim() || "qwen2.5:14b";
const CALENDAR_TEST_ACCOUNT =
  process.env.OPENCLAW_CALENDAR_TEST_ACCOUNT?.trim() || "ikebotai@gmail.com";
const CALENDAR_TEST_ID = process.env.OPENCLAW_CALENDAR_TEST_ID?.trim() || CALENDAR_TEST_ACCOUNT;
// Live writes are enabled by default for the sandbox calendar account.
// Set OPENCLAW_CALENDAR_LIVE_WRITE_TEST=0 to force-disable.
const LIVE_WRITE_ENABLED = process.env.OPENCLAW_CALENDAR_LIVE_WRITE_TEST !== "0";
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
      (m) => (m.name ?? "").startsWith(MODEL) || (m.model ?? "").startsWith(MODEL),
    );
  } catch {
    return false;
  }
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
  } catch {
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
  for (const key of ["events", "items", "results", "data"]) {
    const nested = extractEvents(rec[key]);
    if (nested.length > 0) {
      return nested;
    }
  }
  return [];
}

async function listEventsByQuery(query: string): Promise<Array<{ id: string; summary: string }>> {
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
  return extractEvents(payload)
    .map((event) => ({ id: String(event.id ?? ""), summary: String(event.summary ?? "") }))
    .filter((event) => event.id.length > 0);
}

async function listRawEventsByQuery(query: string): Promise<Array<Record<string, unknown>>> {
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
  return extractEvents(payload);
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

function assertNotBlockedByMutationSafety(text: string): void {
  const lower = text.toLowerCase();
  expect(lower).not.toContain("no event was changed");
  expect(lower).not.toContain("not executed the calendar command");
}

function calendarAgentConfig(workspaceDir: string) {
  return {
    agents: {
      defaults: {
        model: `ollama/${MODEL}`,
        routing: { enabled: false, classifierModel: `ollama/${MODEL}` },
        workspace: workspaceDir,
      },
      list: [
        {
          id: "calendar",
          default: true,
          workspace: workspaceDir,
          skills: ["gog"],
          tools: { exec: { security: "allowlist", safeBins: ["gog"] } },
        },
      ],
    },
    channels: { webchat: { allowFrom: ["*"] } },
    models: {
      providers: {
        ollama: {
          baseUrl: `${OLLAMA_BASE}/v1`,
          api: "openai-completions",
          models: [
            {
              id: MODEL,
              name: "Qwen 2.5",
              api: "openai-completions",
              contextWindow: 32768,
              cost: { input: 0, output: 0 },
            },
          ],
        },
      },
    },
  };
}

describe("calendar mutation live e2e – real model", () => {
  let canRunLiveWrites = false;

  beforeAll(async () => {
    const ollamaOk = await ollamaAvailable();
    const modelOk = ollamaOk && (await modelAvailable());
    const gogOk = await gogCalendarAuthAvailable();
    if (modelOk && gogOk && LIVE_WRITE_ENABLED) {
      try {
        await runGogJson(["calendar", "calendars", "--account", CALENDAR_TEST_ACCOUNT, "--json"]);
        canRunLiveWrites = true;
      } catch {
        canRunLiveWrites = false;
      }
    }
  });

  it("executes exact Ani add prompt plus live modify flow", { timeout: 260_000 }, async () => {
    if (!canRunLiveWrites) {
      return;
    }

    const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const testUser = `calendar-agent-live-${runId}`;
    const testSessionKey = `agent:calendar:live-${runId}`;
    const aniSummary = "Ani's fundraiser";
    const baselineSummary = `[E2E-MUT ${runId}] Baseline event`;
    const summaryV2 = `[E2E-MUT ${runId}] Ani fundraiser updated`;
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-agent-e2e-live-mut-"));
    const previousHome = process.env.HOME;
    const previousGogAccount = process.env.GOG_ACCOUNT;

    const now = Date.now();
    const fromBase = new Date(now + 4 * 60 * 60 * 1000);
    fromBase.setUTCSeconds(0, 0);
    const toBase = new Date(fromBase.getTime() + 60 * 60 * 1000);
    const from2 = new Date(fromBase.getTime() + 2 * 60 * 60 * 1000);
    const to2 = new Date(from2.getTime() + 60 * 60 * 1000);
    try {
      process.env.HOME = AUTH_HOME;
      process.env.GOG_ACCOUNT = CALENDAR_TEST_ACCOUNT;
      const workspaceDir = path.join(tempRoot, "openclaw-calendar");
      await setupWorkspace(workspaceDir);
      await cleanupEventsByQuery("Ani");
      await cleanupEventsByQuery(baselineSummary);
      await cleanupEventsByQuery(summaryV2);

      const cfg = calendarAgentConfig(workspaceDir);
      const sendWithOptionalConfirm = async (
        prompt: string,
        confirmText: string,
        sessionSuffix: string,
      ) => {
        const turnSessionKey = `${testSessionKey}:${sessionSuffix}`;
        const send = async (body: string) =>
          getReplyFromConfig(
            {
              Body: body,
              From: testUser,
              To: testUser,
              Provider: "webchat",
              SessionKey: turnSessionKey,
            },
            {},
            cfg,
          );
        const first = extractReplyText(await send(prompt));
        if (needsConfirmation(first)) {
          const second = extractReplyText(await send(confirmText));
          return `${first}\n${second}`;
        }
        return first;
      };

      const exactAniReply = await sendWithOptionalConfirm(
        "Add Ani’s fundraiser for march 5th 530-730",
        "yes, add it now",
        "exact-ani-create",
      );
      assertNotBlockedByMutationSafety(exactAniReply);
      expect(exactAniReply.toLowerCase()).toContain("added to your calendar");
      expect(exactAniReply.toLowerCase()).toContain("google.com/calendar/event");
      const aniEvents = await listRawEventsByQuery("Ani");
      const expectedFromUtc = Date.parse("2026-03-06T01:30:00Z");
      const expectedToUtc = Date.parse("2026-03-06T03:30:00Z");
      const matchingWindowCount = aniEvents.filter((event) => {
        const fromMs = toEpochMillis(pickDateTime(event, "start"));
        const toMs = toEpochMillis(pickDateTime(event, "end"));
        return fromMs === expectedFromUtc && toMs === expectedToUtc;
      }).length;
      expect(matchingWindowCount).toBe(1);

      await execFileAsync(
        "gog",
        [
          "calendar",
          "create",
          CALENDAR_TEST_ID,
          "--account",
          CALENDAR_TEST_ACCOUNT,
          "--summary",
          baselineSummary,
          "--from",
          fromBase.toISOString(),
          "--to",
          toBase.toISOString(),
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
      const baselineEvents = await listEventsByQuery(baselineSummary);
      expect(baselineEvents.length).toBeGreaterThan(0);
      const baselineEventId = baselineEvents[0].id;

      const modifyReply = await sendWithOptionalConfirm(
        `Update this event now.\ncalendarId: ${CALENDAR_TEST_ID}\naccount: ${CALENDAR_TEST_ACCOUNT}\neventId: ${baselineEventId}\nnew summary: ${summaryV2}\nfrom: ${from2.toISOString()}\nto: ${to2.toISOString()}\nUse this eventId directly.`,
        `Use eventId ${baselineEventId} and update it now.`,
        "modify",
      );
      assertNotBlockedByMutationSafety(modifyReply);
      expect((await listEventsByQuery(summaryV2)).length).toBeGreaterThan(0);
    } finally {
      try {
        await cleanupEventsByQuery("Ani");
        await cleanupEventsByQuery(baselineSummary);
        await cleanupEventsByQuery(summaryV2);
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
  });
});
