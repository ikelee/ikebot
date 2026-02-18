import type { GatewayBrowserClient } from "../gateway.ts";
import type { AgentsListResult, HealthSnapshot, StatusSummary } from "../types.ts";

export type DebugState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  debugLoading: boolean;
  debugStatus: StatusSummary | null;
  debugHealth: HealthSnapshot | null;
  debugModels: unknown[];
  debugHeartbeat: unknown;
  debugAgentsList: AgentsListResult | null;
  debugCallMethod: string;
  debugCallParams: string;
  debugCallResult: string | null;
  debugCallError: string | null;
  piConfigAgentId: string | null;
  piConfigResult: {
    agentId: string;
    piConfig?: unknown;
    resolvedPiConfig: unknown;
    sandboxPreview?: { mode: string; workspaceAccess: string; sandboxed: boolean };
    testMemoryPath?: string;
  } | null;
  piConfigLoading: boolean;
  piConfigSandboxPreview: boolean;
  piConfigTestMemoryPath: string;
};

export async function loadDebug(state: DebugState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.debugLoading) {
    return;
  }
  state.debugLoading = true;
  try {
    const [status, health, models, heartbeat, agentsList] = await Promise.all([
      state.client.request("status", {}),
      state.client.request("health", {}),
      state.client.request("models.list", {}),
      state.client.request("last-heartbeat", {}),
      state.client.request("agents.list", {}),
    ]);
    state.debugStatus = status as StatusSummary;
    state.debugHealth = health as HealthSnapshot;
    const modelPayload = models as { models?: unknown[] } | undefined;
    state.debugModels = Array.isArray(modelPayload?.models) ? modelPayload?.models : [];
    state.debugHeartbeat = heartbeat;
    state.debugAgentsList = agentsList as AgentsListResult;
  } catch (err) {
    state.debugCallError = String(err);
  } finally {
    state.debugLoading = false;
  }
}

export async function loadPiConfig(state: DebugState, agentId: string) {
  if (!state.client || !state.connected || !agentId) {
    return;
  }
  state.piConfigLoading = true;
  state.piConfigResult = null;
  try {
    const params: Record<string, unknown> = { agentId };
    if (state.piConfigSandboxPreview) {
      params.sandboxPreview = true;
    }
    if (state.piConfigTestMemoryPath.trim()) {
      params.testMemoryPath = state.piConfigTestMemoryPath.trim();
    }
    const res = await state.client.request<{
      agentId: string;
      piConfig?: unknown;
      resolvedPiConfig: unknown;
      sandboxPreview?: { mode: string; workspaceAccess: string; sandboxed: boolean };
      testMemoryPath?: string;
    }>("agents.piConfig", params);
    state.piConfigResult = res;
  } catch {
    state.piConfigResult = null;
  } finally {
    state.piConfigLoading = false;
  }
}

export async function callDebugMethod(state: DebugState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.debugCallError = null;
  state.debugCallResult = null;
  try {
    const params = state.debugCallParams.trim()
      ? (JSON.parse(state.debugCallParams) as unknown)
      : {};
    const res = await state.client.request(state.debugCallMethod.trim(), params);
    state.debugCallResult = JSON.stringify(res, null, 2);
  } catch (err) {
    state.debugCallError = String(err);
  }
}
