import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  AgentFileEntry,
  AgentsFilesDeleteResult,
  AgentsFilesGetResult,
  AgentsFilesListResult,
  AgentsFilesSetResult,
  AgentsListResult,
  HealthSnapshot,
  StatusSummary,
} from "../types.ts";
import { extractText } from "../chat/message-extract.ts";
import { generateUUID } from "../uuid.ts";

type DebugAgentFileSnapshot = {
  name: string;
  path: string;
  missing: boolean;
  content: string;
  size?: number;
  updatedAtMs?: number;
};

export type DebugAgentFileChange = {
  name: string;
  path: string;
  status: "created" | "modified" | "deleted";
  before: DebugAgentFileSnapshot;
  after: DebugAgentFileSnapshot;
  beforeLines: number;
  afterLines: number;
};

export type DebugAgentChatMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: number | null;
};

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
  agentTestAgentId: string | null;
  agentTestMessage: string;
  agentTestBusy: boolean;
  agentTestRunId: string | null;
  agentTestTotalDurationMs: number | null;
  agentTestStatus: string | null;
  agentTestError: string | null;
  agentTestReply: string | null;
  agentTestBaselineFiles: Record<string, DebugAgentFileSnapshot>;
  agentTestCurrentFiles: Record<string, DebugAgentFileSnapshot>;
  agentTestChanges: DebugAgentFileChange[];
  agentTestUndoBusy: boolean;
  agentTestHistoryLoading: boolean;
  agentTestHistoryError: string | null;
  agentTestHistory: DebugAgentChatMessage[];
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

function lineCount(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split(/\r?\n/).length;
}

function mapFileEntryToSnapshot(file: AgentFileEntry): DebugAgentFileSnapshot {
  return {
    name: file.name,
    path: file.path,
    missing: file.missing,
    content: file.content ?? "",
    size: file.size,
    updatedAtMs: file.updatedAtMs,
  };
}

function snapshotsToRecord(
  files: DebugAgentFileSnapshot[],
): Record<string, DebugAgentFileSnapshot> {
  const out: Record<string, DebugAgentFileSnapshot> = {};
  for (const file of files) {
    out[file.name] = file;
  }
  return out;
}

function computeChanges(
  baseline: Record<string, DebugAgentFileSnapshot>,
  current: Record<string, DebugAgentFileSnapshot>,
): DebugAgentFileChange[] {
  const names = new Set<string>([...Object.keys(baseline), ...Object.keys(current)]);
  const changes: DebugAgentFileChange[] = [];
  for (const name of names) {
    const before =
      baseline[name] ??
      ({
        name,
        path: current[name]?.path ?? name,
        missing: true,
        content: "",
      } satisfies DebugAgentFileSnapshot);
    const after =
      current[name] ??
      ({
        name,
        path: before.path,
        missing: true,
        content: "",
      } satisfies DebugAgentFileSnapshot);
    if (before.missing === after.missing && before.content === after.content) {
      continue;
    }
    const status: DebugAgentFileChange["status"] =
      before.missing && !after.missing
        ? "created"
        : !before.missing && after.missing
          ? "deleted"
          : "modified";
    changes.push({
      name,
      path: after.path || before.path,
      status,
      before,
      after,
      beforeLines: lineCount(before.content),
      afterLines: lineCount(after.content),
    });
  }
  return changes.toSorted((a, b) => a.name.localeCompare(b.name));
}

async function loadAgentFileSnapshots(
  state: DebugState,
  agentId: string,
): Promise<Record<string, DebugAgentFileSnapshot>> {
  if (!state.client || !state.connected) {
    return {};
  }
  const list = await state.client.request<AgentsFilesListResult>("agents.files.list", { agentId });
  const detailed = await Promise.all(
    list.files.map(async (entry) => {
      const res = await state.client.request<AgentsFilesGetResult>("agents.files.get", {
        agentId,
        name: entry.name,
      });
      return mapFileEntryToSnapshot(res.file);
    }),
  );
  return snapshotsToRecord(detailed);
}

async function loadLatestAssistantReply(
  state: DebugState,
  sessionKey: string,
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const history = await state.client.request<{ messages?: unknown[] }>("chat.history", {
    sessionKey,
    limit: 40,
  });
  const messages = Array.isArray(history.messages) ? history.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as { role?: unknown };
    if (msg.role === "assistant") {
      const text = extractText(msg);
      if (text?.trim()) {
        return text.trim();
      }
    }
  }
  return null;
}

export async function loadDebugAgentHistory(state: DebugState) {
  if (!state.client || !state.connected || !state.agentTestAgentId) {
    return;
  }
  const sessionKey = buildAgentTestingSessionKey(state.agentTestAgentId);
  state.agentTestHistoryLoading = true;
  state.agentTestHistoryError = null;
  try {
    const history = await state.client.request<{ messages?: unknown[] }>("chat.history", {
      sessionKey,
      limit: 60,
    });
    const raw = Array.isArray(history.messages) ? history.messages : [];
    const rows: DebugAgentChatMessage[] = [];
    for (let i = raw.length - 1; i >= 0; i -= 1) {
      const msg = raw[i];
      const record = msg as { role?: unknown; timestamp?: unknown };
      const role = record.role === "user" || record.role === "assistant" ? record.role : null;
      if (!role) {
        continue;
      }
      const text = extractText(msg)?.trim();
      if (!text) {
        continue;
      }
      rows.push({
        role,
        text,
        timestamp: typeof record.timestamp === "number" ? record.timestamp : null,
      });
    }
    state.agentTestHistory = rows;
  } catch (err) {
    state.agentTestHistoryError = String(err);
  } finally {
    state.agentTestHistoryLoading = false;
  }
}

export async function runDebugAgentTest(state: DebugState) {
  if (!state.client || !state.connected) {
    return;
  }
  const agentId = state.agentTestAgentId?.trim() ?? "";
  const message = state.agentTestMessage.trim();
  if (!agentId || !message || state.agentTestBusy) {
    return;
  }

  state.agentTestBusy = true;
  state.agentTestRunId = null;
  state.agentTestTotalDurationMs = null;
  state.agentTestStatus = "Capturing baseline files…";
  state.agentTestError = null;
  state.agentTestReply = null;
  state.agentTestChanges = [];

  try {
    const startedAt = Date.now();
    const baseline = await loadAgentFileSnapshots(state, agentId);
    state.agentTestBaselineFiles = baseline;
    state.agentTestCurrentFiles = baseline;

    const runId = generateUUID();
    const sessionKey = buildAgentTestingSessionKey(agentId);
    state.agentTestStatus = "Sending test prompt (direct agent)…";
    const started = await state.client.request<{ runId?: string }>("agent", {
      agentId,
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: runId,
    });
    const resolvedRunId = typeof started.runId === "string" ? started.runId : runId;
    state.agentTestRunId = resolvedRunId;

    state.agentTestStatus = "Waiting for agent run to finish…";
    const waited = await state.client.request<{ status?: string }>("agent.wait", {
      runId: resolvedRunId,
      timeoutMs: 240_000,
    });
    state.agentTestStatus =
      waited.status === "timeout"
        ? "Timed out waiting for completion. Showing latest file state."
        : "Run completed. Refreshing files…";

    const current = await loadAgentFileSnapshots(state, agentId);
    state.agentTestCurrentFiles = current;
    state.agentTestChanges = computeChanges(baseline, current);
    state.agentTestReply = await loadLatestAssistantReply(state, sessionKey);
    await loadDebugAgentHistory(state);
    if (state.agentTestStatus === "Run completed. Refreshing files…") {
      state.agentTestStatus = `Done. ${state.agentTestChanges.length} file(s) changed.`;
    }
    state.agentTestTotalDurationMs = Date.now() - startedAt;
  } catch (err) {
    state.agentTestError = String(err);
    state.agentTestStatus = null;
  } finally {
    state.agentTestBusy = false;
  }
}

function buildAgentTestingSessionKey(agentId: string): string {
  return `agent:${agentId}:testing`;
}

export async function refreshDebugAgentFiles(state: DebugState) {
  if (!state.client || !state.connected || !state.agentTestAgentId || state.agentTestBusy) {
    return;
  }
  const agentId = state.agentTestAgentId;
  state.agentTestBusy = true;
  state.agentTestStatus = "Refreshing files…";
  state.agentTestError = null;
  try {
    const current = await loadAgentFileSnapshots(state, agentId);
    state.agentTestCurrentFiles = current;
    state.agentTestChanges = computeChanges(state.agentTestBaselineFiles, current);
    state.agentTestStatus = "Files refreshed.";
  } catch (err) {
    state.agentTestError = String(err);
    state.agentTestStatus = null;
  } finally {
    state.agentTestBusy = false;
  }
}

export async function undoDebugAgentFileChange(state: DebugState, name: string) {
  if (
    !state.client ||
    !state.connected ||
    !state.agentTestAgentId ||
    state.agentTestUndoBusy ||
    state.agentTestBusy
  ) {
    return;
  }
  const baseline = state.agentTestBaselineFiles[name];
  if (!baseline) {
    return;
  }
  const agentId = state.agentTestAgentId;
  state.agentTestUndoBusy = true;
  state.agentTestError = null;
  state.agentTestStatus = `Undoing ${name}…`;
  try {
    if (baseline.missing) {
      await state.client.request<AgentsFilesDeleteResult>("agents.files.delete", { agentId, name });
    } else {
      await state.client.request<AgentsFilesSetResult>("agents.files.set", {
        agentId,
        name,
        content: baseline.content,
      });
    }
    const current = await loadAgentFileSnapshots(state, agentId);
    state.agentTestCurrentFiles = current;
    state.agentTestChanges = computeChanges(state.agentTestBaselineFiles, current);
    state.agentTestStatus = `Undid ${name}.`;
  } catch (err) {
    state.agentTestError = String(err);
    state.agentTestStatus = null;
  } finally {
    state.agentTestUndoBusy = false;
  }
}

export async function undoAllDebugAgentFileChanges(state: DebugState) {
  if (
    !state.client ||
    !state.connected ||
    !state.agentTestAgentId ||
    state.agentTestUndoBusy ||
    state.agentTestBusy
  ) {
    return;
  }
  const names = state.agentTestChanges.map((change) => change.name);
  if (names.length === 0) {
    return;
  }
  const agentId = state.agentTestAgentId;
  state.agentTestUndoBusy = true;
  state.agentTestError = null;
  state.agentTestStatus = "Undoing all file changes…";
  try {
    for (const name of names) {
      const baseline = state.agentTestBaselineFiles[name];
      if (!baseline) {
        continue;
      }
      if (baseline.missing) {
        await state.client.request<AgentsFilesDeleteResult>("agents.files.delete", {
          agentId,
          name,
        });
      } else {
        await state.client.request<AgentsFilesSetResult>("agents.files.set", {
          agentId,
          name,
          content: baseline.content,
        });
      }
    }
    const current = await loadAgentFileSnapshots(state, agentId);
    state.agentTestCurrentFiles = current;
    state.agentTestChanges = computeChanges(state.agentTestBaselineFiles, current);
    state.agentTestStatus = "All changes undone.";
  } catch (err) {
    state.agentTestError = String(err);
    state.agentTestStatus = null;
  } finally {
    state.agentTestUndoBusy = false;
  }
}
