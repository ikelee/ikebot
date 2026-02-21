import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  SessionsUsageEntry,
  SessionsUsageResult,
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
  testSuitesStatus: string | null;
};

const REMOTE_PROVIDER_HINTS = ["openai", "anthropic", "google", "gemini", "xai", "mistral"];
const LOCAL_PROVIDER_HINTS = ["ollama", "llama.cpp", "llamacpp", "lmstudio", "local"];

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
  const nextSuites = state.testSuites.map((suite) => {
    if (suite.id !== run.suiteId) {
      return suite;
    }
    return {
      ...suite,
      previousRun: suite.lastRun,
      lastRun: run,
    };
  });
  state.testSuites = nextSuites;
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

  state.testSuitesBusySuiteId = normalizedSuiteId;
  state.testSuitesError = null;
  state.testSuitesStatus = `Running ${normalizedSuiteId}...`;

  const range = buildRange(14);

  try {
    const usageBeforeRes = await state.client.request("sessions.usage", {
      startDate: range.startDate,
      endDate: range.endDate,
      limit: 1000,
      includeContextWeight: false,
    });
    const usageBefore = usageBeforeRes as SessionsUsageResult;

    const runRes = await state.client.request("tests.run", {
      suiteId: normalizedSuiteId,
      timeoutMs: 45 * 60_000,
    });
    const runIdRaw = (runRes as { runId?: unknown } | null)?.runId;
    const runId = typeof runIdRaw === "string" ? runIdRaw.trim() : "";
    if (!runId) {
      throw new Error("tests.run did not return runId");
    }
    state.testSuitesActiveRunId = runId;

    let snapshot: TestSuiteRunResult | null = null;
    for (;;) {
      const waitRes = await state.client.request("tests.wait", { runId, timeoutMs: 1_500 });
      const run = (waitRes as { run?: TestSuiteRunResult } | null)?.run;
      if (!run) {
        throw new Error(`tests.wait returned no run payload for ${runId}`);
      }
      snapshot = run;
      if (run.status !== "running") {
        break;
      }
    }

    const usageAfterRes = await state.client.request("sessions.usage", {
      startDate: range.startDate,
      endDate: range.endDate,
      limit: 1000,
      includeContextWeight: false,
    });
    const usageAfter = usageAfterRes as SessionsUsageResult;

    const startedAt = snapshot?.startedAt ?? Date.now();
    const endedAt = snapshot?.endedAt ?? Date.now();
    const windowMetrics = summarizeSessionsInWindow(usageAfter.sessions ?? [], startedAt, endedAt);
    const metrics =
      windowMetrics ?? usageDelta(summarizeUsage(usageAfter), summarizeUsage(usageBefore));

    const enriched: TestSuiteRunResult = { ...snapshot, metrics };

    mergeUpdatedRun(state, enriched);

    const suiteName =
      state.testSuites.find((entry) => entry.id === normalizedSuiteId)?.name ?? normalizedSuiteId;
    state.testSuitesStatus = `${suiteName}: ${enriched.status.toUpperCase()} (${Math.round((enriched.durationMs ?? 0) / 1000)}s)`;
  } catch (err) {
    state.testSuitesError = String(err);
    state.testSuitesStatus = null;
  } finally {
    state.testSuitesBusySuiteId = null;
    state.testSuitesActiveRunId = null;
  }
}
