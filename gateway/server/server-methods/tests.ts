import { randomUUID } from "node:crypto";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
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

function tailText(value: string): string {
  if (!value) {
    return "";
  }
  if (value.length <= TEST_RUN_TAIL_CHARS) {
    return value;
  }
  return value.slice(-TEST_RUN_TAIL_CHARS);
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

    const runId = randomUUID();
    const startedAt = Date.now();
    const cwd = await resolveRepoRoot();
    const initial: TestRunSnapshot = {
      runId,
      suiteId: suite.id,
      status: "running",
      startedAt,
      command: suite.command,
      cwd,
      ts: startedAt,
    };
    runById.set(runId, initial);

    void (async () => {
      try {
        const result = await runCommandWithTimeout(suite.command, {
          cwd,
          timeoutMs,
        });
        const endedAt = Date.now();
        const status: TestRunStatus =
          result.killed || result.signal === "SIGKILL"
            ? "timeout"
            : result.code === 0
              ? "ok"
              : "error";

        finalizeRun({
          ...initial,
          status,
          endedAt,
          durationMs: Math.max(0, endedAt - startedAt),
          exitCode: result.code,
          signal: result.signal,
          stdoutTail: tailText(result.stdout),
          stderrTail: tailText(result.stderr),
          ts: endedAt,
        });
      } catch (err) {
        const endedAt = Date.now();
        finalizeRun({
          ...initial,
          status: "error",
          endedAt,
          durationMs: Math.max(0, endedAt - startedAt),
          error: String(err),
          ts: endedAt,
        });
      }
    })();

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
