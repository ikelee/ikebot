import { html } from "lit";
import type { TestSuiteEntry, TestSuiteRunEvent, TestSuiteRunResult } from "../types.ts";

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) {
    return "0";
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return String(Math.round(n));
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0ms";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatSigned(delta: number, kind: "tokens" | "latency"): string {
  if (!Number.isFinite(delta) || delta === 0) {
    return "±0";
  }
  const sign = delta > 0 ? "+" : "-";
  const abs = Math.abs(delta);
  if (kind === "tokens") {
    return `${sign}${formatTokens(abs)}`;
  }
  return `${sign}${formatMs(abs)}`;
}

function levelChip(level: TestSuiteEntry["level"]): string {
  switch (level) {
    case "unit":
      return "Unit";
    case "agent":
      return "Agent";
    case "e2e":
      return "Full E2E";
    default:
      return level;
  }
}

function runStatusChip(run: TestSuiteRunResult | null): string {
  if (!run) {
    return "Never run";
  }
  return run.status.toUpperCase();
}

function formatRunScope(run: TestSuiteRunResult | null): string {
  if (!run) {
    return "—";
  }
  const files = run.requestedFiles ?? [];
  if (files.length > 0) {
    return `${files.length} file${files.length > 1 ? "s" : ""}`;
  }
  return "full suite";
}

function eventTone(level: TestSuiteRunEvent["level"]): string {
  if (level === "ok") {
    return "var(--success)";
  }
  if (level === "error") {
    return "var(--danger)";
  }
  return "var(--text-muted)";
}

export function renderTestSuites(props: {
  loading: boolean;
  error: string | null;
  suites: TestSuiteEntry[];
  busySuiteId: string | null;
  activeRunId: string | null;
  activeRun: TestSuiteRunResult | null;
  runHistory: TestSuiteRunResult[];
  selectedRunId: string | null;
  runEvents: TestSuiteRunEvent[];
  fileQueryBySuite: Record<string, string>;
  filesBySuite: Record<string, string[]>;
  filesLoadingBySuite: Record<string, boolean>;
  selectedFilesBySuite: Record<string, string[]>;
  singleFileBySuite: Record<string, string>;
  testNameBySuite: Record<string, string>;
  status: string | null;
  onRefresh: () => void;
  onSelectRun: (runId: string) => void;
  onFileQueryChange: (suiteId: string, value: string) => void;
  onDiscoverFiles: (suiteId: string) => void;
  onToggleFileSelection: (suiteId: string, file: string, enabled: boolean) => void;
  onSingleFileChange: (suiteId: string, value: string) => void;
  onTestNameChange: (suiteId: string, value: string) => void;
  onRunSuite: (suiteId: string) => void;
}) {
  const selectedRun =
    props.runHistory.find((entry) => entry.runId === props.selectedRunId) ?? props.activeRun;

  return html`
    <div class="card" style="display: grid; gap: 12px;">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <div>
          <div class="card-title">Test Suites</div>
          <div class="muted" style="font-size: 12px;">
            Select exact tests, run one specific test, and watch a live run dashboard populate while execution is in progress.
          </div>
        </div>
        <button class="secondary" @click=${props.onRefresh} ?disabled=${props.loading}>Refresh</button>
      </div>

      <div class="muted" style="font-size: 12px; line-height: 1.5;">
        Session model: each session is one persisted conversation key (chat, agent test, cron, or test-run session), not one app launch.
      </div>

      ${props.error ? html`<div class="alert error">${props.error}</div>` : null}
      ${props.status ? html`<div class="alert info">${props.status}</div>` : null}

      <div class="card" style="background: var(--panel); border: 1px solid var(--border);">
        <div class="card-title" style="margin-bottom: 8px;">Run Dashboard</div>
        ${
          selectedRun
            ? html`
                <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px;">
                  <div class="metric-card">
                    <div class="muted" style="font-size: 11px;">Run</div>
                    <div class="metric-value">${selectedRun.runId.slice(0, 8)}</div>
                    <div class="muted" style="font-size: 11px;">${selectedRun.status.toUpperCase()}</div>
                  </div>
                  <div class="metric-card">
                    <div class="muted" style="font-size: 11px;">Duration</div>
                    <div class="metric-value">${formatMs(selectedRun.durationMs ?? 0)}</div>
                    <div class="muted" style="font-size: 11px;">scope ${formatRunScope(selectedRun)}</div>
                  </div>
                  <div class="metric-card">
                    <div class="muted" style="font-size: 11px;">Tokens</div>
                    <div class="metric-value">${formatTokens(selectedRun.metrics?.totalTokens ?? 0)}</div>
                    <div class="muted" style="font-size: 11px;">L ${formatTokens(selectedRun.metrics?.localTokens ?? 0)} · C ${formatTokens(selectedRun.metrics?.cloudTokens ?? 0)}</div>
                  </div>
                  <div class="metric-card">
                    <div class="muted" style="font-size: 11px;">Model Calls</div>
                    <div class="metric-value">${formatTokens(selectedRun.metrics?.totalInvocations ?? 0)}</div>
                    <div class="muted" style="font-size: 11px;">avg ${formatMs(selectedRun.metrics?.avgLatencyMs ?? 0)}</div>
                  </div>
                </div>
                <div class="mono muted" style="margin-top: 8px; font-size: 11px;">${selectedRun.command.join(" ")}</div>
                ${
                  selectedRun.requestedFiles && selectedRun.requestedFiles.length > 0
                    ? html`
                        <div class="muted" style="margin-top: 8px; font-size: 12px;">
                          Files: ${selectedRun.requestedFiles.slice(0, 5).join(", ")}${
                            selectedRun.requestedFiles.length > 5
                              ? ` (+${selectedRun.requestedFiles.length - 5} more)`
                              : ""
                          }
                        </div>
                      `
                    : null
                }
              `
            : html`
                <div class="muted">No run selected yet. Start a suite below.</div>
              `
        }

        <div style="margin-top: 10px; max-height: 180px; overflow: auto; border-top: 1px solid var(--border); padding-top: 8px;">
          ${
            props.runEvents.length === 0
              ? html`
                  <div class="muted">Run activity events will appear here.</div>
                `
              : props.runEvents
                  .toReversed()
                  .slice(0, 30)
                  .map(
                    (event) => html`
                    <div style="display: grid; grid-template-columns: auto auto 1fr; gap: 8px; align-items: center; padding: 3px 0;">
                      <span class="mono muted" style="font-size: 11px;">${new Date(event.ts).toLocaleTimeString()}</span>
                      <span class="mono" style="font-size: 11px; color: ${eventTone(event.level)};">${event.level}</span>
                      <span style="font-size: 12px;">${event.message}</span>
                    </div>
                  `,
                  )
          }
        </div>

        ${
          props.runHistory.length > 0
            ? html`
              <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px;">
                ${props.runHistory.slice(0, 12).map((run) => {
                  const selected = props.selectedRunId === run.runId;
                  return html`
                    <button
                      class="chip"
                      style="cursor: pointer; ${selected ? "border-color: var(--accent);" : ""}"
                      @click=${() => props.onSelectRun(run.runId)}
                    >
                      ${run.runId.slice(0, 8)} · ${run.status.toUpperCase()}
                    </button>
                  `;
                })}
              </div>
            `
            : null
        }
      </div>

      <div style="display: grid; gap: 10px;">
        ${props.suites.map((suite) => {
          const run = suite.lastRun;
          const prev = suite.previousRun;
          const metrics = run?.metrics;
          const prevMetrics = prev?.metrics;
          const tokenDelta =
            metrics && prevMetrics ? metrics.totalTokens - prevMetrics.totalTokens : 0;
          const latencyDelta =
            metrics && prevMetrics ? metrics.avgLatencyMs - prevMetrics.avgLatencyMs : 0;
          const isBusy = props.busySuiteId === suite.id;
          const query = props.fileQueryBySuite[suite.id] ?? "";
          const files = props.filesBySuite[suite.id] ?? [];
          const filesLoading = Boolean(props.filesLoadingBySuite[suite.id]);
          const selectedFiles = props.selectedFilesBySuite[suite.id] ?? [];
          const singleFile = props.singleFileBySuite[suite.id] ?? "";
          const testName = props.testNameBySuite[suite.id] ?? "";

          return html`
            <div class="card" style="background: var(--panel); border: 1px solid var(--border);">
              <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;">
                <div style="display: grid; gap: 6px;">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <strong>${suite.name}</strong>
                    <span class="chip">${levelChip(suite.level)}</span>
                    <span class="chip">${runStatusChip(run)}</span>
                  </div>
                  <div class="muted" style="font-size: 12px;">${suite.description}</div>
                  <div class="mono muted" style="font-size: 11px;">${suite.command}</div>
                </div>
                <div style="display: grid; gap: 6px; justify-items: end;">
                  <button
                    class="primary"
                    @click=${() => props.onRunSuite(suite.id)}
                    ?disabled=${Boolean(props.busySuiteId) || props.loading}
                  >
                    ${isBusy ? "Running..." : "Run"}
                  </button>
                  <div class="muted" style="font-size: 11px;">
                    ${
                      singleFile.trim()
                        ? "scope: single file"
                        : selectedFiles.length > 0
                          ? `scope: ${selectedFiles.length} selected`
                          : "scope: full suite"
                    }
                  </div>
                </div>
              </div>

              <div style="display: grid; gap: 8px; margin-top: 10px;">
                <div style="display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center;">
                  <input
                    class="input"
                    placeholder="Search tests (e.g. calendar)"
                    .value=${query}
                    @input=${(e: Event) =>
                      props.onFileQueryChange(suite.id, (e.target as HTMLInputElement).value)}
                  />
                  <button class="secondary" @click=${() => props.onDiscoverFiles(suite.id)} ?disabled=${filesLoading}>
                    ${filesLoading ? "Finding..." : "Find tests"}
                  </button>
                  <span class="muted" style="font-size: 11px;">${files.length} found</span>
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                  <input
                    class="input mono"
                    placeholder="Run one specific test file (optional)"
                    .value=${singleFile}
                    @input=${(e: Event) =>
                      props.onSingleFileChange(suite.id, (e.target as HTMLInputElement).value)}
                  />
                  <input
                    class="input"
                    placeholder="Optional test name filter (-t)"
                    .value=${testName}
                    @input=${(e: Event) =>
                      props.onTestNameChange(suite.id, (e.target as HTMLInputElement).value)}
                  />
                </div>

                <div style="max-height: 180px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: var(--bg);">
                  ${
                    files.length === 0
                      ? html`
                          <div class="muted" style="font-size: 12px">No files loaded. Use Find tests.</div>
                        `
                      : files.map((file) => {
                          const checked = selectedFiles.includes(file);
                          return html`
                          <label style="display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: center; padding: 2px 0;">
                            <input
                              type="checkbox"
                              .checked=${checked}
                              @change=${(e: Event) =>
                                props.onToggleFileSelection(
                                  suite.id,
                                  file,
                                  (e.target as HTMLInputElement).checked,
                                )}
                            />
                            <span class="mono" style="font-size: 11px;">${file}</span>
                          </label>
                        `;
                        })
                  }
                </div>
              </div>

              <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 10px;">
                <div class="metric-card">
                  <div class="muted" style="font-size: 11px;">Duration</div>
                  <div class="metric-value">${formatMs(run?.durationMs ?? 0)}</div>
                  <div class="muted" style="font-size: 11px;">prev ${formatMs(prev?.durationMs ?? 0)}</div>
                </div>
                <div class="metric-card">
                  <div class="muted" style="font-size: 11px;">Tokens</div>
                  <div class="metric-value">${formatTokens(metrics?.totalTokens ?? 0)}</div>
                  <div class="muted" style="font-size: 11px;">${formatSigned(tokenDelta, "tokens")}</div>
                </div>
                <div class="metric-card">
                  <div class="muted" style="font-size: 11px;">Model Calls</div>
                  <div class="metric-value">${formatTokens(metrics?.totalInvocations ?? 0)}</div>
                  <div class="muted" style="font-size: 11px;">L ${formatTokens(metrics?.localInvocations ?? 0)} · C ${formatTokens(metrics?.cloudInvocations ?? 0)}</div>
                </div>
                <div class="metric-card">
                  <div class="muted" style="font-size: 11px;">Avg Latency</div>
                  <div class="metric-value">${formatMs(metrics?.avgLatencyMs ?? 0)}</div>
                  <div class="muted" style="font-size: 11px;">${formatSigned(latencyDelta, "latency")}</div>
                </div>
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}
