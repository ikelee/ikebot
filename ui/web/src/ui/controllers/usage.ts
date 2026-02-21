import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  SessionsListResult,
  SessionsUsageResult,
  CostUsageSummary,
  SessionUsageTimeSeries,
} from "../types.ts";
import type { SessionLogEntry } from "../views/usage.ts";

export type UsageState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  usageLoading: boolean;
  usageResult: SessionsUsageResult | null;
  usageCostSummary: CostUsageSummary | null;
  usageError: string | null;
  usageStartDate: string;
  usageEndDate: string;
  usageSelectedSessions: string[];
  usageSelectedDays: string[];
  usageTimeSeries: SessionUsageTimeSeries | null;
  usageTimeSeriesLoading: boolean;
  usageSessionLogs: SessionLogEntry[] | null;
  usageSessionLogsLoading: boolean;
};

export async function loadUsage(
  state: UsageState,
  overrides?: {
    startDate?: string;
    endDate?: string;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.usageLoading) {
    return;
  }
  state.usageLoading = true;
  state.usageError = null;
  try {
    const startDate = overrides?.startDate ?? state.usageStartDate;
    const endDate = overrides?.endDate ?? state.usageEndDate;

    // Load all endpoints in parallel so usage sessions can show friendly titles.
    const [sessionsRes, costRes, listRes] = await Promise.all([
      state.client.request("sessions.usage", {
        startDate,
        endDate,
        limit: 1000, // Cap at 1000 sessions
        includeContextWeight: true,
      }),
      state.client.request("usage.cost", { startDate, endDate }),
      state.client.request("sessions.list", {
        limit: 2000,
        includeGlobal: true,
        includeUnknown: true,
        includeDerivedTitles: true,
      }),
    ]);

    if (sessionsRes) {
      const usage = sessionsRes as SessionsUsageResult;
      const sessionList = listRes as SessionsListResult;
      const byKey = new Map(
        (sessionList.sessions ?? []).map((entry) => [entry.key, entry] as const),
      );
      usage.sessions = usage.sessions.map((entry) => {
        const match = byKey.get(entry.key);
        const displayName = match?.displayName?.trim() || undefined;
        const derivedTitle = match?.derivedTitle?.trim() || undefined;
        const keyLower = entry.key.toLowerCase();
        const runKind: "cron" | "test" | "session" = keyLower.includes(":testing")
          ? "test"
          : keyLower.includes(":cron:")
            ? "cron"
            : "session";
        return {
          ...entry,
          label: entry.label ?? match?.label ?? undefined,
          displayName,
          derivedTitle,
          runKind,
        };
      });
      state.usageResult = usage;
    }
    if (costRes) {
      state.usageCostSummary = costRes as CostUsageSummary;
    }
  } catch (err) {
    state.usageError = String(err);
  } finally {
    state.usageLoading = false;
  }
}

export async function loadSessionTimeSeries(state: UsageState, sessionKey: string) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.usageTimeSeriesLoading) {
    return;
  }
  state.usageTimeSeriesLoading = true;
  state.usageTimeSeries = null;
  try {
    const res = await state.client.request("sessions.usage.timeseries", { key: sessionKey });
    if (res) {
      state.usageTimeSeries = res as SessionUsageTimeSeries;
    }
  } catch {
    // Silently fail - time series is optional
    state.usageTimeSeries = null;
  } finally {
    state.usageTimeSeriesLoading = false;
  }
}

export async function loadSessionLogs(state: UsageState, sessionKey: string) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.usageSessionLogsLoading) {
    return;
  }
  state.usageSessionLogsLoading = true;
  state.usageSessionLogs = null;
  try {
    const res = await state.client.request("sessions.usage.logs", { key: sessionKey, limit: 500 });
    if (res && Array.isArray((res as { logs: SessionLogEntry[] }).logs)) {
      state.usageSessionLogs = (res as { logs: SessionLogEntry[] }).logs;
    }
  } catch {
    // Silently fail - logs are optional
    state.usageSessionLogs = null;
  } finally {
    state.usageSessionLogsLoading = false;
  }
}
