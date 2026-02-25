import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getReplyFromConfig } from "../../pipeline/reply.js";

vi.mock("../../onboarding/service.js", () => ({
  maybeRunAgentOnboarding: vi.fn(async () => undefined),
}));

type TelemetryEvent = {
  runId?: string;
  stream?: string;
  sessionKey?: string;
  data?: Record<string, unknown>;
};

const MODEL_PROVIDER = "openai-codex";
const MODEL = process.env.OPENCLAW_MAIL_TEST_CLOUD_MODEL?.trim() || "gpt-5.1-codex-mini";
const AUTH_HOME =
  process.env.OPENCLAW_MAIL_AUTH_HOME?.trim() || os.userInfo().homedir || "/Users/ikebot";
const MAIL_PROMPT = "Can you check what time my Bangkok to Hanoi flight is? It’s in my emails";

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
  } catch {
    // fallback to auth-profiles probe below
  }
  try {
    const raw = await fs.readFile(authProfilesPath, "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { provider?: string; type?: string }>;
    };
    const profiles = parsed.profiles ?? {};
    return Object.values(profiles).some(
      (profile) => profile?.provider === "openai-codex" && profile?.type === "oauth",
    );
  } catch {
    return false;
  }
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
  const targetMailAuthProfiles = path.join(
    stateDir,
    "agents",
    "mail",
    "agent",
    "auth-profiles.json",
  );
  if (sourceOauth) {
    await fs.mkdir(path.dirname(targetOauth), { recursive: true });
    await fs.copyFile(sourceOauth, targetOauth);
  }
  if (sourceAuthProfiles) {
    await fs.mkdir(path.dirname(targetMainAuthProfiles), { recursive: true });
    await fs.mkdir(path.dirname(targetMailAuthProfiles), { recursive: true });
    await fs.copyFile(sourceAuthProfiles, targetMainAuthProfiles);
    await fs.copyFile(sourceAuthProfiles, targetMailAuthProfiles);
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
  timeoutMs = 12_000,
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

function buildConfig(params: {
  mainWorkspace: string;
  mailWorkspace: string;
  qmdCommand: string;
  qmdPath: string;
}) {
  return {
    plugins: {
      enabled: true,
      slots: {
        memory: "memory-core",
      },
      entries: {
        "memory-core": { enabled: true },
      },
    },
    agents: {
      defaults: {
        model: `${MODEL_PROVIDER}/${MODEL}`,
        routing: { enabled: true, classifierModel: `${MODEL_PROVIDER}/${MODEL}` },
        workspace: params.mainWorkspace,
      },
      list: [
        { id: "main", default: true, workspace: params.mainWorkspace, tools: { allow: [] } },
        {
          id: "mail",
          workspace: params.mailWorkspace,
          tools: {
            profile: "minimal",
            alsoAllow: ["group:memory"],
            deny: ["exec", "process"],
          },
        },
      ],
    },
    memory: {
      backend: "qmd",
      qmd: {
        command: params.qmdCommand,
        includeDefaultMemory: false,
        paths: [{ name: "tickets", path: params.qmdPath, pattern: "**/*.md" }],
        update: {
          onBoot: true,
          waitForBootSync: true,
          interval: "0s",
          embedInterval: "0s",
        },
      },
    },
    channels: { bluebubbles: { allowFrom: ["*"] } },
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

describe("mail qmd lookup e2e", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await codexAuthAvailable();
    if (!canRun) {
      console.warn(
        "[mail qmd e2e] OpenAI Codex auth not found. Set ~/.openclaw credentials/auth-profiles.",
      );
    }
  });

  it(
    "routes email lookup to mail + qmd memory and never attempts exec",
    { timeout: 240_000 },
    async () => {
      if (!canRun) {
        return;
      }
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mail-qmd-e2e-"));
      const stateDir = path.join(tempRoot, "state");
      const mainWorkspace = path.join(tempRoot, "workspace-main");
      const mailWorkspace = path.join(tempRoot, "workspace-mail");
      const qmdDocsDir = path.join(mailWorkspace, "qmd", "emails", "important");
      const qmdLogPath = path.join(tempRoot, "qmd-calls.log");
      const qmdCommandPath = path.join(tempRoot, "fake-qmd.sh");
      const telemetryPath = path.join(stateDir, "logs", "telemetry.jsonl");
      const sessionKey = `bluebubbles:direct:mail-qmd-e2e:${Date.now()}`;
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;

      try {
        await fs.mkdir(mainWorkspace, { recursive: true });
        await fs.mkdir(mailWorkspace, { recursive: true });
        await fs.mkdir(qmdDocsDir, { recursive: true });

        // Bias model behavior toward memory tools in this test workspace.
        await fs.writeFile(
          path.join(mailWorkspace, "TOOLS.md"),
          [
            "# Tools",
            "",
            "- For email lookup questions, use `memory_search` first.",
            "- If memory_search returns a path, use `memory_get` for the exact detail.",
            "- Do not use shell commands.",
            "",
          ].join("\n"),
          "utf8",
        );

        await fs.writeFile(
          path.join(qmdDocsDir, "bangkok-hanoi-flight.md"),
          [
            "# Flight Confirmation",
            "",
            "Route: Bangkok (BKK) to Hanoi (HAN)",
            "Departure Time: 07:20 AM (ICT)",
            "Airline: Vietnam Airlines",
            "",
          ].join("\n"),
          "utf8",
        );

        await fs.writeFile(
          qmdCommandPath,
          `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${qmdLogPath}"
if [ "$#" -ge 3 ] && [ "$1" = "collection" ] && [ "$2" = "list" ] && [ "$3" = "--json" ]; then
  echo '[]'
  exit 0
fi
if [ "$#" -ge 2 ] && [ "$1" = "collection" ] && [ "$2" = "add" ]; then
  exit 0
fi
if [ "$#" -ge 1 ] && [ "$1" = "update" ]; then
  exit 0
fi
if [ "$#" -ge 1 ] && [ "$1" = "embed" ]; then
  exit 0
fi
if [ "$#" -ge 1 ] && [ "$1" = "query" ]; then
  cat <<'JSON'
[{"docid":"abc123","score":0.98,"snippet":"@@ -3,2 @@\\nRoute: Bangkok (BKK) to Hanoi (HAN)\\nDeparture Time: 07:20 AM (ICT)"}]
JSON
  exit 0
fi
echo "unsupported command: $*" >&2
exit 1
`,
          { encoding: "utf8", mode: 0o755 },
        );

        // Seed the sqlite index row that maps query docid -> collection/path.
        const indexPath = path.join(
          stateDir,
          "agents",
          "mail",
          "qmd",
          "xdg-cache",
          "qmd",
          "index.sqlite",
        );
        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        const db = new DatabaseSync(indexPath);
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS documents (
              hash TEXT,
              collection TEXT,
              path TEXT,
              active INTEGER
            );
            DELETE FROM documents;
          `);
          db.prepare(
            "INSERT INTO documents (hash, collection, path, active) VALUES (?, ?, ?, 1)",
          ).run("abc123", "tickets", "bangkok-hanoi-flight.md");
        } finally {
          db.close();
        }

        process.env.OPENCLAW_STATE_DIR = stateDir;
        await seedCodexAuthForStateDir(stateDir);

        const cfg = buildConfig({
          mainWorkspace,
          mailWorkspace,
          qmdCommand: qmdCommandPath,
          qmdPath: qmdDocsDir,
        });

        const reply = await getReplyFromConfig(
          {
            Body: MAIL_PROMPT,
            From: "ikelee98@gmail.com",
            To: "ikelee98@gmail.com",
            Provider: "bluebubbles",
            SessionKey: sessionKey,
          },
          {},
          cfg,
        );

        const replyText = extractReplyText(reply).toLowerCase();
        expect(replyText.length).toBeGreaterThan(0);
        expect(replyText).toMatch(/07:20|7:20|07.20|7.20/);

        const runEvents = await waitForLatestRunTelemetryEnd(telemetryPath, sessionKey);
        expect(runEvents.length).toBeGreaterThan(0);

        const routedToMail = runEvents.some(
          (evt) => evt.data?.kind === "agent_loop.start" && evt.data?.agentId === "mail",
        );
        expect(routedToMail).toBe(true);

        const toolNames = runEvents
          .filter((evt) => evt.data?.kind === "tool_loop.end")
          .flatMap((evt) => {
            const names = evt.data?.toolNames;
            return Array.isArray(names) ? names : [];
          })
          .map((name) => String(name).trim().toLowerCase())
          .filter(Boolean);

        expect(toolNames).toContain("memory_search");
        expect(toolNames).not.toContain("exec");

        const qmdCallsRaw = await fs.readFile(qmdLogPath, "utf8");
        const qmdCalls = qmdCallsRaw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        expect(qmdCalls.some((line) => line.startsWith("query "))).toBe(true);
      } finally {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    },
  );
});
