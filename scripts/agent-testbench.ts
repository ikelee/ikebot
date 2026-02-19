import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { agentCommand } from "../gateway/entrypoints/entry/commands/agent.js";
import { loadConfig } from "../gateway/infra/config/config.js";
import { normalizeAgentId } from "../gateway/infra/routing/session-key.js";
import { resolveAgentWorkspaceDir } from "../gateway/runtime/agent-scope.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
} from "../gateway/runtime/workspace.js";

type Snapshot = {
  name: string;
  path: string;
  missing: boolean;
  content: string;
};

type Args = {
  agentId: string;
  message: string;
  sessionKey: string;
  undo: boolean;
};

function parseArgs(argv: string[]): Args {
  let agentId = "";
  let message = "";
  let sessionKey = "";
  let undo = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--agent") {
      agentId = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--message") {
      message = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--session-key") {
      sessionKey = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--undo") {
      undo = true;
    }
  }

  if (!agentId.trim()) {
    throw new Error("Missing --agent <id>");
  }
  if (!message.trim()) {
    throw new Error("Missing --message <text>");
  }

  const normalizedAgentId = normalizeAgentId(agentId.trim());
  return {
    agentId: normalizedAgentId,
    message: message.trim(),
    sessionKey: sessionKey.trim() || `agent:${normalizedAgentId}:testing`,
    undo,
  };
}

async function safeRead(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function fileNamesForAgent(agentId: string, workspaceDir: string): Promise<string[]> {
  const names = new Set<string>([
    DEFAULT_AGENTS_FILENAME,
    DEFAULT_SOUL_FILENAME,
    DEFAULT_TOOLS_FILENAME,
    DEFAULT_IDENTITY_FILENAME,
    DEFAULT_USER_FILENAME,
    DEFAULT_HEARTBEAT_FILENAME,
    DEFAULT_BOOTSTRAP_FILENAME,
    DEFAULT_MEMORY_FILENAME,
    DEFAULT_MEMORY_ALT_FILENAME,
  ]);
  if (agentId !== "workouts") {
    return Promise.resolve(Array.from(names));
  }
  names.add("workouts.json");
  names.add("workout-notes.txt");
  names.add("workout_logs.txt");
  return fs
    .readdir(workspaceDir, { withFileTypes: true })
    .then((entries) => {
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        if (/^workout-memo-[a-z0-9_-]+\.md$/i.test(entry.name)) {
          names.add(entry.name);
        }
      }
      return Array.from(names);
    })
    .catch(() => Array.from(names));
}

async function snapshotFiles(
  workspaceDir: string,
  fileNames: string[],
): Promise<Record<string, Snapshot>> {
  const out: Record<string, Snapshot> = {};
  for (const name of fileNames) {
    const filePath = path.join(workspaceDir, name);
    const content = await safeRead(filePath);
    out[name] = {
      name,
      path: filePath,
      missing: content == null,
      content: content ?? "",
    };
  }
  return out;
}

function lineCount(text: string): number {
  return text ? text.split(/\r?\n/).length : 0;
}

function changedFiles(
  before: Record<string, Snapshot>,
  after: Record<string, Snapshot>,
): Array<{
  name: string;
  status: "created" | "modified" | "deleted";
  beforeLines: number;
  afterLines: number;
}> {
  const names = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  const changes: Array<{
    name: string;
    status: "created" | "modified" | "deleted";
    beforeLines: number;
    afterLines: number;
  }> = [];
  for (const name of names) {
    const a = before[name];
    const b = after[name];
    if (!a || !b) {
      continue;
    }
    if (a.missing === b.missing && a.content === b.content) {
      continue;
    }
    const status =
      a.missing && !b.missing ? "created" : !a.missing && b.missing ? "deleted" : "modified";
    changes.push({
      name,
      status,
      beforeLines: lineCount(a.content),
      afterLines: lineCount(b.content),
    });
  }
  return changes.toSorted((x, y) => x.name.localeCompare(y.name));
}

async function undoChanges(before: Record<string, Snapshot>, changes: Array<{ name: string }>) {
  for (const change of changes) {
    const baseline = before[change.name];
    if (!baseline) {
      continue;
    }
    if (baseline.missing) {
      await fs.rm(baseline.path, { force: true });
      continue;
    }
    await fs.writeFile(baseline.path, baseline.content, "utf-8");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(cfg, args.agentId);
  await ensureAgentWorkspace({
    dir: workspaceDir,
    ensureBootstrapFiles: true,
    agentId: args.agentId,
  });

  const fileNames = await fileNamesForAgent(args.agentId, workspaceDir);
  const before = await snapshotFiles(workspaceDir, fileNames);

  const runId = crypto.randomUUID();
  const result = await agentCommand({
    agentId: args.agentId,
    sessionKey: args.sessionKey,
    message: args.message,
    deliver: false,
    json: true,
    runId,
  });

  const after = await snapshotFiles(workspaceDir, fileNames);
  const changes = changedFiles(before, after);

  const topLevelText =
    typeof (result as { text?: unknown })?.text === "string"
      ? ((result as { text: string }).text ?? "").trim()
      : "";
  const payloadText = Array.isArray((result as { payloads?: unknown[] })?.payloads)
    ? ((result as { payloads: Array<{ text?: unknown }> }).payloads
        .map((p) => (typeof p?.text === "string" ? p.text.trim() : ""))
        .find(Boolean) ?? "")
    : "";
  const assistantText = topLevelText || payloadText;
  console.log(`assistant: ${assistantText || "<no final text>"}`);
  console.log(`changed files: ${changes.length}`);
  for (const change of changes) {
    console.log(
      `- ${change.name}: ${change.status} (${change.beforeLines} -> ${change.afterLines} lines)`,
    );
  }

  if (args.undo && changes.length > 0) {
    await undoChanges(before, changes);
    console.log("undo: restored baseline files");
  }
}

void main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
