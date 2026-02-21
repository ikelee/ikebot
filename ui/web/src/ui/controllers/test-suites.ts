import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  SessionsUsageEntry,
  SessionsUsageResult,
  TestSuiteModelCall,
  TestSuiteDiscoverResult,
  TestSuiteEntry,
  TestSuiteRunEvent,
  TestSuiteRunResult,
  TestSuiteUsageMetrics,
  TestSuitesResult,
} from "../types.ts";

type TestSuitesState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  testSuitesLoading: boolean;
  testSuitesError: string | null;
  testSuites: TestSuiteEntry[];
  testSuitesBusySuiteId: string | null;
  testSuitesActiveRunId: string | null;
  testSuitesActiveRun: TestSuiteRunResult | null;
  testSuitesRunHistory: TestSuiteRunResult[];
  testSuitesSelectedRunId: string | null;
  testSuitesRunEvents: TestSuiteRunEvent[];
  testSuitesViewTab: "overview" | "run";
  testSuitesFileQueryBySuite: Record<string, string>;
  testSuitesFilesBySuite: Record<string, string[]>;
  testSuitesFilesLoadingBySuite: Record<string, boolean>;
  testSuitesSelectedFilesBySuite: Record<string, string[]>;
  testSuitesSingleFileBySuite: Record<string, string>;
  testSuitesTestNameBySuite: Record<string, string>;
  testSuitesStatus: string | null;
  testSuitesLocalOnly: boolean;
};

const REMOTE_PROVIDER_HINTS = ["openai", "anthropic", "google", "gemini", "xai", "mistral"];
const LOCAL_PROVIDER_HINTS = ["ollama", "llama.cpp", "llamacpp", "lmstudio", "local"];

function addRunEvent(
  state: TestSuitesState,
  entry: Omit<TestSuiteRunEvent, "ts"> & { ts?: number },
): void {
  const next: TestSuiteRunEvent = {
    ts: entry.ts ?? Date.now(),
    runId: entry.runId,
    level: entry.level,
    message: entry.message,
  };
  state.testSuitesRunEvents = [...state.testSuitesRunEvents, next].slice(-200);
}

function providerKind(provider: string | undefined): "local" | "cloud" | "unknown" {
  if (!provider) {
    return "unknown";
  }
  const normalized = provider.trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  if (LOCAL_PROVIDER_HINTS.some((hint) => normalized.includes(hint))) {
    return "local";
  }
  if (REMOTE_PROVIDER_HINTS.some((hint) => normalized.includes(hint))) {
    return "cloud";
  }
  return "unknown";
}

function yyyyMmDd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function buildRange(days = 7): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end.getTime() - Math.max(1, days - 1) * 24 * 60 * 60_000);
  return { startDate: yyyyMmDd(start), endDate: yyyyMmDd(end) };
}

function summarizeSessionsInWindow(
  sessions: SessionsUsageEntry[],
  startedAt: number,
  endedAt: number,
): TestSuiteUsageMetrics | null {
  const windowStart = startedAt - 5_000;
  const windowEnd = endedAt + 15_000;
  const active = sessions.filter((session) => {
    const usage = session.usage;
    if (!usage) {
      return false;
    }
    const ts = usage.lastActivity ?? usage.firstActivity ?? session.updatedAt ?? 0;
    if (!ts) {
      return false;
    }
    const key = String(session.key ?? "").toLowerCase();
    const likelyTest =
      key.includes(":testing") || key.includes(":test") || session.runKind === "test";
    return likelyTest && ts >= windowStart && ts <= windowEnd;
  });

  if (active.length === 0) {
    return null;
  }

  let userInputs = 0;
  let totalTokens = 0;
  let localTokens = 0;
  let cloudTokens = 0;
  let totalInvocations = 0;
  let localInvocations = 0;
  let cloudInvocations = 0;
  let latencyWeightedMs = 0;
  let latencySamples = 0;

  for (const session of active) {
    const usage = session.usage;
    if (!usage) {
      continue;
    }
    userInputs += usage.messageCounts?.user ?? 0;
    totalTokens += usage.totalTokens ?? 0;

    for (const entry of usage.modelUsage ?? []) {
      const provider = entry.provider ?? undefined;
      const kind = providerKind(provider);
      const count = entry.count ?? 0;
      const tokens = entry.totals?.totalTokens ?? 0;
      totalInvocations += count;
      if (kind === "local") {
        localInvocations += count;
        localTokens += tokens;
      } else if (kind === "cloud") {
        cloudInvocations += count;
        cloudTokens += tokens;
      }
    }

    const latencyCount = usage.latency?.count ?? 0;
    const avgMs = usage.latency?.avgMs ?? 0;
    if (latencyCount > 0) {
      latencyWeightedMs += avgMs * latencyCount;
      latencySamples += latencyCount;
    }
  }

  return {
    userInputs,
    totalInvocations,
    localInvocations,
    cloudInvocations,
    avgLatencyMs: latencySamples > 0 ? latencyWeightedMs / latencySamples : 0,
    totalTokens,
    localTokens,
    cloudTokens,
  };
}

function selectActiveTestSessions(
  sessions: SessionsUsageEntry[],
  startedAt: number,
  endedAt: number,
): SessionsUsageEntry[] {
  const windowStart = startedAt - 5_000;
  const windowEnd = endedAt + 15_000;
  return sessions.filter((session) => {
    const usage = session.usage;
    if (!usage) {
      return false;
    }
    const ts = usage.lastActivity ?? usage.firstActivity ?? session.updatedAt ?? 0;
    if (!ts) {
      return false;
    }
    const key = String(session.key ?? "").toLowerCase();
    const likelyTest =
      key.includes(":testing") || key.includes(":test") || session.runKind === "test";
    return likelyTest && ts >= windowStart && ts <= windowEnd;
  });
}

type SessionUsageLogEntry = {
  timestamp?: number;
  role?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  tokens?: number;
};

async function loadModelCallsForWindow(
  state: TestSuitesState,
  sessions: SessionsUsageEntry[],
  startedAt: number,
  endedAt: number,
): Promise<TestSuiteModelCall[]> {
  if (!state.client) {
    return [];
  }
  const active = selectActiveTestSessions(sessions, startedAt, endedAt);
  if (active.length === 0) {
    return [];
  }
  const all: TestSuiteModelCall[] = [];
  for (const session of active) {
    const key = String(session.key ?? "").trim();
    if (!key) {
      continue;
    }
    try {
      const res = await state.client.request<{ logs?: SessionUsageLogEntry[] }>(
        "sessions.usage.logs",
        {
          key,
          limit: 600,
        },
      );
      const logs = Array.isArray(res?.logs) ? res.logs : [];
      for (const entry of logs) {
        if ((entry.role ?? "") !== "assistant") {
          continue;
        }
        if (!entry.provider && !entry.model) {
          continue;
        }
        const ts =
          typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
            ? entry.timestamp
            : 0;
        if (ts > 0 && (ts < startedAt - 60_000 || ts > endedAt + 60_000)) {
          continue;
        }
        all.push({
          sessionKey: key,
          timestamp: ts,
          provider: typeof entry.provider === "string" ? entry.provider : undefined,
          model: typeof entry.model === "string" ? entry.model : undefined,
          durationMs:
            typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)
              ? entry.durationMs
              : undefined,
          tokens:
            typeof entry.tokens === "number" && Number.isFinite(entry.tokens)
              ? entry.tokens
              : undefined,
        });
      }
    } catch {
      // Best-effort telemetry: keep run UI functional even if logs endpoint fails.
    }
  }
  return all.toSorted((a, b) => {
    const ta = a.timestamp || 0;
    const tb = b.timestamp || 0;
    if (ta !== tb) {
      return ta - tb;
    }
    return a.sessionKey.localeCompare(b.sessionKey);
  });
}

type UsageSummary = {
  userInputs: number;
  totalInvocations: number;
  localInvocations: number;
  cloudInvocations: number;
  avgLatencyMs: number;
  totalTokens: number;
  localTokens: number;
  cloudTokens: number;
};

function summarizeUsage(result: SessionsUsageResult | null | undefined): UsageSummary {
  if (!result) {
    return {
      userInputs: 0,
      totalInvocations: 0,
      localInvocations: 0,
      cloudInvocations: 0,
      avgLatencyMs: 0,
      totalTokens: 0,
      localTokens: 0,
      cloudTokens: 0,
    };
  }

  let totalInvocations = 0;
  let localInvocations = 0;
  let cloudInvocations = 0;
  let localTokens = 0;
  let cloudTokens = 0;

  for (const entry of result.aggregates.byProvider ?? []) {
    const kind = providerKind(entry.provider ?? undefined);
    const count = entry.count ?? 0;
    const tokens = entry.totals?.totalTokens ?? 0;
    totalInvocations += count;
    if (kind === "local") {
      localInvocations += count;
      localTokens += tokens;
    } else if (kind === "cloud") {
      cloudInvocations += count;
      cloudTokens += tokens;
    }
  }

  return {
    userInputs: result.aggregates.messages?.user ?? 0,
    totalInvocations,
    localInvocations,
    cloudInvocations,
    avgLatencyMs: result.aggregates.latency?.avgMs ?? 0,
    totalTokens: result.totals?.totalTokens ?? 0,
    localTokens,
    cloudTokens,
  };
}

function usageDelta(after: UsageSummary, before: UsageSummary): TestSuiteUsageMetrics {
  return {
    userInputs: Math.max(0, after.userInputs - before.userInputs),
    totalInvocations: Math.max(0, after.totalInvocations - before.totalInvocations),
    localInvocations: Math.max(0, after.localInvocations - before.localInvocations),
    cloudInvocations: Math.max(0, after.cloudInvocations - before.cloudInvocations),
    avgLatencyMs: after.avgLatencyMs,
    totalTokens: Math.max(0, after.totalTokens - before.totalTokens),
    localTokens: Math.max(0, after.localTokens - before.localTokens),
    cloudTokens: Math.max(0, after.cloudTokens - before.cloudTokens),
  };
}

function mergeUpdatedRun(state: TestSuitesState, run: TestSuiteRunResult) {
  state.testSuites = state.testSuites.map((suite) => {
    if (suite.id !== run.suiteId) {
      return suite;
    }
    return {
      ...suite,
      previousRun: suite.lastRun,
      lastRun: run,
    };
  });

  const without = state.testSuitesRunHistory.filter((entry) => entry.runId !== run.runId);
  state.testSuitesRunHistory = [run, ...without].slice(0, 40);
}

function levelForSuiteId(state: TestSuitesState, suiteId: string): "unit" | "agent" | "e2e" {
  const suite = state.testSuites.find((entry) => entry.id === suiteId);
  return suite?.level ?? "unit";
}

export async function loadTestSuites(state: TestSuitesState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.testSuitesLoading) {
    return;
  }
  state.testSuitesLoading = true;
  state.testSuitesError = null;
  try {
    const res = await state.client.request("tests.suites", {});
    const suites = (res as TestSuitesResult | null)?.suites ?? [];
    state.testSuites = suites;
  } catch (err) {
    state.testSuitesError = String(err);
  } finally {
    state.testSuitesLoading = false;
  }
}

export async function discoverTestSuiteFiles(state: TestSuitesState, suiteId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const suite = state.testSuites.find((entry) => entry.id === suiteId);
  if (!suite) {
    return;
  }

  state.testSuitesFilesLoadingBySuite = {
    ...state.testSuitesFilesLoadingBySuite,
    [suiteId]: true,
  };

  try {
    const query = state.testSuitesFileQueryBySuite[suiteId]?.trim() ?? "";
    const res = await state.client.request("tests.discover", {
      level: suite.level,
      query: query || undefined,
      limit: 120,
    });
    const files = ((res as TestSuiteDiscoverResult | null)?.files ?? []).filter((entry) =>
      typeof entry === "string" ? entry.trim().length > 0 : false,
    );

    state.testSuitesFilesBySuite = {
      ...state.testSuitesFilesBySuite,
      [suiteId]: files,
    };
  } catch (err) {
    state.testSuitesError = `Failed to discover tests for ${suiteId}: ${String(err)}`;
  } finally {
    state.testSuitesFilesLoadingBySuite = {
      ...state.testSuitesFilesLoadingBySuite,
      [suiteId]: false,
    };
  }
}

export function toggleTestSuiteFileSelection(
  state: TestSuitesState,
  suiteId: string,
  filePath: string,
  enabled: boolean,
) {
  const current = state.testSuitesSelectedFilesBySuite[suiteId] ?? [];
  const next = enabled
    ? [...new Set([...current, filePath])]
    : current.filter((f) => f !== filePath);
  state.testSuitesSelectedFilesBySuite = {
    ...state.testSuitesSelectedFilesBySuite,
    [suiteId]: next,
  };
}

export async function runTestSuite(state: TestSuitesState, suiteId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.testSuitesBusySuiteId) {
    return;
  }

  const normalizedSuiteId = suiteId.trim();
  if (!normalizedSuiteId) {
    return;
  }

  const selectedFiles = state.testSuitesSelectedFilesBySuite[normalizedSuiteId] ?? [];
  const singleFile = (state.testSuitesSingleFileBySuite[normalizedSuiteId] ?? "").trim();
  const testName = (state.testSuitesTestNameBySuite[normalizedSuiteId] ?? "").trim();
  const requestedFiles = singleFile ? [singleFile] : selectedFiles;

  state.testSuitesBusySuiteId = normalizedSuiteId;
  state.testSuitesError = null;
  state.testSuitesStatus = `Preparing ${normalizedSuiteId}...`;
  state.testSuitesViewTab = "run";

  const range = buildRange(14);

  try {
    const usageBeforeRes = await state.client.request("sessions.usage", {
      startDate: range.startDate,
      endDate: range.endDate,
      limit: 1000,
      includeContextWeight: false,
    });
    const usageBefore = usageBeforeRes as SessionsUsageResult;

    state.testSuitesStatus = `Starting run for ${normalizedSuiteId}...`;
    const runRes = await state.client.request("tests.run", {
      suiteId: normalizedSuiteId,
      timeoutMs: 45 * 60_000,
      files: requestedFiles.length > 0 ? requestedFiles : undefined,
      testName: testName || undefined,
      localOnly: state.testSuitesLocalOnly,
    });

    const runIdRaw = (runRes as { runId?: unknown } | null)?.runId;
    const runId = typeof runIdRaw === "string" ? runIdRaw.trim() : "";
    if (!runId) {
      throw new Error("tests.run did not return runId");
    }

    const initialRun = (runRes as { run?: TestSuiteRunResult } | null)?.run ?? null;
    if (initialRun) {
      state.testSuitesActiveRun = initialRun;
      state.testSuitesSelectedRunId = runId;
      mergeUpdatedRun(state, initialRun);
    }

    state.testSuitesActiveRunId = runId;
    state.testSuitesViewTab = "run";

    const level = levelForSuiteId(state, normalizedSuiteId);
    const scopeLabel =
      requestedFiles.length > 0
        ? `${requestedFiles.length} file${requestedFiles.length > 1 ? "s" : ""}`
        : `full ${level} suite`;

    addRunEvent(state, {
      runId,
      level: "info",
      message: `Started ${normalizedSuiteId} (${scopeLabel}${testName ? `, test name filter: ${testName}` : ""}, mode: ${state.testSuitesLocalOnly ? "local-only" : "cloud-integrated"}).`,
    });

    let snapshot: TestSuiteRunResult | null = initialRun;
    for (;;) {
      const waitRes = await state.client.request("tests.wait", { runId, timeoutMs: 1_000 });
      const run = (waitRes as { run?: TestSuiteRunResult } | null)?.run;
      if (!run) {
        throw new Error(`tests.wait returned no run payload for ${runId}`);
      }
      snapshot = run;
      state.testSuitesActiveRun = run;
      state.testSuitesSelectedRunId = runId;
      mergeUpdatedRun(state, run);

      const elapsedMs = Math.max(0, Date.now() - (run.startedAt ?? Date.now()));
      state.testSuitesStatus = `Running ${normalizedSuiteId}... ${Math.round(elapsedMs / 1000)}s elapsed`;

      if (run.status !== "running") {
        break;
      }
    }

    if (!snapshot) {
      throw new Error(`run snapshot missing for ${runId}`);
    }

    state.testSuitesStatus = `Computing usage metrics for ${normalizedSuiteId}...`;

    const usageAfterRes = await state.client.request("sessions.usage", {
      startDate: range.startDate,
      endDate: range.endDate,
      limit: 1000,
      includeContextWeight: false,
    });
    const usageAfter = usageAfterRes as SessionsUsageResult;

    const startedAt = snapshot.startedAt ?? Date.now();
    const endedAt = snapshot.endedAt ?? Date.now();
    const sessions = usageAfter.sessions ?? [];
    const windowMetrics = summarizeSessionsInWindow(sessions, startedAt, endedAt);
    const metrics =
      windowMetrics ?? usageDelta(summarizeUsage(usageAfter), summarizeUsage(usageBefore));
    const modelCalls = await loadModelCallsForWindow(state, sessions, startedAt, endedAt);

    const enriched: TestSuiteRunResult = { ...snapshot, metrics, modelCalls };

    state.testSuitesActiveRun = enriched;
    state.testSuitesSelectedRunId = runId;
    mergeUpdatedRun(state, enriched);

    const suiteName =
      state.testSuites.find((entry) => entry.id === normalizedSuiteId)?.name ?? normalizedSuiteId;

    const status = enriched.status.toUpperCase();
    state.testSuitesStatus = `${suiteName}: ${status} (${Math.round((enriched.durationMs ?? 0) / 1000)}s)`;

    addRunEvent(state, {
      runId,
      level: enriched.status === "ok" ? "ok" : "error",
      message: `${suiteName} finished with ${status}. Duration ${Math.round((enriched.durationMs ?? 0) / 1000)}s.`,
    });
  } catch (err) {
    state.testSuitesError = String(err);
    state.testSuitesStatus = null;
    if (state.testSuitesActiveRunId) {
      addRunEvent(state, {
        runId: state.testSuitesActiveRunId,
        level: "error",
        message: `Run failed: ${String(err)}`,
      });
    }
  } finally {
    state.testSuitesBusySuiteId = null;
    state.testSuitesActiveRunId = null;
  }
}
