import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getReplyFromConfig } from "../../pipeline/reply.js";

const OLLAMA_BASE = "http://localhost:11434";
const MODEL = process.env.OPENCLAW_CALENDAR_TEST_MODEL?.trim() || "qwen2.5:14b";
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
          tools: { allow: ["exec"], exec: { security: "allowlist", safeBins: ["gog"] } },
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

function extractReplyText(reply: unknown): string {
  const payload = Array.isArray(reply) ? reply[0] : reply;
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function parseCommandLine(raw: string): string {
  return raw.trim();
}

function extractFlagValue(command: string, flag: "--from" | "--to"): string {
  const re = new RegExp(`${flag}\\s+([^\\s]+)`);
  const match = command.match(re);
  return match?.[1] ?? "";
}

describe("calendar prompt stability (real model, fake gog)", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = (await ollamaAvailable()) && (await modelAvailable());
  });

  it(
    "uses deterministic UTC window on first create command for the exact Ani prompt",
    { timeout: 180_000 },
    async () => {
      if (!canRun) {
        return;
      }
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-prompt-stability-"));
      const workspaceDir = path.join(tempRoot, "workspace-calendar");
      const fakeBinDir = path.join(tempRoot, "bin");
      const fakeGogPath = path.join(fakeBinDir, "gog");
      const commandLogPath = path.join(tempRoot, "fake-gog-commands.log");
      const previousPath = process.env.PATH ?? "";
      const previousLogPath = process.env.OPENCLAW_FAKE_GOG_LOG;
      try {
        await setupWorkspace(workspaceDir);
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
echo -e "id\\tfake-event-id"
echo -e "summary\\t\${summary:-Ani’s fundraiser}"
echo -e "timezone\\tUTC"
echo -e "start\\t\${from:-2026-03-06T01:30:00Z}"
echo -e "start-local\\t\${from:-2026-03-06T01:30:00Z}"
echo -e "end\\t\${to:-2026-03-06T03:30:00Z}"
echo -e "end-local\\t\${to:-2026-03-06T03:30:00Z}"
echo -e "link\\thttps://www.google.com/calendar/event?eid=fake"
`;
        await fs.writeFile(fakeGogPath, script, { encoding: "utf8", mode: 0o755 });

        process.env.PATH = `${fakeBinDir}:${previousPath}`;
        process.env.OPENCLAW_FAKE_GOG_LOG = commandLogPath;

        const reply = await getReplyFromConfig(
          {
            Body: "[Fri 2026-02-20 12:30 PST] Add Ani’s fundraiser for march 5th 530-730",
            From: "calendar-prompt-stability-user",
            To: "calendar-prompt-stability-user",
            Provider: "webchat",
            SessionKey: "agent:calendar:prompt-stability:single",
          },
          {},
          calendarAgentConfig(workspaceDir),
        );

        const text = extractReplyText(reply).toLowerCase();
        expect(text).toContain("added");
        const raw = await fs.readFile(commandLogPath, "utf8");
        const lines = raw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const firstCreate = lines.find((line) => line.startsWith("calendar create "));
        expect(firstCreate).toBeTruthy();
        const command = parseCommandLine(firstCreate ?? "");
        const fromVal = extractFlagValue(command, "--from");
        const toVal = extractFlagValue(command, "--to");
        expect(Date.parse(fromVal)).toBe(Date.parse("2026-03-06T01:30:00Z"));
        expect(Date.parse(toVal)).toBe(Date.parse("2026-03-06T03:30:00Z"));
      } finally {
        process.env.PATH = previousPath;
        if (previousLogPath === undefined) {
          delete process.env.OPENCLAW_FAKE_GOG_LOG;
        } else {
          process.env.OPENCLAW_FAKE_GOG_LOG = previousLogPath;
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it(
    "optional stress: keeps high first-command correctness rate for Ani prompt",
    { timeout: 900_000 },
    async () => {
      if (!canRun || process.env.OPENCLAW_CALENDAR_PROMPT_STRESS !== "1") {
        return;
      }
      const runs = Number(process.env.OPENCLAW_CALENDAR_PROMPT_STRESS_RUNS ?? "6");
      let success = 0;
      for (let i = 0; i < runs; i += 1) {
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `calendar-prompt-stress-${i}-`));
        const workspaceDir = path.join(tempRoot, "workspace-calendar");
        const fakeBinDir = path.join(tempRoot, "bin");
        const fakeGogPath = path.join(fakeBinDir, "gog");
        const commandLogPath = path.join(tempRoot, "fake-gog-commands.log");
        const previousPath = process.env.PATH ?? "";
        const previousLogPath = process.env.OPENCLAW_FAKE_GOG_LOG;
        try {
          await setupWorkspace(workspaceDir);
          await fs.mkdir(fakeBinDir, { recursive: true });
          await fs.writeFile(
            fakeGogPath,
            `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${commandLogPath}"
echo -e "id\\tfake-event-id"
echo -e "summary\\tAni’s fundraiser"
echo -e "start\\t2026-03-06T01:30:00Z"
echo -e "end\\t2026-03-06T03:30:00Z"
echo -e "link\\thttps://www.google.com/calendar/event?eid=fake"
`,
            { encoding: "utf8", mode: 0o755 },
          );
          process.env.PATH = `${fakeBinDir}:${previousPath}`;
          process.env.OPENCLAW_FAKE_GOG_LOG = commandLogPath;

          await getReplyFromConfig(
            {
              Body: "[Fri 2026-02-20 12:30 PST] Add Ani’s fundraiser for march 5th 530-730",
              From: `calendar-prompt-stability-user-${i}`,
              To: `calendar-prompt-stability-user-${i}`,
              Provider: "webchat",
              SessionKey: `agent:calendar:prompt-stability:stress:${i}`,
            },
            {},
            calendarAgentConfig(workspaceDir),
          );

          const raw = await fs.readFile(commandLogPath, "utf8");
          const lines = raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          const firstCreate = lines.find((line) => line.startsWith("calendar create "));
          const fromVal =
            typeof firstCreate === "string" ? extractFlagValue(firstCreate, "--from") : "";
          const toVal =
            typeof firstCreate === "string" ? extractFlagValue(firstCreate, "--to") : "";
          const ok =
            typeof firstCreate === "string" &&
            Date.parse(fromVal) === Date.parse("2026-03-06T01:30:00Z") &&
            Date.parse(toVal) === Date.parse("2026-03-06T03:30:00Z");
          if (ok) {
            success += 1;
          }
        } finally {
          process.env.PATH = previousPath;
          if (previousLogPath === undefined) {
            delete process.env.OPENCLAW_FAKE_GOG_LOG;
          } else {
            process.env.OPENCLAW_FAKE_GOG_LOG = previousLogPath;
          }
          await fs.rm(tempRoot, { recursive: true, force: true });
        }
      }
      const successRate = success / runs;
      expect(successRate).toBeGreaterThanOrEqual(0.9);
    },
  );
});
