import { html, nothing } from "lit";
import type { EventLogEntry } from "../app-events.ts";
import type { DebugAgentFileChange } from "../controllers/debug.ts";
import type { AgentsListResult } from "../types.ts";
import { formatEventPayload } from "../presenter.ts";

export type DebugProps = {
  loading: boolean;
  status: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  models: unknown[];
  heartbeat: unknown;
  agentsList: AgentsListResult | null;
  eventLog: EventLogEntry[];
  callMethod: string;
  callParams: string;
  callResult: string | null;
  callError: string | null;
  onCallMethodChange: (next: string) => void;
  onCallParamsChange: (next: string) => void;
  onRefresh: () => void;
  onCall: () => void;
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
  onPiConfigAgentChange: (agentId: string | null) => void;
  onLoadPiConfig: () => void;
  onPiConfigSandboxPreviewChange: (v: boolean) => void;
  onPiConfigTestMemoryPathChange: (v: string) => void;
  agentTestAgentId: string | null;
  agentTestMessage: string;
  agentTestBusy: boolean;
  agentTestRunId: string | null;
  agentTestUseCloudModel: boolean;
  agentTestCloudModelRef: string;
  agentTestStatus: string | null;
  agentTestError: string | null;
  agentTestReply: string | null;
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
  onAgentTestAgentChange: (agentId: string | null) => void;
  onAgentTestMessageChange: (v: string) => void;
  onAgentTestUseCloudModelChange: (v: boolean) => void;
  onAgentTestCloudModelRefChange: (v: string) => void;
  onRunAgentTest: () => void;
  onRefreshAgentFiles: () => void;
  onUndoAgentFileChange: (name: string) => void;
  onUndoAllAgentFileChanges: () => void;
};

export function renderDebug(props: DebugProps) {
  const securityAudit =
    props.status && typeof props.status === "object"
      ? (props.status as { securityAudit?: { summary?: Record<string, number> } }).securityAudit
      : null;
  const securitySummary = securityAudit?.summary ?? null;
  const critical = securitySummary?.critical ?? 0;
  const warn = securitySummary?.warn ?? 0;
  const info = securitySummary?.info ?? 0;
  const securityTone = critical > 0 ? "danger" : warn > 0 ? "warn" : "success";
  const securityLabel =
    critical > 0 ? `${critical} critical` : warn > 0 ? `${warn} warnings` : "No critical issues";

  return html`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="card-title">Snapshots</div>
            <div class="card-sub">Status, health, and heartbeat data.</div>
          </div>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <div class="stack" style="margin-top: 12px;">
          <div>
            <div class="muted">Status</div>
            ${
              securitySummary
                ? html`<div class="callout ${securityTone}" style="margin-top: 8px;">
                  Security audit: ${securityLabel}${info > 0 ? ` · ${info} info` : ""}. Run
                  <span class="mono">openclaw security audit --deep</span> for details.
                </div>`
                : nothing
            }
            <div class="code-block-wrap"><pre class="code-block">${JSON.stringify(props.status ?? {}, null, 2)}</pre></div>
          </div>
          <div>
            <div class="muted">Health</div>
            <div class="code-block-wrap"><pre class="code-block">${JSON.stringify(props.health ?? {}, null, 2)}</pre></div>
          </div>
          <div>
            <div class="muted">Last heartbeat</div>
            <div class="code-block-wrap"><pre class="code-block">${JSON.stringify(props.heartbeat ?? {}, null, 2)}</pre></div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Manual RPC</div>
        <div class="card-sub">Send a raw gateway method with JSON params.</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>Method</span>
            <input
              .value=${props.callMethod}
              @input=${(e: Event) => props.onCallMethodChange((e.target as HTMLInputElement).value)}
              placeholder="system-presence"
            />
          </label>
          <label class="field">
            <span>Params (JSON)</span>
            <textarea
              .value=${props.callParams}
              @input=${(e: Event) =>
                props.onCallParamsChange((e.target as HTMLTextAreaElement).value)}
              rows="6"
            ></textarea>
          </label>
        </div>
        <div class="row" style="margin-top: 12px;">
          <button class="btn primary" @click=${props.onCall}>Call</button>
        </div>
        ${
          props.callError
            ? html`<div class="callout danger" style="margin-top: 12px;">
              ${props.callError}
            </div>`
            : nothing
        }
        ${
          props.callResult
            ? html`<div class="code-block-wrap" style="margin-top: 12px;"><pre class="code-block">${props.callResult}</pre></div>`
            : nothing
        }
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Agent PI Config</div>
      <div class="card-sub">Full resolved Pi config for an agent (bootstrapFiles, promptMode, toolsAllow, etc.).</div>
      <div class="row" style="gap: 12px; margin-top: 12px; flex-wrap: wrap;">
        <label class="field" style="min-width: 180px;">
          <span>Agent</span>
          <select
            .value=${props.piConfigAgentId ?? ""}
            ?disabled=${props.loading || !props.agentsList}
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              props.onPiConfigAgentChange(v ? v : null);
            }}
          >
            <option value="">Select agent</option>
            ${(props.agentsList?.agents ?? []).map(
              (a) => html`<option value=${a.id}>${a.name ?? a.id}</option>`,
            )}
          </select>
        </label>
        <label class="field" style="display: flex; align-items: center; gap: 8px;">
          <input
            type="checkbox"
            ?checked=${props.piConfigSandboxPreview}
            @change=${(e: Event) =>
              props.onPiConfigSandboxPreviewChange((e.target as HTMLInputElement).checked)}
          />
          <span>Sandbox preview</span>
        </label>
        <label class="field" style="min-width: 200px;">
          <span>Test memory path</span>
          <input
            type="text"
            .value=${props.piConfigTestMemoryPath}
            @input=${(e: Event) =>
              props.onPiConfigTestMemoryPathChange((e.target as HTMLInputElement).value)}
            placeholder="Optional path to test workspace"
          />
        </label>
        <div style="display: flex; align-items: flex-end;">
          <button
            class="btn btn--sm"
            ?disabled=${!props.piConfigAgentId || props.piConfigLoading}
            @click=${props.onLoadPiConfig}
          >
            ${props.piConfigLoading ? "Loading…" : "Load Full Config"}
          </button>
        </div>
      </div>
      ${
        props.piConfigResult
          ? html`
              <div style="margin-top: 12px;">
                ${
                  props.piConfigResult.sandboxPreview
                    ? html`
                        <div class="callout info" style="margin-bottom: 12px;">
                          Sandbox preview: mode=${props.piConfigResult.sandboxPreview.mode}
                          workspaceAccess=${props.piConfigResult.sandboxPreview.workspaceAccess}
                          sandboxed=${props.piConfigResult.sandboxPreview.sandboxed}. When
                          workspaceAccess is "ro", memory changes are not persisted.
                        </div>
                      `
                    : nothing
                }
                ${
                  props.piConfigResult.testMemoryPath
                    ? html`
                        <div class="muted" style="margin-bottom: 4px;">
                          Test memory path: ${props.piConfigResult.testMemoryPath}
                        </div>
                      `
                    : nothing
                }
                <div class="muted">Resolved (full)</div>
                <div class="code-block-wrap" style="margin-top: 8px;"><pre class="code-block">${JSON.stringify(
                  props.piConfigResult.resolvedPiConfig,
                  null,
                  2,
                )}</pre></div>
                ${
                  props.piConfigResult.piConfig != null
                    ? html`
                        <div class="muted" style="margin-top: 12px;">Raw (from config/registry)</div>
                        <div class="code-block-wrap" style="margin-top: 8px;"><pre class="code-block">${JSON.stringify(
                          props.piConfigResult.piConfig,
                          null,
                          2,
                        )}</pre></div>
                      `
                    : nothing
                }
              </div>
            `
          : nothing
      }
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Agent Test Bench</div>
      <div class="card-sub">Run a prompt against one agent session, inspect file mutations, and undo them.</div>
      <div class="row" style="gap: 12px; margin-top: 12px; flex-wrap: wrap;">
        <label class="field" style="min-width: 200px;">
          <span>Agent</span>
          <select
            .value=${props.agentTestAgentId ?? ""}
            ?disabled=${props.agentTestBusy || !props.agentsList}
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              props.onAgentTestAgentChange(v ? v : null);
            }}
          >
            <option value="">Select agent</option>
            ${(props.agentsList?.agents ?? []).map(
              (a) => html`<option value=${a.id}>${a.name ?? a.id}</option>`,
            )}
          </select>
        </label>
      </div>
      <label class="field" style="margin-top: 12px;">
        <span>Prompt</span>
        <textarea
          .value=${props.agentTestMessage}
          rows="4"
          @input=${(e: Event) =>
            props.onAgentTestMessageChange((e.target as HTMLTextAreaElement).value)}
          placeholder="e.g. log bench press 3x10 at 135"
        ></textarea>
      </label>
      <div class="row" style="margin-top: 10px; gap: 12px; align-items: flex-end; flex-wrap: wrap;">
        <label class="field" style="display: flex; align-items: center; gap: 8px;">
          <input
            type="checkbox"
            ?checked=${props.agentTestUseCloudModel}
            @change=${(e: Event) =>
              props.onAgentTestUseCloudModelChange((e.target as HTMLInputElement).checked)}
          />
          <span>Use cloud model</span>
        </label>
        <label class="field" style="min-width: 320px;">
          <span>Cloud model ref</span>
          <input
            .value=${props.agentTestCloudModelRef}
            ?disabled=${!props.agentTestUseCloudModel}
            @input=${(e: Event) =>
              props.onAgentTestCloudModelRefChange((e.target as HTMLInputElement).value)}
            placeholder="openai-codex/gpt-5.3-codex-spark"
          />
        </label>
      </div>
      <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
        <button
          class="btn primary"
          ?disabled=${!props.agentTestAgentId || !props.agentTestMessage.trim() || props.agentTestBusy}
          @click=${props.onRunAgentTest}
        >
          ${props.agentTestBusy ? "Running…" : "Run Agent Test"}
        </button>
        <button class="btn" ?disabled=${!props.agentTestAgentId || props.agentTestBusy} @click=${props.onRefreshAgentFiles}>
          Refresh Files
        </button>
        <button
          class="btn"
          ?disabled=${props.agentTestChanges.length === 0 || props.agentTestUndoBusy || props.agentTestBusy}
          @click=${props.onUndoAllAgentFileChanges}
        >
          ${props.agentTestUndoBusy ? "Undoing…" : "Undo All"}
        </button>
      </div>
      ${
        props.agentTestRunId
          ? html`<div class="muted mono" style="margin-top: 10px;">runId: ${props.agentTestRunId}</div>`
          : nothing
      }
      ${
        props.agentTestStatus
          ? html`<div class="callout info" style="margin-top: 10px;">${props.agentTestStatus}</div>`
          : nothing
      }
      ${
        props.agentTestError
          ? html`<div class="callout danger" style="margin-top: 10px;">${props.agentTestError}</div>`
          : nothing
      }
      ${
        props.agentTestReply
          ? html`
              <div class="muted" style="margin-top: 12px;">Latest assistant reply</div>
              <div class="code-block-wrap" style="margin-top: 8px;"><pre class="code-block">${props.agentTestReply}</pre></div>
            `
          : nothing
      }
      <div style="margin-top: 14px;">
        <div class="muted">Detected file changes (${props.agentTestChanges.length})</div>
        ${
          props.agentTestChanges.length === 0
            ? html`
                <div class="muted" style="margin-top: 8px">No differences detected against baseline.</div>
              `
            : html`
                <div class="list" style="margin-top: 10px;">
                  ${props.agentTestChanges.map((change) => {
                    const baseline = props.agentTestBaselineFiles[change.name];
                    const current = props.agentTestCurrentFiles[change.name];
                    const beforeText = baseline?.content ?? "";
                    const afterText = current?.content ?? "";
                    return html`
                      <div class="list-item" style="align-items: flex-start;">
                        <div class="list-main" style="min-width: 240px;">
                          <div class="list-title mono">${change.name}</div>
                          <div class="list-sub mono">${change.path}</div>
                          <div class="list-sub">${change.status} · ${change.beforeLines} → ${change.afterLines} lines</div>
                          <div style="margin-top: 8px;">
                            <button
                              class="btn btn--sm"
                              ?disabled=${props.agentTestUndoBusy || props.agentTestBusy}
                              @click=${() => props.onUndoAgentFileChange(change.name)}
                            >
                              Undo
                            </button>
                          </div>
                        </div>
                        <div class="list-meta" style="flex: 1; min-width: 300px;">
                          <div class="row" style="gap: 12px; align-items: flex-start; flex-wrap: wrap;">
                            <div style="flex: 1; min-width: 220px;">
                              <div class="muted">Before</div>
                              <div class="code-block-wrap"><pre class="code-block">${beforeText}</pre></div>
                            </div>
                            <div style="flex: 1; min-width: 220px;">
                              <div class="muted">After</div>
                              <div class="code-block-wrap"><pre class="code-block">${afterText}</pre></div>
                            </div>
                          </div>
                        </div>
                      </div>
                    `;
                  })}
                </div>
              `
        }
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Models</div>
      <div class="card-sub">Catalog from models.list.</div>
      <div class="code-block-wrap" style="margin-top: 12px;"><pre class="code-block">${JSON.stringify(
        props.models ?? [],
        null,
        2,
      )}</pre></div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">Event Log</div>
      <div class="card-sub">Latest gateway events.</div>
      ${
        props.eventLog.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">No events yet.</div>
            `
          : html`
            <div class="list" style="margin-top: 12px;">
              ${props.eventLog.map(
                (evt) => html`
                  <div class="list-item">
                    <div class="list-main">
                      <div class="list-title">${evt.event}</div>
                      <div class="list-sub">${new Date(evt.ts).toLocaleTimeString()}</div>
                    </div>
                    <div class="list-meta">
                      <div class="code-block-wrap"><pre class="code-block">${formatEventPayload(evt.payload)}</pre></div>
                    </div>
                  </div>
                `,
              )}
            </div>
          `
      }
    </section>
  `;
}
