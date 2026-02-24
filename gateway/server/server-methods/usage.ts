import fs from "node:fs";
import path from "node:path";
import type { SessionEntry, SessionSystemPromptReport } from "../../infra/config/sessions/types.js";
import type {
  CostUsageSummary,
  SessionCostSummary,
  SessionDailyLatency,
  SessionDailyMessageCounts,
  SessionDailyModelUsage,
  SessionMessageCounts,
  SessionLatencyStats,
  SessionModelUsage,
  SessionToolUsage,
} from "../../infra/session-cost-usage.js";
import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../infra/config/config.js";
import { resolveStateDir } from "../../infra/config/paths.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../infra/config/sessions/paths.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.js";
import { parseAgentSessionKey } from "../../infra/routing/session-key.js";
import {
  loadCostUsageSummary,
  loadSessionCostSummary,
  loadSessionUsageTimeSeries,
  discoverAllSessions,
  type DiscoveredSession,
} from "../../infra/session-cost-usage.js";
import {
  estimateUsageCost,
  resolveModelCostConfig,
  type ModelCostConfig,
} from "../../utils/usage-format.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionsUsageParams,
} from "../protocol/index.js";
import {
  listAgentsForGateway,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
} from "../session-utils.js";

const COST_USAGE_CACHE_TTL_MS = 30_000;

type DateRange = { startMs: number; endMs: number };

type CostUsageCacheEntry = {
  summary?: CostUsageSummary;
  updatedAt?: number;
  inFlight?: Promise<CostUsageSummary>;
};

const costUsageCache = new Map<string, CostUsageCacheEntry>();

/**
 * Parse a date string (YYYY-MM-DD) to start of day timestamp in UTC.
 * Returns undefined if invalid.
 */
const parseDateToMs = (raw: unknown): number | undefined => {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  // Use UTC to ensure consistent behavior across timezones
  const ms = Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day));
  if (Number.isNaN(ms)) {
    return undefined;
  }
  return ms;
};

const parseDays = (raw: unknown): number | undefined => {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
};

/**
 * Get date range from params (startDate/endDate or days).
 * Falls back to last 30 days if not provided.
 */
const parseDateRange = (params: {
  startDate?: unknown;
  endDate?: unknown;
  days?: unknown;
}): DateRange => {
  const now = new Date();
  // Use UTC for consistent date handling
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayEndMs = todayStartMs + 24 * 60 * 60 * 1000 - 1;

  const startMs = parseDateToMs(params.startDate);
  const endMs = parseDateToMs(params.endDate);

  if (startMs !== undefined && endMs !== undefined) {
    // endMs should be end of day
    return { startMs, endMs: endMs + 24 * 60 * 60 * 1000 - 1 };
  }

  const days = parseDays(params.days);
  if (days !== undefined) {
    const clampedDays = Math.max(1, days);
    const start = todayStartMs - (clampedDays - 1) * 24 * 60 * 60 * 1000;
    return { startMs: start, endMs: todayEndMs };
  }

  // Default to last 30 days
  const defaultStartMs = todayStartMs - 29 * 24 * 60 * 60 * 1000;
  return { startMs: defaultStartMs, endMs: todayEndMs };
};

type DiscoveredSessionWithAgent = DiscoveredSession & { agentId: string };

async function discoverAllSessionsForUsage(params: {
  config: ReturnType<typeof loadConfig>;
  startMs: number;
  endMs: number;
}): Promise<DiscoveredSessionWithAgent[]> {
  const agents = listAgentsForGateway(params.config).agents;
  const results = await Promise.all(
    agents.map(async (agent) => {
      const sessions = await discoverAllSessions({
        agentId: agent.id,
        startMs: params.startMs,
        endMs: params.endMs,
      });
      return sessions.map((session) => ({ ...session, agentId: agent.id }));
    }),
  );
  return results.flat().toSorted((a, b) => b.mtime - a.mtime);
}

async function loadCostUsageSummaryCached(params: {
  startMs: number;
  endMs: number;
  config: ReturnType<typeof loadConfig>;
}): Promise<CostUsageSummary> {
  const cacheKey = `${params.startMs}-${params.endMs}`;
  const now = Date.now();
  const cached = costUsageCache.get(cacheKey);
  if (cached?.summary && cached.updatedAt && now - cached.updatedAt < COST_USAGE_CACHE_TTL_MS) {
    return cached.summary;
  }

  if (cached?.inFlight) {
    if (cached.summary) {
      return cached.summary;
    }
    return await cached.inFlight;
  }

  const entry: CostUsageCacheEntry = cached ?? {};
  const inFlight = loadCostUsageSummary({
    startMs: params.startMs,
    endMs: params.endMs,
    config: params.config,
  })
    .then((summary) => {
      costUsageCache.set(cacheKey, { summary, updatedAt: Date.now() });
      return summary;
    })
    .catch((err) => {
      if (entry.summary) {
        return entry.summary;
      }
      throw err;
    })
    .finally(() => {
      const current = costUsageCache.get(cacheKey);
      if (current?.inFlight === inFlight) {
        current.inFlight = undefined;
        costUsageCache.set(cacheKey, current);
      }
    });

  entry.inFlight = inFlight;
  costUsageCache.set(cacheKey, entry);

  if (entry.summary) {
    return entry.summary;
  }
  return await inFlight;
}

// Exposed for unit tests (kept as a single export to avoid widening the public API surface).
export const __test = {
  parseDateToMs,
  parseDays,
  parseDateRange,
  discoverAllSessionsForUsage,
  loadCostUsageSummaryCached,
  costUsageCache,
};

export type SessionUsageEntry = {
  key: string;
  label?: string;
  sessionSource?: "test" | "live";
  sessionId?: string;
  updatedAt?: number;
  agentId?: string;
  channel?: string;
  chatType?: string;
  origin?: {
    label?: string;
    provider?: string;
    surface?: string;
    chatType?: string;
    from?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  modelOverride?: string;
  providerOverride?: string;
  modelProvider?: string;
  model?: string;
  usage: SessionCostSummary | null;
  contextWeight?: SessionSystemPromptReport | null;
};

export type SessionsUsageAggregates = {
  messages: SessionMessageCounts;
  tools: SessionToolUsage;
  byModel: SessionModelUsage[];
  byProvider: SessionModelUsage[];
  byAgent: Array<{ agentId: string; totals: CostUsageSummary["totals"] }>;
  byChannel: Array<{ channel: string; totals: CostUsageSummary["totals"] }>;
  latency?: SessionLatencyStats;
  dailyLatency?: SessionDailyLatency[];
  modelDaily?: SessionDailyModelUsage[];
  daily: Array<{
    date: string;
    tokens: number;
    cost: number;
    messages: number;
    toolCalls: number;
    errors: number;
  }>;
};

export type SessionsUsageResult = {
  updatedAt: number;
  startDate: string;
  endDate: string;
  sessions: SessionUsageEntry[];
  totals: CostUsageSummary["totals"];
  aggregates: SessionsUsageAggregates;
};

const formatDayKeyUtc = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

const TELEMETRY_FALLBACK_MODEL_COSTS: Record<string, ModelCostConfig> = {
  "gpt-5.2-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.1-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5.1-codex-max": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
};

const resolveTelemetryModelCost = (params: {
  provider?: string;
  model?: string;
  config: ReturnType<typeof loadConfig>;
}): ModelCostConfig | undefined => {
  const configured = resolveModelCostConfig(params);
  if (configured) {
    return configured;
  }
  const model = params.model?.trim();
  if (!model) {
    return undefined;
  }
  return TELEMETRY_FALLBACK_MODEL_COSTS[model];
};

const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
};

const normalizeTelemetrySource = (value: unknown): "live" | "test" => {
  if (value === "test") {
    return "test";
  }
  return "live";
};

const parseTelemetryUsage = (
  raw: unknown,
): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  hasCost: boolean;
} | null => {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const input = toFiniteNumber(record.input) ?? 0;
  const output = toFiniteNumber(record.output) ?? 0;
  const cacheRead = toFiniteNumber(record.cacheRead) ?? 0;
  const cacheWrite = toFiniteNumber(record.cacheWrite) ?? 0;
  const totalTokens =
    toFiniteNumber(record.total) ??
    toFiniteNumber(record.totalTokens) ??
    input + output + cacheRead + cacheWrite;
  const costRaw =
    record.cost && typeof record.cost === "object"
      ? (record.cost as Record<string, unknown>)
      : null;
  const totalCost = toFiniteNumber(costRaw?.total) ?? 0;
  const inputCost = toFiniteNumber(costRaw?.input) ?? 0;
  const outputCost = toFiniteNumber(costRaw?.output) ?? 0;
  const cacheReadCost = toFiniteNumber(costRaw?.cacheRead) ?? 0;
  const cacheWriteCost = toFiniteNumber(costRaw?.cacheWrite) ?? 0;
  const hasCost =
    typeof costRaw?.total === "number" ||
    typeof costRaw?.input === "number" ||
    typeof costRaw?.output === "number" ||
    typeof costRaw?.cacheRead === "number" ||
    typeof costRaw?.cacheWrite === "number";
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    totalCost,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    hasCost,
  };
};

const computeLatencyStatsFromValues = (values: number[]): SessionLatencyStats | undefined => {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const p95Index = Math.max(0, Math.ceil(count * 0.95) - 1);
  return {
    count,
    avgMs: sum / count,
    p95Ms: sorted[p95Index] ?? sorted[count - 1],
    minMs: sorted[0] ?? 0,
    maxMs: sorted[count - 1] ?? 0,
  };
};

type TelemetrySessionAccumulator = {
  key: string;
  label?: string;
  sessionSource: "test" | "live";
  sessionId?: string;
  updatedAt: number;
  agentId?: string;
  channel?: string;
  chatType?: string;
  origin?: SessionUsageEntry["origin"];
  modelProvider?: string;
  model?: string;
  usage: SessionCostSummary;
  toolUsageMap: Map<string, number>;
  modelUsageMap: Map<string, SessionModelUsage>;
  dailyMap: Map<string, { tokens: number; cost: number }>;
  dailyMessageMap: Map<string, SessionDailyMessageCounts>;
  dailyLatencyMap: Map<string, number[]>;
  dailyModelUsageMap: Map<string, SessionDailyModelUsage>;
  latencyValues: number[];
  modelToolCallsByLoop: Set<string>;
};

const emptyTotals = (): CostUsageSummary["totals"] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  totalCost: 0,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
});

async function loadTelemetryUsageSummary(params: {
  startMs: number;
  endMs: number;
  limit: number;
}): Promise<SessionsUsageResult> {
  const config = loadConfig();
  const { store } = loadCombinedSessionStoreForGateway(config);
  const telemetryPath = path.join(resolveStateDir(process.env), "logs", "telemetry.jsonl");
  const content = await fs.promises.readFile(telemetryPath, "utf8").catch(() => "");
  const sessionsMap = new Map<string, TelemetrySessionAccumulator>();

  const getSessionAccumulator = (
    sessionKeyRaw: string,
    sourceRaw: unknown,
  ): TelemetrySessionAccumulator => {
    const sessionKey = sessionKeyRaw.trim() || "unknown";
    const existing = sessionsMap.get(sessionKey);
    if (existing) {
      if (normalizeTelemetrySource(sourceRaw) === "test") {
        existing.sessionSource = "test";
      }
      return existing;
    }

    const parsed = parseAgentSessionKey(sessionKey);
    const rest = parsed?.rest ?? sessionKey;
    const channel = rest.split(":").filter(Boolean)[0];
    const storeEntry = store[sessionKey];
    const sessionId = storeEntry?.sessionId;

    const usage: SessionCostSummary = {
      sessionId,
      firstActivity: undefined,
      lastActivity: undefined,
      durationMs: undefined,
      activityDates: [],
      dailyBreakdown: [],
      dailyMessageCounts: [],
      dailyLatency: undefined,
      dailyModelUsage: undefined,
      messageCounts: {
        total: 0,
        user: 0,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
      },
      toolUsage: undefined,
      modelUsage: undefined,
      latency: undefined,
      ...emptyTotals(),
    };

    const created: TelemetrySessionAccumulator = {
      key: sessionKey,
      label: storeEntry?.label,
      sessionSource: normalizeTelemetrySource(sourceRaw),
      sessionId,
      updatedAt: storeEntry?.updatedAt ?? 0,
      agentId: parsed?.agentId,
      channel: storeEntry?.channel ?? storeEntry?.origin?.provider ?? channel,
      chatType: storeEntry?.chatType ?? storeEntry?.origin?.chatType,
      origin: storeEntry?.origin,
      modelProvider: undefined,
      model: undefined,
      usage,
      toolUsageMap: new Map<string, number>(),
      modelUsageMap: new Map<string, SessionModelUsage>(),
      dailyMap: new Map<string, { tokens: number; cost: number }>(),
      dailyMessageMap: new Map<string, SessionDailyMessageCounts>(),
      dailyLatencyMap: new Map<string, number[]>(),
      dailyModelUsageMap: new Map<string, SessionDailyModelUsage>(),
      latencyValues: [],
      modelToolCallsByLoop: new Set<string>(),
    };
    sessionsMap.set(sessionKey, created);
    return created;
  };

  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let parsedLine: Record<string, unknown>;
    try {
      parsedLine = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsedLine.stream !== "telemetry") {
      continue;
    }
    const ts = toFiniteNumber(parsedLine.ts);
    if (ts === undefined || ts < params.startMs || ts > params.endMs) {
      continue;
    }
    const data =
      parsedLine.data && typeof parsedLine.data === "object" && !Array.isArray(parsedLine.data)
        ? (parsedLine.data as Record<string, unknown>)
        : null;
    const kind = typeof data?.kind === "string" ? data.kind : null;
    if (!kind) {
      continue;
    }
    const dataRecord = data as Record<string, unknown>;
    const sessionKey =
      (typeof parsedLine.sessionKey === "string" ? parsedLine.sessionKey : undefined) ??
      (typeof dataRecord.sessionKey === "string" ? dataRecord.sessionKey : undefined) ??
      (typeof parsedLine.runId === "string" ? `run:${parsedLine.runId}` : undefined);
    if (!sessionKey) {
      continue;
    }

    const acc = getSessionAccumulator(sessionKey, parsedLine.source);
    acc.updatedAt = Math.max(acc.updatedAt, ts);
    acc.usage.firstActivity =
      acc.usage.firstActivity === undefined ? ts : Math.min(acc.usage.firstActivity, ts);
    acc.usage.lastActivity =
      acc.usage.lastActivity === undefined ? ts : Math.max(acc.usage.lastActivity, ts);
    const dayKey = formatDayKeyUtc(ts);
    const activityDates = new Set(acc.usage.activityDates ?? []);
    activityDates.add(dayKey);
    acc.usage.activityDates = Array.from(activityDates).toSorted();

    const dailyMessages = acc.dailyMessageMap.get(dayKey) ?? {
      date: dayKey,
      total: 0,
      user: 0,
      assistant: 0,
      toolCalls: 0,
      toolResults: 0,
      errors: 0,
    };

    if (kind === "user_input.start") {
      acc.usage.messageCounts!.user += 1;
      acc.usage.messageCounts!.total += 1;
      dailyMessages.user += 1;
      dailyMessages.total += 1;
    }

    if (kind === "user_input.end") {
      const durationMs = toFiniteNumber(dataRecord.durationMs);
      if (durationMs !== undefined && durationMs >= 0) {
        acc.latencyValues.push(durationMs);
        const dayLatencies = acc.dailyLatencyMap.get(dayKey) ?? [];
        dayLatencies.push(durationMs);
        acc.dailyLatencyMap.set(dayKey, dayLatencies);
      }
      if (dataRecord.status === "error") {
        acc.usage.messageCounts!.errors += 1;
        dailyMessages.errors += 1;
      }
    }

    if (kind === "tool_loop.end") {
      const toolCallCount = Math.max(0, Math.floor(toFiniteNumber(dataRecord.toolCallCount) ?? 0));
      const toolNames = Array.isArray(dataRecord.toolNames)
        ? dataRecord.toolNames
            .map((name) => (typeof name === "string" ? name.trim() : ""))
            .filter((name) => name.length > 0)
        : [];
      for (const toolName of toolNames) {
        acc.toolUsageMap.set(toolName, (acc.toolUsageMap.get(toolName) ?? 0) + 1);
      }
      const toolLoopId =
        typeof dataRecord.toolLoopId === "string" ? dataRecord.toolLoopId : undefined;
      // Prefer model_call.end.toolCallsRequested (requested tool calls, matches transcript tool_use).
      // Fallback to tool_loop.end.toolCallCount only when no per-model counts were observed.
      if (!toolLoopId || !acc.modelToolCallsByLoop.has(toolLoopId)) {
        acc.usage.messageCounts!.toolCalls += toolCallCount;
        dailyMessages.toolCalls += toolCallCount;
      }
      const status = typeof dataRecord.status === "string" ? dataRecord.status : "ok";
      if (status !== "ok" && status !== "retry") {
        acc.usage.messageCounts!.errors += 1;
        dailyMessages.errors += 1;
      }
    }

    if (kind === "model_call.end") {
      acc.usage.messageCounts!.assistant += 1;
      acc.usage.messageCounts!.total += 1;
      dailyMessages.assistant += 1;
      dailyMessages.total += 1;

      const toolCallsRequested = Math.max(
        0,
        Math.floor(toFiniteNumber(dataRecord.toolCallsRequested) ?? 0),
      );
      if (toolCallsRequested > 0) {
        acc.usage.messageCounts!.toolCalls += toolCallsRequested;
        dailyMessages.toolCalls += toolCallsRequested;
        const toolLoopId =
          typeof dataRecord.toolLoopId === "string" ? dataRecord.toolLoopId : undefined;
        if (toolLoopId) {
          acc.modelToolCallsByLoop.add(toolLoopId);
        }
      }

      const usage = parseTelemetryUsage(dataRecord.usage);
      const provider = typeof dataRecord.provider === "string" ? dataRecord.provider : undefined;
      const model = typeof dataRecord.model === "string" ? dataRecord.model : undefined;
      if (usage && !usage.hasCost) {
        const costCfg = resolveTelemetryModelCost({ provider, model, config });
        const estimatedTotal = estimateUsageCost({
          usage: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          },
          cost: costCfg,
        });
        if (estimatedTotal !== undefined) {
          usage.totalCost = estimatedTotal;
          usage.inputCost = (usage.input * (costCfg?.input ?? 0)) / 1_000_000 || 0;
          usage.outputCost = (usage.output * (costCfg?.output ?? 0)) / 1_000_000 || 0;
          usage.cacheReadCost = (usage.cacheRead * (costCfg?.cacheRead ?? 0)) / 1_000_000 || 0;
          usage.cacheWriteCost = (usage.cacheWrite * (costCfg?.cacheWrite ?? 0)) / 1_000_000 || 0;
          usage.hasCost = true;
        }
      }
      if (provider && !acc.modelProvider) {
        acc.modelProvider = provider;
      }
      if (model && !acc.model) {
        acc.model = model;
      }
      const modelKey = `${provider ?? "unknown"}::${model ?? "unknown"}`;
      const modelUsage =
        acc.modelUsageMap.get(modelKey) ??
        ({
          provider,
          model,
          count: 0,
          totals: emptyTotals(),
        } as SessionModelUsage);
      modelUsage.count += 1;

      if (usage) {
        acc.usage.input += usage.input;
        acc.usage.output += usage.output;
        acc.usage.cacheRead += usage.cacheRead;
        acc.usage.cacheWrite += usage.cacheWrite;
        acc.usage.totalTokens += usage.totalTokens;
        acc.usage.totalCost += usage.totalCost;
        acc.usage.inputCost += usage.inputCost;
        acc.usage.outputCost += usage.outputCost;
        acc.usage.cacheReadCost += usage.cacheReadCost;
        acc.usage.cacheWriteCost += usage.cacheWriteCost;
        if (!usage.hasCost) {
          acc.usage.missingCostEntries += 1;
        }

        modelUsage.totals.input += usage.input;
        modelUsage.totals.output += usage.output;
        modelUsage.totals.cacheRead += usage.cacheRead;
        modelUsage.totals.cacheWrite += usage.cacheWrite;
        modelUsage.totals.totalTokens += usage.totalTokens;
        modelUsage.totals.totalCost += usage.totalCost;
        modelUsage.totals.inputCost += usage.inputCost;
        modelUsage.totals.outputCost += usage.outputCost;
        modelUsage.totals.cacheReadCost += usage.cacheReadCost;
        modelUsage.totals.cacheWriteCost += usage.cacheWriteCost;
        if (!usage.hasCost) {
          modelUsage.totals.missingCostEntries += 1;
        }

        const dailyUsage = acc.dailyMap.get(dayKey) ?? { tokens: 0, cost: 0 };
        dailyUsage.tokens += usage.totalTokens;
        dailyUsage.cost += usage.totalCost;
        acc.dailyMap.set(dayKey, dailyUsage);

        const modelDailyKey = `${dayKey}::${provider ?? "unknown"}::${model ?? "unknown"}`;
        const modelDaily =
          acc.dailyModelUsageMap.get(modelDailyKey) ??
          ({
            date: dayKey,
            provider,
            model,
            tokens: 0,
            cost: 0,
            count: 0,
          } as SessionDailyModelUsage);
        modelDaily.tokens += usage.totalTokens;
        modelDaily.cost += usage.totalCost;
        modelDaily.count += 1;
        acc.dailyModelUsageMap.set(modelDailyKey, modelDaily);
      } else {
        acc.usage.missingCostEntries += 1;
        modelUsage.totals.missingCostEntries += 1;
      }

      if (dataRecord.status === "error") {
        acc.usage.messageCounts!.errors += 1;
        dailyMessages.errors += 1;
      }
      acc.modelUsageMap.set(modelKey, modelUsage);
    }

    acc.dailyMessageMap.set(dayKey, dailyMessages);
  }

  const sessions = Array.from(sessionsMap.values())
    .map((acc) => {
      acc.usage.durationMs =
        acc.usage.firstActivity !== undefined && acc.usage.lastActivity !== undefined
          ? Math.max(0, acc.usage.lastActivity - acc.usage.firstActivity)
          : undefined;
      acc.usage.dailyBreakdown = Array.from(acc.dailyMap.entries())
        .map(([date, data]) => ({ date, tokens: data.tokens, cost: data.cost }))
        .toSorted((a, b) => a.date.localeCompare(b.date));
      acc.usage.dailyMessageCounts = Array.from(acc.dailyMessageMap.values()).toSorted((a, b) =>
        a.date.localeCompare(b.date),
      );
      acc.usage.dailyModelUsage = Array.from(acc.dailyModelUsageMap.values()).toSorted((a, b) =>
        a.date.localeCompare(b.date),
      );
      acc.usage.modelUsage = Array.from(acc.modelUsageMap.values()).toSorted((a, b) => {
        const costDiff = b.totals.totalCost - a.totals.totalCost;
        if (costDiff !== 0) {
          return costDiff;
        }
        return b.totals.totalTokens - a.totals.totalTokens;
      });
      const latency = computeLatencyStatsFromValues(acc.latencyValues);
      acc.usage.latency = latency;
      acc.usage.dailyLatency = Array.from(acc.dailyLatencyMap.entries())
        .map(([date, values]) => {
          const stats = computeLatencyStatsFromValues(values);
          if (!stats) {
            return null;
          }
          return { date, ...stats };
        })
        .filter((entry): entry is SessionDailyLatency => Boolean(entry))
        .toSorted((a, b) => a.date.localeCompare(b.date));
      const namedTools = Array.from(acc.toolUsageMap.entries())
        .map(([name, count]) => ({ name, count }))
        .toSorted((a, b) => b.count - a.count);
      const namedToolCalls = namedTools.reduce((sum, entry) => sum + entry.count, 0);
      const observedToolCalls = acc.usage.messageCounts?.toolCalls ?? 0;
      const unnamedToolCalls = Math.max(0, observedToolCalls - namedToolCalls);
      const allTools =
        unnamedToolCalls > 0
          ? [...namedTools, { name: "(unnamed)", count: unnamedToolCalls }]
          : namedTools;
      acc.usage.toolUsage = {
        totalCalls: observedToolCalls,
        uniqueTools: allTools.length,
        tools: allTools,
      };

      return {
        key: acc.key,
        label: acc.label,
        sessionSource: acc.sessionSource,
        sessionId: acc.sessionId,
        updatedAt: acc.updatedAt,
        agentId: acc.agentId,
        channel: acc.channel,
        chatType: acc.chatType,
        origin: acc.origin,
        modelProvider: acc.modelProvider,
        model: acc.model,
        usage: acc.usage,
      } as SessionUsageEntry;
    })
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, Math.max(1, params.limit));

  const totals = emptyTotals();
  const aggregatesMessages: SessionMessageCounts = {
    total: 0,
    user: 0,
    assistant: 0,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  };
  const toolMap = new Map<string, number>();
  const byModelMap = new Map<string, SessionModelUsage>();
  const byProviderMap = new Map<string, SessionModelUsage>();
  const byAgentMap = new Map<string, CostUsageSummary["totals"]>();
  const byChannelMap = new Map<string, CostUsageSummary["totals"]>();
  const dailyMap = new Map<
    string,
    {
      date: string;
      tokens: number;
      cost: number;
      messages: number;
      toolCalls: number;
      errors: number;
    }
  >();
  const latencyValues: number[] = [];
  const dailyLatencyMap = new Map<string, number[]>();
  const modelDailyMap = new Map<string, SessionDailyModelUsage>();

  for (const session of sessions) {
    const usage = session.usage;
    if (!usage) {
      continue;
    }
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.totalTokens += usage.totalTokens;
    totals.totalCost += usage.totalCost;
    totals.inputCost += usage.inputCost;
    totals.outputCost += usage.outputCost;
    totals.cacheReadCost += usage.cacheReadCost;
    totals.cacheWriteCost += usage.cacheWriteCost;
    totals.missingCostEntries += usage.missingCostEntries;

    if (usage.messageCounts) {
      aggregatesMessages.total += usage.messageCounts.total;
      aggregatesMessages.user += usage.messageCounts.user;
      aggregatesMessages.assistant += usage.messageCounts.assistant;
      aggregatesMessages.toolCalls += usage.messageCounts.toolCalls;
      aggregatesMessages.toolResults += usage.messageCounts.toolResults;
      aggregatesMessages.errors += usage.messageCounts.errors;
    }
    if (usage.latency?.count) {
      latencyValues.push(...new Array(usage.latency.count).fill(usage.latency.avgMs));
    }
    for (const daily of usage.dailyLatency ?? []) {
      const values = dailyLatencyMap.get(daily.date) ?? [];
      values.push(...new Array(daily.count).fill(daily.avgMs));
      dailyLatencyMap.set(daily.date, values);
    }
    for (const daily of usage.dailyBreakdown ?? []) {
      const item = dailyMap.get(daily.date) ?? {
        date: daily.date,
        tokens: 0,
        cost: 0,
        messages: 0,
        toolCalls: 0,
        errors: 0,
      };
      item.tokens += daily.tokens;
      item.cost += daily.cost;
      dailyMap.set(daily.date, item);
    }
    for (const daily of usage.dailyMessageCounts ?? []) {
      const item = dailyMap.get(daily.date) ?? {
        date: daily.date,
        tokens: 0,
        cost: 0,
        messages: 0,
        toolCalls: 0,
        errors: 0,
      };
      item.messages += daily.total;
      item.toolCalls += daily.toolCalls;
      item.errors += daily.errors;
      dailyMap.set(daily.date, item);
    }
    for (const daily of usage.dailyModelUsage ?? []) {
      const key = `${daily.date}::${daily.provider ?? "unknown"}::${daily.model ?? "unknown"}`;
      const existing =
        modelDailyMap.get(key) ??
        ({
          date: daily.date,
          provider: daily.provider,
          model: daily.model,
          tokens: 0,
          cost: 0,
          count: 0,
        } as SessionDailyModelUsage);
      existing.tokens += daily.tokens;
      existing.cost += daily.cost;
      existing.count += daily.count;
      modelDailyMap.set(key, existing);
    }

    if (usage.toolUsage) {
      for (const tool of usage.toolUsage.tools) {
        toolMap.set(tool.name, (toolMap.get(tool.name) ?? 0) + tool.count);
      }
    }

    for (const modelUsage of usage.modelUsage ?? []) {
      const modelKey = `${modelUsage.provider ?? "unknown"}::${modelUsage.model ?? "unknown"}`;
      const modelExisting =
        byModelMap.get(modelKey) ??
        ({
          provider: modelUsage.provider,
          model: modelUsage.model,
          count: 0,
          totals: emptyTotals(),
        } as SessionModelUsage);
      modelExisting.count += modelUsage.count;
      modelExisting.totals.input += modelUsage.totals.input;
      modelExisting.totals.output += modelUsage.totals.output;
      modelExisting.totals.cacheRead += modelUsage.totals.cacheRead;
      modelExisting.totals.cacheWrite += modelUsage.totals.cacheWrite;
      modelExisting.totals.totalTokens += modelUsage.totals.totalTokens;
      modelExisting.totals.totalCost += modelUsage.totals.totalCost;
      modelExisting.totals.inputCost += modelUsage.totals.inputCost;
      modelExisting.totals.outputCost += modelUsage.totals.outputCost;
      modelExisting.totals.cacheReadCost += modelUsage.totals.cacheReadCost;
      modelExisting.totals.cacheWriteCost += modelUsage.totals.cacheWriteCost;
      modelExisting.totals.missingCostEntries += modelUsage.totals.missingCostEntries;
      byModelMap.set(modelKey, modelExisting);

      const providerKey = modelUsage.provider ?? "unknown";
      const providerExisting =
        byProviderMap.get(providerKey) ??
        ({
          provider: modelUsage.provider,
          model: undefined,
          count: 0,
          totals: emptyTotals(),
        } as SessionModelUsage);
      providerExisting.count += modelUsage.count;
      providerExisting.totals.input += modelUsage.totals.input;
      providerExisting.totals.output += modelUsage.totals.output;
      providerExisting.totals.cacheRead += modelUsage.totals.cacheRead;
      providerExisting.totals.cacheWrite += modelUsage.totals.cacheWrite;
      providerExisting.totals.totalTokens += modelUsage.totals.totalTokens;
      providerExisting.totals.totalCost += modelUsage.totals.totalCost;
      providerExisting.totals.inputCost += modelUsage.totals.inputCost;
      providerExisting.totals.outputCost += modelUsage.totals.outputCost;
      providerExisting.totals.cacheReadCost += modelUsage.totals.cacheReadCost;
      providerExisting.totals.cacheWriteCost += modelUsage.totals.cacheWriteCost;
      providerExisting.totals.missingCostEntries += modelUsage.totals.missingCostEntries;
      byProviderMap.set(providerKey, providerExisting);
    }

    if (session.agentId) {
      const entry = byAgentMap.get(session.agentId) ?? emptyTotals();
      entry.input += usage.input;
      entry.output += usage.output;
      entry.cacheRead += usage.cacheRead;
      entry.cacheWrite += usage.cacheWrite;
      entry.totalTokens += usage.totalTokens;
      entry.totalCost += usage.totalCost;
      entry.inputCost += usage.inputCost;
      entry.outputCost += usage.outputCost;
      entry.cacheReadCost += usage.cacheReadCost;
      entry.cacheWriteCost += usage.cacheWriteCost;
      entry.missingCostEntries += usage.missingCostEntries;
      byAgentMap.set(session.agentId, entry);
    }
    if (session.channel) {
      const entry = byChannelMap.get(session.channel) ?? emptyTotals();
      entry.input += usage.input;
      entry.output += usage.output;
      entry.cacheRead += usage.cacheRead;
      entry.cacheWrite += usage.cacheWrite;
      entry.totalTokens += usage.totalTokens;
      entry.totalCost += usage.totalCost;
      entry.inputCost += usage.inputCost;
      entry.outputCost += usage.outputCost;
      entry.cacheReadCost += usage.cacheReadCost;
      entry.cacheWriteCost += usage.cacheWriteCost;
      entry.missingCostEntries += usage.missingCostEntries;
      byChannelMap.set(session.channel, entry);
    }
  }

  const startDate = new Date(params.startMs).toISOString().slice(0, 10);
  const endDate = new Date(params.endMs).toISOString().slice(0, 10);

  return {
    updatedAt: Date.now(),
    startDate,
    endDate,
    sessions,
    totals,
    aggregates: {
      messages: aggregatesMessages,
      tools: {
        totalCalls: Array.from(toolMap.values()).reduce((sum, count) => sum + count, 0),
        uniqueTools: toolMap.size,
        tools: Array.from(toolMap.entries())
          .map(([name, count]) => ({ name, count }))
          .toSorted((a, b) => b.count - a.count),
      },
      byModel: Array.from(byModelMap.values()).toSorted(
        (a, b) => b.totals.totalCost - a.totals.totalCost,
      ),
      byProvider: Array.from(byProviderMap.values()).toSorted(
        (a, b) => b.totals.totalCost - a.totals.totalCost,
      ),
      byAgent: Array.from(byAgentMap.entries())
        .map(([agentId, usageTotals]) => ({ agentId, totals: usageTotals }))
        .toSorted((a, b) => b.totals.totalCost - a.totals.totalCost),
      byChannel: Array.from(byChannelMap.entries())
        .map(([channel, usageTotals]) => ({ channel, totals: usageTotals }))
        .toSorted((a, b) => b.totals.totalCost - a.totals.totalCost),
      latency: computeLatencyStatsFromValues(latencyValues),
      dailyLatency: Array.from(dailyLatencyMap.entries())
        .map(([date, values]) => {
          const stats = computeLatencyStatsFromValues(values);
          if (!stats) {
            return null;
          }
          return { date, ...stats };
        })
        .filter((entry): entry is SessionDailyLatency => Boolean(entry))
        .toSorted((a, b) => a.date.localeCompare(b.date)),
      modelDaily: Array.from(modelDailyMap.values()).toSorted((a, b) =>
        a.date.localeCompare(b.date),
      ),
      daily: Array.from(dailyMap.values()).toSorted((a, b) => a.date.localeCompare(b.date)),
    },
  };
}

export const usageHandlers: GatewayRequestHandlers = {
  "usage.status": async ({ respond }) => {
    const summary = await loadProviderUsageSummary();
    respond(true, summary, undefined);
  },
  "usage.cost": async ({ respond, params }) => {
    const config = loadConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: params?.startDate,
      endDate: params?.endDate,
      days: params?.days,
    });
    const summary = await loadCostUsageSummaryCached({ startMs, endMs, config });
    respond(true, summary, undefined);
  },
  "usage.telemetry": async ({ respond, params }) => {
    if (!validateSessionsUsageParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid usage.telemetry params: ${formatValidationErrors(validateSessionsUsageParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const { startMs, endMs } = parseDateRange({
      startDate: p.startDate,
      endDate: p.endDate,
    });
    const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : 1000;
    const summary = await loadTelemetryUsageSummary({ startMs, endMs, limit });
    respond(true, summary, undefined);
  },
  "sessions.usage": async ({ respond, params }) => {
    if (!validateSessionsUsageParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.usage params: ${formatValidationErrors(validateSessionsUsageParams.errors)}`,
        ),
      );
      return;
    }

    const p = params;
    const config = loadConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: p.startDate,
      endDate: p.endDate,
    });
    const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : 50;
    const includeContextWeight = p.includeContextWeight ?? false;
    const specificKey = typeof p.key === "string" ? p.key.trim() : null;

    // Load session store for named sessions
    const { storePath, store } = loadCombinedSessionStoreForGateway(config);
    const now = Date.now();

    // Merge discovered sessions with store entries
    type MergedEntry = {
      key: string;
      sessionId: string;
      sessionFile: string;
      label?: string;
      updatedAt: number;
      storeEntry?: SessionEntry;
      firstUserMessage?: string;
    };

    const mergedEntries: MergedEntry[] = [];

    // Optimization: If a specific key is requested, skip full directory scan
    if (specificKey) {
      const parsed = parseAgentSessionKey(specificKey);
      const agentIdFromKey = parsed?.agentId;
      const keyRest = parsed?.rest ?? specificKey;

      // Prefer the store entry when available, even if the caller provides a discovered key
      // (`agent:<id>:<sessionId>`) for a session that now has a canonical store key.
      const storeBySessionId = new Map<string, { key: string; entry: SessionEntry }>();
      for (const [key, entry] of Object.entries(store)) {
        if (entry?.sessionId) {
          storeBySessionId.set(entry.sessionId, { key, entry });
        }
      }

      const storeMatch = store[specificKey]
        ? { key: specificKey, entry: store[specificKey] }
        : null;
      const storeByIdMatch = storeBySessionId.get(keyRest) ?? null;
      const resolvedStoreKey = storeMatch?.key ?? storeByIdMatch?.key ?? specificKey;
      const storeEntry = storeMatch?.entry ?? storeByIdMatch?.entry;
      const sessionId = storeEntry?.sessionId ?? keyRest;

      // Resolve the session file path
      let sessionFile: string;
      try {
        const pathOpts = resolveSessionFilePathOptions({
          storePath: storePath !== "(multiple)" ? storePath : undefined,
          agentId: agentIdFromKey,
        });
        sessionFile = resolveSessionFilePath(sessionId, storeEntry, pathOpts);
      } catch {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session reference: ${specificKey}`),
        );
        return;
      }

      try {
        const stats = fs.statSync(sessionFile);
        if (stats.isFile()) {
          mergedEntries.push({
            key: resolvedStoreKey,
            sessionId,
            sessionFile,
            label: storeEntry?.label,
            updatedAt: storeEntry?.updatedAt ?? stats.mtimeMs,
            storeEntry,
          });
        }
      } catch {
        // File doesn't exist - no results for this key
      }
    } else {
      // Full discovery for list view
      const discoveredSessions = await discoverAllSessionsForUsage({
        config,
        startMs,
        endMs,
      });

      // Build a map of sessionId -> store entry for quick lookup
      const storeBySessionId = new Map<string, { key: string; entry: SessionEntry }>();
      for (const [key, entry] of Object.entries(store)) {
        if (entry?.sessionId) {
          storeBySessionId.set(entry.sessionId, { key, entry });
        }
      }

      for (const discovered of discoveredSessions) {
        const storeMatch = storeBySessionId.get(discovered.sessionId);
        if (storeMatch) {
          // Named session from store
          mergedEntries.push({
            key: storeMatch.key,
            sessionId: discovered.sessionId,
            sessionFile: discovered.sessionFile,
            label: storeMatch.entry.label,
            updatedAt: storeMatch.entry.updatedAt ?? discovered.mtime,
            storeEntry: storeMatch.entry,
          });
        } else {
          // Unnamed session - use session ID as key, no label
          mergedEntries.push({
            // Keep agentId in the key so the dashboard can attribute sessions and later fetch logs.
            key: `agent:${discovered.agentId}:${discovered.sessionId}`,
            sessionId: discovered.sessionId,
            sessionFile: discovered.sessionFile,
            label: undefined, // No label for unnamed sessions
            updatedAt: discovered.mtime,
          });
        }
      }
    }

    // Sort by most recent first
    mergedEntries.sort((a, b) => b.updatedAt - a.updatedAt);

    // Apply limit
    const limitedEntries = mergedEntries.slice(0, limit);

    // Load usage for each session
    const sessions: SessionUsageEntry[] = [];
    const aggregateTotals = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    };
    const aggregateMessages: SessionMessageCounts = {
      total: 0,
      user: 0,
      assistant: 0,
      toolCalls: 0,
      toolResults: 0,
      errors: 0,
    };
    const toolAggregateMap = new Map<string, number>();
    const byModelMap = new Map<string, SessionModelUsage>();
    const byProviderMap = new Map<string, SessionModelUsage>();
    const byAgentMap = new Map<string, CostUsageSummary["totals"]>();
    const byChannelMap = new Map<string, CostUsageSummary["totals"]>();
    const dailyAggregateMap = new Map<
      string,
      {
        date: string;
        tokens: number;
        cost: number;
        messages: number;
        toolCalls: number;
        errors: number;
      }
    >();
    const latencyTotals = {
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: 0,
      p95Max: 0,
    };
    const dailyLatencyMap = new Map<
      string,
      { date: string; count: number; sum: number; min: number; max: number; p95Max: number }
    >();
    const modelDailyMap = new Map<string, SessionDailyModelUsage>();

    const emptyTotals = (): CostUsageSummary["totals"] => ({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    });
    const mergeTotals = (
      target: CostUsageSummary["totals"],
      source: CostUsageSummary["totals"],
    ) => {
      target.input += source.input;
      target.output += source.output;
      target.cacheRead += source.cacheRead;
      target.cacheWrite += source.cacheWrite;
      target.totalTokens += source.totalTokens;
      target.totalCost += source.totalCost;
      target.inputCost += source.inputCost;
      target.outputCost += source.outputCost;
      target.cacheReadCost += source.cacheReadCost;
      target.cacheWriteCost += source.cacheWriteCost;
      target.missingCostEntries += source.missingCostEntries;
    };

    for (const merged of limitedEntries) {
      const usage = await loadSessionCostSummary({
        sessionId: merged.sessionId,
        sessionEntry: merged.storeEntry,
        sessionFile: merged.sessionFile,
        config,
        startMs,
        endMs,
      });

      if (usage) {
        aggregateTotals.input += usage.input;
        aggregateTotals.output += usage.output;
        aggregateTotals.cacheRead += usage.cacheRead;
        aggregateTotals.cacheWrite += usage.cacheWrite;
        aggregateTotals.totalTokens += usage.totalTokens;
        aggregateTotals.totalCost += usage.totalCost;
        aggregateTotals.inputCost += usage.inputCost;
        aggregateTotals.outputCost += usage.outputCost;
        aggregateTotals.cacheReadCost += usage.cacheReadCost;
        aggregateTotals.cacheWriteCost += usage.cacheWriteCost;
        aggregateTotals.missingCostEntries += usage.missingCostEntries;
      }

      const agentId = parseAgentSessionKey(merged.key)?.agentId;
      const channel = merged.storeEntry?.channel ?? merged.storeEntry?.origin?.provider;
      const chatType = merged.storeEntry?.chatType ?? merged.storeEntry?.origin?.chatType;

      if (usage) {
        if (usage.messageCounts) {
          aggregateMessages.total += usage.messageCounts.total;
          aggregateMessages.user += usage.messageCounts.user;
          aggregateMessages.assistant += usage.messageCounts.assistant;
          aggregateMessages.toolCalls += usage.messageCounts.toolCalls;
          aggregateMessages.toolResults += usage.messageCounts.toolResults;
          aggregateMessages.errors += usage.messageCounts.errors;
        }

        if (usage.toolUsage) {
          for (const tool of usage.toolUsage.tools) {
            toolAggregateMap.set(tool.name, (toolAggregateMap.get(tool.name) ?? 0) + tool.count);
          }
        }

        if (usage.modelUsage) {
          for (const entry of usage.modelUsage) {
            const modelKey = `${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
            const modelExisting =
              byModelMap.get(modelKey) ??
              ({
                provider: entry.provider,
                model: entry.model,
                count: 0,
                totals: emptyTotals(),
              } as SessionModelUsage);
            modelExisting.count += entry.count;
            mergeTotals(modelExisting.totals, entry.totals);
            byModelMap.set(modelKey, modelExisting);

            const providerKey = entry.provider ?? "unknown";
            const providerExisting =
              byProviderMap.get(providerKey) ??
              ({
                provider: entry.provider,
                model: undefined,
                count: 0,
                totals: emptyTotals(),
              } as SessionModelUsage);
            providerExisting.count += entry.count;
            mergeTotals(providerExisting.totals, entry.totals);
            byProviderMap.set(providerKey, providerExisting);
          }
        }

        if (usage.latency) {
          const { count, avgMs, minMs, maxMs, p95Ms } = usage.latency;
          if (count > 0) {
            latencyTotals.count += count;
            latencyTotals.sum += avgMs * count;
            latencyTotals.min = Math.min(latencyTotals.min, minMs);
            latencyTotals.max = Math.max(latencyTotals.max, maxMs);
            latencyTotals.p95Max = Math.max(latencyTotals.p95Max, p95Ms);
          }
        }

        if (usage.dailyLatency) {
          for (const day of usage.dailyLatency) {
            const existing = dailyLatencyMap.get(day.date) ?? {
              date: day.date,
              count: 0,
              sum: 0,
              min: Number.POSITIVE_INFINITY,
              max: 0,
              p95Max: 0,
            };
            existing.count += day.count;
            existing.sum += day.avgMs * day.count;
            existing.min = Math.min(existing.min, day.minMs);
            existing.max = Math.max(existing.max, day.maxMs);
            existing.p95Max = Math.max(existing.p95Max, day.p95Ms);
            dailyLatencyMap.set(day.date, existing);
          }
        }

        if (usage.dailyModelUsage) {
          for (const entry of usage.dailyModelUsage) {
            const key = `${entry.date}::${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
            const existing =
              modelDailyMap.get(key) ??
              ({
                date: entry.date,
                provider: entry.provider,
                model: entry.model,
                tokens: 0,
                cost: 0,
                count: 0,
              } as SessionDailyModelUsage);
            existing.tokens += entry.tokens;
            existing.cost += entry.cost;
            existing.count += entry.count;
            modelDailyMap.set(key, existing);
          }
        }

        if (agentId) {
          const agentTotals = byAgentMap.get(agentId) ?? emptyTotals();
          mergeTotals(agentTotals, usage);
          byAgentMap.set(agentId, agentTotals);
        }

        if (channel) {
          const channelTotals = byChannelMap.get(channel) ?? emptyTotals();
          mergeTotals(channelTotals, usage);
          byChannelMap.set(channel, channelTotals);
        }

        if (usage.dailyBreakdown) {
          for (const day of usage.dailyBreakdown) {
            const daily = dailyAggregateMap.get(day.date) ?? {
              date: day.date,
              tokens: 0,
              cost: 0,
              messages: 0,
              toolCalls: 0,
              errors: 0,
            };
            daily.tokens += day.tokens;
            daily.cost += day.cost;
            dailyAggregateMap.set(day.date, daily);
          }
        }

        if (usage.dailyMessageCounts) {
          for (const day of usage.dailyMessageCounts) {
            const daily = dailyAggregateMap.get(day.date) ?? {
              date: day.date,
              tokens: 0,
              cost: 0,
              messages: 0,
              toolCalls: 0,
              errors: 0,
            };
            daily.messages += day.total;
            daily.toolCalls += day.toolCalls;
            daily.errors += day.errors;
            dailyAggregateMap.set(day.date, daily);
          }
        }
      }

      sessions.push({
        key: merged.key,
        label: merged.label,
        sessionId: merged.sessionId,
        updatedAt: merged.updatedAt,
        agentId,
        channel,
        chatType,
        origin: merged.storeEntry?.origin,
        modelOverride: merged.storeEntry?.modelOverride,
        providerOverride: merged.storeEntry?.providerOverride,
        modelProvider: merged.storeEntry?.modelProvider,
        model: merged.storeEntry?.model,
        usage,
        contextWeight: includeContextWeight
          ? (merged.storeEntry?.systemPromptReport ?? null)
          : undefined,
      });
    }

    // Format dates back to YYYY-MM-DD strings
    const formatDateStr = (ms: number) => {
      const d = new Date(ms);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    };

    const aggregates: SessionsUsageAggregates = {
      messages: aggregateMessages,
      tools: {
        totalCalls: Array.from(toolAggregateMap.values()).reduce((sum, count) => sum + count, 0),
        uniqueTools: toolAggregateMap.size,
        tools: Array.from(toolAggregateMap.entries())
          .map(([name, count]) => ({ name, count }))
          .toSorted((a, b) => b.count - a.count),
      },
      byModel: Array.from(byModelMap.values()).toSorted((a, b) => {
        const costDiff = b.totals.totalCost - a.totals.totalCost;
        if (costDiff !== 0) {
          return costDiff;
        }
        return b.totals.totalTokens - a.totals.totalTokens;
      }),
      byProvider: Array.from(byProviderMap.values()).toSorted((a, b) => {
        const costDiff = b.totals.totalCost - a.totals.totalCost;
        if (costDiff !== 0) {
          return costDiff;
        }
        return b.totals.totalTokens - a.totals.totalTokens;
      }),
      byAgent: Array.from(byAgentMap.entries())
        .map(([id, totals]) => ({ agentId: id, totals }))
        .toSorted((a, b) => b.totals.totalCost - a.totals.totalCost),
      byChannel: Array.from(byChannelMap.entries())
        .map(([name, totals]) => ({ channel: name, totals }))
        .toSorted((a, b) => b.totals.totalCost - a.totals.totalCost),
      latency:
        latencyTotals.count > 0
          ? {
              count: latencyTotals.count,
              avgMs: latencyTotals.sum / latencyTotals.count,
              minMs: latencyTotals.min === Number.POSITIVE_INFINITY ? 0 : latencyTotals.min,
              maxMs: latencyTotals.max,
              p95Ms: latencyTotals.p95Max,
            }
          : undefined,
      dailyLatency: Array.from(dailyLatencyMap.values())
        .map((entry) => ({
          date: entry.date,
          count: entry.count,
          avgMs: entry.count ? entry.sum / entry.count : 0,
          minMs: entry.min === Number.POSITIVE_INFINITY ? 0 : entry.min,
          maxMs: entry.max,
          p95Ms: entry.p95Max,
        }))
        .toSorted((a, b) => a.date.localeCompare(b.date)),
      modelDaily: Array.from(modelDailyMap.values()).toSorted(
        (a, b) => a.date.localeCompare(b.date) || b.cost - a.cost,
      ),
      daily: Array.from(dailyAggregateMap.values()).toSorted((a, b) =>
        a.date.localeCompare(b.date),
      ),
    };

    const result: SessionsUsageResult = {
      updatedAt: now,
      startDate: formatDateStr(startMs),
      endDate: formatDateStr(endMs),
      sessions,
      totals: aggregateTotals,
      aggregates,
    };

    respond(true, result, undefined);
  },
  "sessions.usage.timeseries": async ({ respond, params }) => {
    const key = typeof params?.key === "string" ? params.key.trim() : null;
    if (!key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "key is required for timeseries"),
      );
      return;
    }

    const config = loadConfig();
    const { entry, storePath } = loadSessionEntry(key);

    // For discovered sessions (not in store), try using key as sessionId directly
    const parsed = parseAgentSessionKey(key);
    const agentId = parsed?.agentId;
    const rawSessionId = parsed?.rest ?? key;
    const sessionId = entry?.sessionId ?? rawSessionId;
    let sessionFile: string;
    try {
      const pathOpts = resolveSessionFilePathOptions({ storePath, agentId });
      sessionFile = resolveSessionFilePath(sessionId, entry, pathOpts);
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session key: ${key}`),
      );
      return;
    }

    const timeseries = await loadSessionUsageTimeSeries({
      sessionId,
      sessionEntry: entry,
      sessionFile,
      config,
      maxPoints: 200,
    });

    if (!timeseries) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `No transcript found for session: ${key}`),
      );
      return;
    }

    respond(true, timeseries, undefined);
  },
  "sessions.usage.logs": async ({ respond, params }) => {
    const key = typeof params?.key === "string" ? params.key.trim() : null;
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key is required for logs"));
      return;
    }

    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.min(params.limit, 1000)
        : 200;

    const config = loadConfig();
    const { entry, storePath } = loadSessionEntry(key);

    // For discovered sessions (not in store), try using key as sessionId directly
    const parsed = parseAgentSessionKey(key);
    const agentId = parsed?.agentId;
    const rawSessionId = parsed?.rest ?? key;
    const sessionId = entry?.sessionId ?? rawSessionId;
    let sessionFile: string;
    try {
      const pathOpts = resolveSessionFilePathOptions({ storePath, agentId });
      sessionFile = resolveSessionFilePath(sessionId, entry, pathOpts);
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session key: ${key}`),
      );
      return;
    }

    const { loadSessionLogs } = await import("../../infra/session-cost-usage.js");
    const logs = await loadSessionLogs({
      sessionId,
      sessionEntry: entry,
      sessionFile,
      config,
      limit,
    });

    respond(true, { logs: logs ?? [] }, undefined);
  },
};
