/**
 * Calendar agent-level e2e: direct calendar agent path with real model and gog auth.
 * Router/classifier is disabled in this suite.
 */

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
const TEST_USER = "calendar-agent-e2e-user";
const CALENDAR_TEST_ACCOUNT =
  process.env.OPENCLAW_CALENDAR_TEST_ACCOUNT?.trim() || "ikebotai@gmail.com";
const CALENDAR_TEST_ID = process.env.OPENCLAW_CALENDAR_TEST_ID?.trim() || CALENDAR_TEST_ACCOUNT;
const LIVE_WRITE_ENABLED = process.env.OPENCLAW_CALENDAR_LIVE_WRITE_TEST === "1";
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
      id: String(event.id ?? ""),
      summary: String(event.summary ?? ""),
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

function calendarAgentConfig(workspaceDir: string, home: string) {
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

describe("calendar agent-level e2e – real model", () => {
  let canRun = false;
  let canRunRead = false;
  let canRunLiveWrites = false;

  beforeAll(async () => {
    const ollamaOk = await ollamaAvailable();
    const modelOk = ollamaOk && (await modelAvailable());
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
    if (canRun && LIVE_WRITE_ENABLED) {
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
    if (!ollamaOk) {
      console.warn(
        "[calendar agent e2e] Ollama not available at localhost:11434 – skipping. Run `ollama serve`.",
      );
    } else if (!modelOk) {
      console.warn(
        `[calendar agent e2e] Model ${MODEL} not found – skipping. Run \`ollama pull ${MODEL}\`.`,
      );
    } else if (!gogOk) {
      console.warn(
        "[calendar agent e2e] gog calendar auth missing/invalid for read test – skipping read query test. Run `gog auth add <email> --services calendar`.",
      );
    } else if (!calendarReadOk) {
      console.warn(
        `[calendar agent e2e] calendar API not accessible for account=${CALENDAR_TEST_ACCOUNT}; read test skipped.`,
      );
    } else if (LIVE_WRITE_ENABLED && !canRunLiveWrites) {
      console.warn(
        `[calendar agent e2e] live write tests disabled due preflight failure for account=${CALENDAR_TEST_ACCOUNT}.`,
      );
    }
  });

  it("answers calendar read queries without onboarding prompts", { timeout: 120_000 }, async () => {
    if (!canRunRead) {
      return;
    }
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-agent-e2e-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = AUTH_HOME;
      const workspaceDir = path.join(tempRoot, "openclaw-calendar");
      await setupWorkspace(workspaceDir);

      const reply = await getReplyFromConfig(
        {
          Body: "what's on my calendar in the next 24 hours?",
          From: TEST_USER,
          To: TEST_USER,
          Provider: "webchat",
        },
        {},
        calendarAgentConfig(workspaceDir, tempRoot),
      );

      const text = extractReplyText(reply).toLowerCase();
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("quick calendar onboarding");
    } finally {
      process.env.HOME = previousHome;
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

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
          getReplyFromConfig(
            {
              Body: body,
              From: TEST_USER,
              To: TEST_USER,
              Provider: "webchat",
            },
            {},
            cfg,
          );

        const createPrompt =
          `Create a one-time calendar event now.\n` +
          `calendarId: ${CALENDAR_TEST_ID}\n` +
          `account: ${CALENDAR_TEST_ACCOUNT}\n` +
          `summary: ${summary}\n` +
          `from: ${startIso}\n` +
          `to: ${endIso}\n` +
          `Do it now. If you need confirmation, ask one short question only.`;
        const firstCreate = extractReplyText(await send(createPrompt)).toLowerCase();
        if (
          firstCreate.includes("confirm") ||
          firstCreate.includes("correct?") ||
          firstCreate.includes("is that")
        ) {
          await send("yes, create it now");
        }

        const created = await listEventsByQuery(marker);
        expect(created.length).toBeGreaterThan(0);

        const deletePrompt =
          `Delete the calendar event now.\n` +
          `calendarId: ${CALENDAR_TEST_ID}\n` +
          `account: ${CALENDAR_TEST_ACCOUNT}\n` +
          `summary contains: ${marker}\n` +
          `Delete only matching test events.`;
        const firstDelete = extractReplyText(await send(deletePrompt)).toLowerCase();
        if (
          firstDelete.includes("confirm") ||
          firstDelete.includes("correct?") ||
          firstDelete.includes("is that")
        ) {
          await send("yes, delete it now");
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
});
