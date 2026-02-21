import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTestsDiscoverParams,
  validateTestsRunParams,
  validateTestsSuitesParams,
  validateTestsWaitParams,
} from "../protocol/index.js";

type SuiteLevel = "unit" | "agent" | "e2e";

type TestSuiteDefinition = {
  id: string;
  name: string;
  description: string;
  level: SuiteLevel;
  command: string[];
};

type TestRunStatus = "running" | "ok" | "error" | "timeout";

type TestRunSnapshot = {
  runId: string;
  suiteId: string;
  status: TestRunStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  command: string[];
  cwd: string;
  requestedFiles?: string[];
  testName?: string;
  localOnly?: boolean;
  pid?: number;
  lastOutputAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  stdoutTail?: string;
  stderrTail?: string;
  error?: string;
  ts: number;
};

const TEST_RUN_TTL_MS = 24 * 60 * 60_000;
const TEST_RUN_TAIL_CHARS = 12_000;
const DEFAULT_TEST_TIMEOUT_MS = 30 * 60_000;
const TEST_DISCOVER_DEFAULT_LIMIT = 80;

const TEST_SUITES: readonly TestSuiteDefinition[] = [
  {
    id: "unit-fast",
    name: "Unit (Fast)",
    description: "Strictly unit-focused suite using the fast Vitest config.",
    level: "unit",
    command: ["pnpm", "-s", "test:fast"],
  },
  {
    id: "agent-e2e",
    name: "Agent Level",
    description: "Agent-level E2E (no router full-flow), focused on individual agents.",
    level: "agent",
    command: ["pnpm", "-s", "test:e2e:agent-level"],
  },
  {
    id: "full-e2e",
    name: "Full E2E",
    description: "Full gateway/flow E2E test suite.",
    level: "e2e",
    command: ["pnpm", "-s", "test:e2e:full-flow"],
  },
] as const;

function buildRunCommand(params: {
  suite: TestSuiteDefinition;
  requestedFiles: string[];
  testName?: string;
}): string[] {
  const { suite, requestedFiles, testName } = params;
  const hasSpecificFiles = requestedFiles.length > 0;

  if (!hasSpecificFiles) {
    const command = [...suite.command];
    if (testName) {
      command.push("-t", testName);
    }
    return command;
  }

  const command = ["pnpm", "exec", "vitest", "run"];
  if (suite.level === "unit") {
    command.push("--config", "vitest.unit.config.ts");
  } else {
    command.push("--config", "vitest.e2e.config.ts");
  }
  if (testName) {
    command.push("-t", testName);
  }
  command.push(...requestedFiles);
  return command;
}

const runById = new Map<string, TestRunSnapshot>();
const lastRunBySuite = new Map<string, TestRunSnapshot>();
const waitersByRunId = new Map<string, Array<(entry: TestRunSnapshot) => void>>();

function pruneRuns(now = Date.now()) {
  for (const [runId, entry] of runById) {
    if (entry.status === "running") {
      continue;
    }
    if (now - entry.ts > TEST_RUN_TTL_MS) {
      runById.delete(runId);
    }
  }
}

function appendTail(existing: string | undefined, chunk: string): string {
  const next = (existing ?? "") + chunk;
  if (next.length <= TEST_RUN_TAIL_CHARS) {
    return next;
  }
  return next.slice(-TEST_RUN_TAIL_CHARS);
}

function findSuite(id: string): TestSuiteDefinition | null {
  const normalized = id.trim();
  if (!normalized) {
    return null;
  }
  return TEST_SUITES.find((suite) => suite.id === normalized) ?? null;
}

async function resolveRepoRoot(): Promise<string> {
  return (
    (await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })) ?? process.cwd()
  );
}

function resolveSpawnCommand(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  const basename = path.basename(command).toLowerCase();
  if (path.extname(basename)) {
    return command;
  }
  if (["npm", "pnpm", "yarn", "npx"].includes(basename)) {
    return `${command}.cmd`;
  }
  return command;
}

function updateRun(runId: string, patch: Partial<TestRunSnapshot>) {
  const current = runById.get(runId);
  if (!current) {
    return;
  }
  runById.set(runId, {
    ...current,
    ...patch,
    ts: Date.now(),
  });
}

function finalizeRun(run: TestRunSnapshot) {
  runById.set(run.runId, run);
  lastRunBySuite.set(run.suiteId, run);
  const waiters = waitersByRunId.get(run.runId);
  if (waiters && waiters.length > 0) {
    waitersByRunId.delete(run.runId);
    for (const waiter of waiters) {
      waiter(run);
    }
  }
}

async function waitForRun(runId: string, timeoutMs: number): Promise<TestRunSnapshot | null> {
  pruneRuns();
  const current = runById.get(runId);
  if (!current) {
    return null;
  }
  if (current.status !== "running") {
    return current;
  }
  if (timeoutMs <= 0) {
    return current;
  }

  return await new Promise((resolve) => {
    let settled = false;
    const done = (snapshot: TestRunSnapshot | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const list = waitersByRunId.get(runId) ?? [];
      waitersByRunId.set(
        runId,
        list.filter((entry) => entry !== onDone),
      );
      resolve(snapshot);
    };
    const onDone = (snapshot: TestRunSnapshot) => done(snapshot);
    const list = waitersByRunId.get(runId) ?? [];
    list.push(onDone);
    waitersByRunId.set(runId, list);

    const timer = setTimeout(
      () => {
        const latest = runById.get(runId) ?? null;
        done(latest);
      },
      Math.max(1, Math.min(Math.floor(timeoutMs), 2_147_483_647)),
    );
  });
}

function toSuitePayload(suite: TestSuiteDefinition) {
  return {
    id: suite.id,
    name: suite.name,
    description: suite.description,
    level: suite.level,
    command: suite.command.join(" "),
    lastRun: lastRunBySuite.get(suite.id) ?? null,
  };
}

function shouldIncludeFileByLevel(file: string, level: SuiteLevel): boolean {
  const normalized = file.replace(/\\/g, "/");
  const isE2e = normalized.endsWith(".e2e.test.ts");
  const isTest = normalized.endsWith(".test.ts") || isE2e;
  if (!isTest) {
    return false;
  }
  if (normalized.includes("/node_modules/")) {
    return false;
  }
  if (level === "unit") {
    return !isE2e;
  }
  if (level === "agent") {
    return normalized.startsWith("gateway/agent/agents/") && isE2e;
  }
  return normalized.startsWith("gateway/agent/e2e/") && isE2e;
}

async function collectFilesRecursively(dir: string, out: string[]) {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      await collectFilesRecursively(fullPath, out);
      continue;
    }
    if (entry.isFile()) {
      out.push(fullPath);
    }
  }
}

async function discoverSuiteFiles(params: {
  root: string;
  level: SuiteLevel;
  query?: string;
  limit?: number;
}): Promise<string[]> {
  const filesAbs: string[] = [];
  const { root, level } = params;

  if (level === "unit") {
    await collectFilesRecursively(root, filesAbs);
  } else if (level === "agent") {
    await collectFilesRecursively(path.join(root, "gateway", "agent", "agents"), filesAbs);
  } else {
    await collectFilesRecursively(path.join(root, "gateway", "agent", "e2e"), filesAbs);
  }

  const query = params.query?.trim().toLowerCase() ?? "";
  const limit = Math.max(1, Math.min(params.limit ?? TEST_DISCOVER_DEFAULT_LIMIT, 200));

  const normalized = filesAbs
    .map((fullPath) => path.relative(root, fullPath).replace(/\\/g, "/"))
    .filter((relPath) => shouldIncludeFileByLevel(relPath, level))
    .filter((relPath) => (query ? relPath.toLowerCase().includes(query) : true))
    .toSorted((a, b) => a.localeCompare(b));

  return normalized.slice(0, limit);
}

async function resolveRequestedFiles(params: {
  root: string;
  level: SuiteLevel;
  rawFiles: unknown;
}): Promise<{ files: string[] } | { error: string }> {
  if (!Array.isArray(params.rawFiles) || params.rawFiles.length === 0) {
    return { files: [] };
  }

  const files: string[] = [];
  for (const raw of params.rawFiles) {
    if (typeof raw !== "string") {
      return { error: "files entries must be strings" };
    }
    const trimmed = raw.trim().replace(/\\/g, "/");
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("/") || trimmed.startsWith("../") || trimmed.includes("/../")) {
      return { error: `invalid file path: ${trimmed}` };
    }
    if (!shouldIncludeFileByLevel(trimmed, params.level)) {
      return { error: `file not allowed for suite level ${params.level}: ${trimmed}` };
    }

    const fullPath = path.resolve(params.root, trimmed);
    const relative = path.relative(params.root, fullPath).replace(/\\/g, "/");
    if (relative.startsWith("../") || relative === "..") {
      return { error: `file is outside repo root: ${trimmed}` };
    }

    try {
      await access(fullPath);
    } catch {
      return { error: `file does not exist: ${trimmed}` };
    }

    files.push(relative);
  }

  return { files: Array.from(new Set(files)).slice(0, 50) };
}

async function runCommandStreaming(params: {
  runId: string;
  command: string[];
  cwd: string;
  timeoutMs: number;
  suiteId: string;
  requestedFiles: string[];
  testName?: string;
  localOnly: boolean;
  startedAt: number;
}) {
  const {
    runId,
    command,
    cwd,
    timeoutMs,
    suiteId,
    requestedFiles,
    testName,
    localOnly,
    startedAt,
  } = params;
  const child = spawn(resolveSpawnCommand(command[0]), command.slice(1), {
    cwd,
    env: {
      ...process.env,
      OPENCLAW_TEST_LOCAL_ONLY: localOnly ? "1" : "0",
      OPENCLAW_TEST_MODEL_MODE: localOnly ? "local" : "cloud",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  updateRun(runId, {
    pid: child.pid,
    lastOutputAt: Date.now(),
  });

  let killedByTimeout = false;
  const timeout = setTimeout(
    () => {
      killedByTimeout = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    },
    Math.max(1_000, timeoutMs),
  );

  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    const now = Date.now();
    const current = runById.get(runId);
    if (!current) {
      return;
    }
    updateRun(runId, {
      stdoutTail: appendTail(current.stdoutTail, text),
      lastOutputAt: now,
    });
  });

  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    const now = Date.now();
    const current = runById.get(runId);
    if (!current) {
      return;
    }
    updateRun(runId, {
      stderrTail: appendTail(current.stderrTail, text),
      lastOutputAt: now,
    });
  });

  child.on("error", (err) => {
    clearTimeout(timeout);
    const endedAt = Date.now();
    const current = runById.get(runId);
    finalizeRun({
      runId,
      suiteId,
      status: "error",
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      command,
      cwd,
      requestedFiles,
      testName,
      localOnly,
      pid: current?.pid,
      lastOutputAt: current?.lastOutputAt,
      stdoutTail: current?.stdoutTail,
      stderrTail: current?.stderrTail,
      error: String(err),
      ts: endedAt,
    });
  });

  child.on("close", (code, signal) => {
    clearTimeout(timeout);
    const endedAt = Date.now();
    const current = runById.get(runId);
    const status: TestRunStatus =
      killedByTimeout || signal === "SIGKILL" ? "timeout" : code === 0 ? "ok" : "error";

    finalizeRun({
      runId,
      suiteId,
      status,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      command,
      cwd,
      requestedFiles,
      testName,
      localOnly,
      pid: current?.pid,
      lastOutputAt: current?.lastOutputAt,
      exitCode: code,
      signal,
      stdoutTail: current?.stdoutTail,
      stderrTail: current?.stderrTail,
      ts: endedAt,
    });
  });
}

export const testsHandlers: GatewayRequestHandlers = {
  "tests.suites": async ({ respond, params }) => {
    if (!validateTestsSuitesParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tests.suites params: ${formatValidationErrors(validateTestsSuitesParams.errors)}`,
        ),
      );
      return;
    }

    pruneRuns();
    respond(
      true,
      {
        suites: TEST_SUITES.map((suite) => toSuitePayload(suite)),
      },
      undefined,
    );
  },

  "tests.discover": async ({ respond, params }) => {
    if (!validateTestsDiscoverParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tests.discover params: ${formatValidationErrors(validateTestsDiscoverParams.errors)}`,
        ),
      );
      return;
    }

    const levelRaw = (params as { level?: unknown }).level;
    const level =
      levelRaw === "unit" || levelRaw === "agent" || levelRaw === "e2e"
        ? levelRaw
        : ("unit" as const);
    const queryRaw = (params as { query?: unknown }).query;
    const query = typeof queryRaw === "string" ? queryRaw.trim() : "";
    const limitRaw = (params as { limit?: unknown }).limit;
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(Math.floor(limitRaw), 200))
        : TEST_DISCOVER_DEFAULT_LIMIT;

    const root = await resolveRepoRoot();
    const files = await discoverSuiteFiles({ root, level, query, limit });
    respond(true, { level, files }, undefined);
  },

  "tests.run": async ({ respond, params }) => {
    if (!validateTestsRunParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tests.run params: ${formatValidationErrors(validateTestsRunParams.errors)}`,
        ),
      );
      return;
    }

    const suiteIdRaw = (params as { suiteId?: unknown }).suiteId;
    const suiteId = typeof suiteIdRaw === "string" ? suiteIdRaw.trim() : "";
    const suite = findSuite(suiteId);
    if (!suite) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown suiteId: ${suiteId}`),
      );
      return;
    }

    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw)
        ? Math.max(1_000, Math.floor(timeoutMsRaw))
        : DEFAULT_TEST_TIMEOUT_MS;

    const root = await resolveRepoRoot();
    const filesResolved = await resolveRequestedFiles({
      root,
      level: suite.level,
      rawFiles: (params as { files?: unknown }).files,
    });
    if ("error" in filesResolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, filesResolved.error));
      return;
    }

    const testNameRaw = (params as { testName?: unknown }).testName;
    const testName = typeof testNameRaw === "string" ? testNameRaw.trim() : "";
    const localOnly = (params as { localOnly?: unknown }).localOnly === true;

    const command = buildRunCommand({
      suite,
      requestedFiles: filesResolved.files,
      testName: testName || undefined,
    });

    const runId = randomUUID();
    const startedAt = Date.now();
    const initial: TestRunSnapshot = {
      runId,
      suiteId: suite.id,
      status: "running",
      startedAt,
      command,
      cwd: root,
      requestedFiles: filesResolved.files,
      testName: testName || undefined,
      localOnly,
      ts: startedAt,
    };
    runById.set(runId, initial);

    void runCommandStreaming({
      runId,
      command,
      cwd: root,
      timeoutMs,
      suiteId: suite.id,
      requestedFiles: filesResolved.files,
      testName: testName || undefined,
      localOnly,
      startedAt,
    });

    respond(
      true,
      {
        runId,
        suite: toSuitePayload(suite),
        run: initial,
      },
      undefined,
    );
  },

  "tests.wait": async ({ respond, params }) => {
    if (!validateTestsWaitParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tests.wait params: ${formatValidationErrors(validateTestsWaitParams.errors)}`,
        ),
      );
      return;
    }

    const runIdRaw = (params as { runId?: unknown }).runId;
    const runId = typeof runIdRaw === "string" ? runIdRaw.trim() : "";
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw)
        ? Math.max(0, Math.floor(timeoutMsRaw))
        : 0;

    const snapshot = await waitForRun(runId, timeoutMs);
    if (!snapshot) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unknown runId: ${runId}`));
      return;
    }

    respond(true, { run: snapshot }, undefined);
  },
};
