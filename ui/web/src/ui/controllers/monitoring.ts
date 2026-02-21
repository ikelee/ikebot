import type { GatewayBrowserClient } from "../gateway.ts";
import type { SessionsUsageResult } from "../types.ts";

export type MonitoringState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  monitoringLoading: boolean;
  monitoringError: string | null;
  monitoringDays: string;
  monitoringResult: SessionsUsageResult | null;
};

function parseDays(raw: string): number {
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 7;
  }
  return Math.min(parsed, 365);
}

function formatYmd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

export async function loadMonitoring(state: MonitoringState) {
  if (!state.client || !state.connected || state.monitoringLoading) {
    return;
  }
  state.monitoringLoading = true;
  state.monitoringError = null;
  try {
    const days = parseDays(state.monitoringDays);
    const end = new Date();
    const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    const result = await state.client.request<SessionsUsageResult>("sessions.usage", {
      startDate: formatYmd(start),
      endDate: formatYmd(end),
      limit: 1000,
    });
    state.monitoringResult = result;
  } catch (err) {
    state.monitoringError = String(err);
  } finally {
    state.monitoringLoading = false;
  }
}
