import { html, nothing } from "lit";
import type { DebugAgentChatMessage, DebugAgentFileChange } from "../controllers/debug.ts";
import type { AgentFileEntry, AgentsFilesListResult, AgentsListResult } from "../types.ts";
import { formatRelativeTimestamp } from "../format.ts";

export type AgentTestingProps = {
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  agentFilesList: AgentsFilesListResult | null;
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFileActive: string | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileSaving: boolean;
  onLoadFiles: (agentId: string) => void;
  onSelectFile: (name: string) => void;
  onFileDraftChange: (name: string, content: string) => void;
  onFileReset: (name: string) => void;
  onFileSave: (name: string) => void;
  agentTestBusy: boolean;
  agentTestRunId: string | null;
  agentTestTotalDurationMs: number | null;
  agentTestUseCloudModel: boolean;
  agentTestCloudModelRef: string;
  agentTestStatus: string | null;
  agentTestError: string | null;
  agentTestReply: string | null;
  agentTestMessage: string;
  agentTestChanges: DebugAgentFileChange[];
  agentTestBaselineFiles: Record<
    string,
    {
      name: string;
      path: string;
      missing: boolean;
      content: string;
      size?: number;
      updatedAtMs?: number;
    }
  >;
  agentTestCurrentFiles: Record<
    string,
    {
      name: string;
      path: string;
      missing: boolean;
      content: string;
      size?: number;
      updatedAtMs?: number;
    }
  >;
  agentTestUndoBusy: boolean;
  onAgentTestMessageChange: (value: string) => void;
  onAgentTestUseCloudModelChange: (value: boolean) => void;
  onAgentTestCloudModelRefChange: (value: string) => void;
  onRunAgentTest: () => void;
  onResetAgentOnboarding: () => void;
  onRefreshAgentFiles: () => void;
  onUndoAgentFileChange: (name: string) => void;
  onUndoAllAgentFileChanges: () => void;
  historyLoading: boolean;
  historyError: string | null;
  history: DebugAgentChatMessage[];
  onRefreshHistory: () => void;
};

function formatBytes(bytes?: number) {
  if (bytes == null || !Number.isFinite(bytes)) {
    return "-";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

function renderAgentFileRow(file: AgentFileEntry, active: string | null, onSelect: () => void) {
  const status = file.missing
    ? "Missing"
    : `${formatBytes(file.size)} · ${formatRelativeTimestamp(file.updatedAtMs ?? null)}`;
  return html`
    <button
      type="button"
      class="agent-file-row ${active === file.name ? "active" : ""}"
      @click=${onSelect}
    >
      <div>
        <div class="agent-file-name mono">${file.name}</div>
        <div class="agent-file-meta">${status}</div>
      </div>
      ${
        file.missing
          ? html`
              <span class="chip chip-warn">Missing</span>
            `
          : nothing
      }
    </button>
  `;
}

type LineDiffRow = {
  kind: "add" | "remove";
  beforeNo: number | null;
  afterNo: number | null;
  text: string;
};

function splitLines(content: string): string[] {
  if (!content) {
    return [];
  }
  return content.split(/\r?\n/);
}

function buildLineDiffRows(beforeText: string, afterText: string): LineDiffRow[] {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  const rows: LineDiffRow[] = [];
  let i = 0;
  let j = 0;

  while (i < before.length || j < after.length) {
    const b = i < before.length ? before[i] : null;
    const a = j < after.length ? after[j] : null;
    if (b === a) {
      i += 1;
      j += 1;
      continue;
    }

    const nextBefore = i + 1 < before.length ? before[i + 1] : null;
    const nextAfter = j + 1 < after.length ? after[j + 1] : null;

    if (b !== null && nextBefore === a) {
      rows.push({ kind: "remove", beforeNo: i + 1, afterNo: null, text: b });
      i += 1;
      continue;
    }
    if (a !== null && b === nextAfter) {
      rows.push({ kind: "add", beforeNo: null, afterNo: j + 1, text: a });
      j += 1;
      continue;
    }
    if (b !== null) {
      rows.push({ kind: "remove", beforeNo: i + 1, afterNo: null, text: b });
      i += 1;
    }
    if (a !== null) {
      rows.push({ kind: "add", beforeNo: null, afterNo: j + 1, text: a });
      j += 1;
    }
  }

  return rows;
}

function renderLineDiff(beforeText: string, afterText: string) {
  const rows = buildLineDiffRows(beforeText, afterText);
  if (rows.length === 0) {
    return html`
      <div class="muted">No line-level changes.</div>
    `;
  }
  const maxRows = 240;
  const visibleRows = rows.slice(0, maxRows);
  const removed = rows.filter((row) => row.kind === "remove").length;
  const added = rows.length - removed;
  return html`
    <div class="diff-summary">
      <span class="chip chip-danger">-${removed}</span>
      <span class="chip chip-ok">+${added}</span>
      ${rows.length > maxRows ? html`<span class="muted">Showing first ${maxRows} changed lines</span>` : nothing}
    </div>
    <div class="agent-line-diff">
      ${visibleRows.map(
        (row) => html`
          <div class="agent-line-diff-row agent-line-diff-row--${row.kind}">
            <div class="agent-line-no">${row.beforeNo ?? ""}</div>
            <div class="agent-line-no">${row.afterNo ?? ""}</div>
            <pre class="agent-line-text">${row.text}</pre>
          </div>
        `,
      )}
    </div>
  `;
}

function formatLatencyMs(value?: number | null): string | null {
  if (value == null || !Number.isFinite(value) || value < 0) {
    return null;
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  return `${(value / 1000).toFixed(2)}s`;
}

function resolveAgentEmoji(agentId: string, configured?: string): string {
  if (configured?.trim()) {
    return configured.trim();
  }
  const id = agentId.trim().toLowerCase();
  const fallback: Record<string, string> = {
    main: "🧠",
    workouts: "🏋️",
    calendar: "📅",
    reminders: "⏰",
    finance: "💸",
    mail: "📨",
    multi: "🧩",
  };
  return fallback[id] ?? "🤖";
}

export function renderAgentTesting(props: AgentTestingProps) {
  const agents = props.agentsList?.agents ?? [];
  const defaultId = props.agentsList?.defaultId ?? null;
  const selectedId = props.selectedAgentId ?? defaultId ?? agents[0]?.id ?? null;
  const selectedAgent = selectedId
    ? (agents.find((agent) => agent.id === selectedId) ?? null)
    : null;
  const list =
    selectedAgent && props.agentFilesList?.agentId === selectedAgent.id
      ? props.agentFilesList
      : null;
  const files = list?.files ?? [];
  const active = props.agentFileActive ?? null;
  const activeEntry = active ? (files.find((file) => file.name === active) ?? null) : null;
  const baseContent = active ? (props.agentFileContents[active] ?? "") : "";
  const draft = active ? (props.agentFileDrafts[active] ?? baseContent) : "";
  const isDirty = active ? draft !== baseContent : false;
  const selectedAgentName = selectedAgent?.name?.trim() || selectedAgent?.id || "agent";
  const selectedAgentEmoji = selectedAgent
    ? resolveAgentEmoji(selectedAgent.id, selectedAgent.identity?.emoji)
    : "🤖";
  const loopFinished =
    !props.agentTestBusy &&
    !!props.agentTestRunId &&
    !!props.agentTestStatus &&
    /done|timed out|completed|loop complete/i.test(props.agentTestStatus);

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; gap: 12px; flex-wrap: wrap;">
        <div>
          <div class="card-title">Agent Testing</div>
          <div class="card-sub">Chat with one agent and inspect/edit related files in one place.</div>
        </div>
        <label class="field" style="min-width: 220px;">
          <span>Agent</span>
          <select
            .value=${selectedId ?? ""}
            @change=${(e: Event) => props.onSelectAgent((e.target as HTMLSelectElement).value)}
          >
            ${agents.map((a) => html`<option value=${a.id}>${a.name ?? a.id}</option>`)}
          </select>
        </label>
      </div>
    </section>

    ${
      !selectedAgent
        ? html`
            <section class="card" style="margin-top: 16px"><div class="muted">No agent selected.</div></section>
          `
        : html`
            <section class="grid grid-cols-2" style="margin-top: 16px;">
              <div class="card">
                <div class="row" style="justify-content: space-between;">
                  <div>
                    <div class="card-title">Files</div>
                    <div class="card-sub mono">${list?.workspace ?? "Load files to view workspace"}</div>
                  </div>
                  <button class="btn btn--sm" ?disabled=${props.agentFilesLoading} @click=${() => props.onLoadFiles(selectedAgent.id)}>
                    ${props.agentFilesLoading ? "Loading…" : "Refresh"}
                  </button>
                </div>
                ${
                  props.agentFilesError
                    ? html`<div class="callout danger" style="margin-top: 12px;">${props.agentFilesError}</div>`
                    : nothing
                }
                <div class="agent-files-grid" style="margin-top: 12px;">
                  <div class="agent-files-list">
                    ${
                      files.length === 0
                        ? html`
                            <div class="muted">No files loaded.</div>
                          `
                        : files.map((file) =>
                            renderAgentFileRow(file, active, () => props.onSelectFile(file.name)),
                          )
                    }
                  </div>
                  <div class="agent-files-editor">
                    ${
                      !activeEntry
                        ? html`
                            <div class="muted">Select a file to view/edit.</div>
                          `
                        : html`
                            <div class="agent-file-header">
                              <div>
                                <div class="agent-file-title mono">${activeEntry.name}</div>
                                <div class="agent-file-sub mono">${activeEntry.path}</div>
                              </div>
                              <div class="agent-file-actions">
                                <button class="btn btn--sm" ?disabled=${!isDirty} @click=${() => props.onFileReset(activeEntry.name)}>
                                  Reset
                                </button>
                                <button class="btn btn--sm primary" ?disabled=${props.agentFileSaving || !isDirty} @click=${() => props.onFileSave(activeEntry.name)}>
                                  ${props.agentFileSaving ? "Saving…" : "Save"}
                                </button>
                              </div>
                            </div>
                            <label class="field" style="margin-top: 10px;">
                              <span>Content</span>
                              <textarea
                                .value=${draft}
                                @input=${(e: Event) =>
                                  props.onFileDraftChange(
                                    activeEntry.name,
                                    (e.target as HTMLTextAreaElement).value,
                                  )}
                              ></textarea>
                            </label>
                          `
                    }
                  </div>
                </div>
              </div>

              <div class="card">
                <div class="card-title">Agent Chat + File Diffs</div>
                <div class="card-sub">Session: <span class="mono">agent:${selectedAgent.id}:testing</span></div>
                <div class="agent-test-active-agent" style="margin-top: 8px;">
                  <span class="agent-badge" title="All assistant replies in this panel come from this selected agent">
                    <span>${selectedAgentEmoji}</span>
                    <span class="mono">${selectedAgentName}</span>
                  </span>
                  ${
                    loopFinished
                      ? html`
                          <span class="agent-loop-state" title="Latest run has completed"> ✅ loop complete </span>
                        `
                      : nothing
                  }
                </div>
                <div class="row" style="margin-top: 10px; gap: 8px; flex-wrap: wrap;">
                  <button class="btn" ?disabled=${props.agentTestBusy} @click=${props.onResetAgentOnboarding}>
                    Reset Onboarding
                  </button>
                  <button class="btn" ?disabled=${props.agentTestBusy} @click=${props.onRefreshHistory}>
                    ${props.historyLoading ? "Refreshing…" : "Refresh Chat"}
                  </button>
                  <button class="btn" ?disabled=${props.agentTestBusy} @click=${props.onRefreshAgentFiles}>
                    Refresh Diffs
                  </button>
                  <button class="btn" ?disabled=${props.agentTestChanges.length === 0 || props.agentTestUndoBusy || props.agentTestBusy} @click=${props.onUndoAllAgentFileChanges}>
                    ${props.agentTestUndoBusy ? "Undoing…" : "Undo All"}
                  </button>
                </div>
                ${
                  props.agentTestRunId
                    ? html`<div class="muted mono" style="margin-top: 8px;">runId: ${props.agentTestRunId}</div>`
                    : nothing
                }
                ${
                  props.agentTestTotalDurationMs != null
                    ? html`<div class="muted mono" style="margin-top: 4px;">total: ${(props.agentTestTotalDurationMs / 1000).toFixed(2)}s</div>`
                    : nothing
                }
                ${props.agentTestStatus ? html`<div class="callout info" style="margin-top: 8px;">${props.agentTestStatus}</div>` : nothing}
                ${props.agentTestError ? html`<div class="callout danger" style="margin-top: 8px;">${props.agentTestError}</div>` : nothing}
                ${props.historyError ? html`<div class="callout danger" style="margin-top: 8px;">${props.historyError}</div>` : nothing}
                <div class="muted" style="margin-top: 12px;">Chat History</div>
                <div class="agent-test-chat-shell" style="margin-top: 8px;">
                  ${
                    props.history.length === 0
                      ? html`
                          <div class="muted">No chat messages yet.</div>
                        `
                      : html`
                          <div class="agent-test-history-scroll">
                            <div class="agent-test-history">
                              ${props.history.map(
                                (m) => html`
                                  <div class="agent-test-chat-line agent-test-chat-line--${m.role}">
                                    <div class="chat-msg">
                                      <div class="agent-test-chat-meta">
                                        <span>${
                                          m.role === "assistant"
                                            ? `${selectedAgentEmoji} ${selectedAgentName}`
                                            : "you"
                                        }</span>
                                        <span>·</span>
                                        <span>${m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : "n/a"}</span>
                                        ${
                                          formatLatencyMs(m.sincePrevMs)
                                            ? html`<span>·</span><span class="mono">+${formatLatencyMs(m.sincePrevMs)}</span>`
                                            : nothing
                                        }
                                        ${
                                          m.role === "assistant" && formatLatencyMs(m.latencyMs)
                                            ? html`<span>·</span><span class="mono">reply ${formatLatencyMs(m.latencyMs)}</span>`
                                            : nothing
                                        }
                                      </div>
                                      <div class="chat-bubble">
                                        <div class="agent-test-chat-text">${m.text}</div>
                                      </div>
                                    </div>
                                  </div>
                                `,
                              )}
                            </div>
                          </div>
                        `
                  }
                  <label class="field">
                    <span>Message</span>
                    <textarea
                      .value=${props.agentTestMessage}
                      rows="3"
                      @input=${(e: Event) =>
                        props.onAgentTestMessageChange((e.target as HTMLTextAreaElement).value)}
                    ></textarea>
                  </label>
                  <div class="row" style="gap: 10px; align-items: flex-end; flex-wrap: wrap;">
                    <label class="field" style="display:flex; align-items:center; gap:8px;">
                      <input
                        type="checkbox"
                        ?checked=${props.agentTestUseCloudModel}
                        @change=${(e: Event) =>
                          props.onAgentTestUseCloudModelChange(
                            (e.target as HTMLInputElement).checked,
                          )}
                      />
                      <span>Use cloud model</span>
                    </label>
                    <label class="field" style="min-width: 320px;">
                      <span>Cloud model ref</span>
                      <input
                        .value=${props.agentTestCloudModelRef}
                        ?disabled=${!props.agentTestUseCloudModel}
                        @input=${(e: Event) =>
                          props.onAgentTestCloudModelRefChange(
                            (e.target as HTMLInputElement).value,
                          )}
                        placeholder="openai-codex/gpt-5.3-codex-spark"
                      />
                    </label>
                  </div>
                  <div class="row" style="justify-content: flex-end;">
                    <button
                      class="btn primary"
                      ?disabled=${props.agentTestBusy || !props.agentTestMessage.trim()}
                      @click=${props.onRunAgentTest}
                    >
                      ${props.agentTestBusy ? "Running…" : "Send"}
                    </button>
                  </div>
                </div>
                <div class="muted" style="margin-top: 12px;">File Changes (${props.agentTestChanges.length})</div>
                ${
                  props.agentTestChanges.length === 0
                    ? html`
                        <div class="muted" style="margin-top: 8px">No file diffs against baseline.</div>
                      `
                    : html`
                        <div class="list" style="margin-top: 8px;">
                          ${props.agentTestChanges.map((change) => {
                            const baseline = props.agentTestBaselineFiles[change.name];
                            const current = props.agentTestCurrentFiles[change.name];
                            return html`
                              <div class="list-item">
                                <div class="list-main">
                                  <div class="row" style="gap: 8px; align-items: center; justify-content: space-between;">
                                    <div class="list-title mono">${change.name}</div>
                                    <span class="chip ${change.status === "deleted" ? "chip-danger" : change.status === "created" ? "chip-ok" : "chip-warn"}">${change.status}</span>
                                  </div>
                                  <div class="list-sub">${change.beforeLines} → ${change.afterLines} lines</div>
                                  <div style="margin-top: 6px;">
                                    <button
                                      class="btn btn--sm primary"
                                      ?disabled=${props.agentTestUndoBusy || props.agentTestBusy}
                                      @click=${() => props.onUndoAgentFileChange(change.name)}
                                    >
                                      Undo Change
                                    </button>
                                  </div>
                                </div>
                                <div style="max-width: 62%;">
                                  ${renderLineDiff(baseline?.content ?? "", current?.content ?? "")}
                                </div>
                              </div>
                            `;
                          })}
                        </div>
                      `
                }
              </div>
            </section>
          `
    }
  `;
}
