import { html } from "lit";
import type { TestSuiteEntry } from "../types.ts";

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

export function renderTestSuites(props: {
  loading: boolean;
  error: string | null;
  suites: TestSuiteEntry[];
  busySuiteId: string | null;
  activeRunId: string | null;
  status: string | null;
  onRefresh: () => void;
  onRunSuite: (suiteId: string) => void;
}) {
  return html`
    <div class="card" style="display: grid; gap: 12px;">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <div>
          <div class="card-title">Test Suites</div>
          <div class="muted" style="font-size: 12px;">
            Run predefined suites and track usage, invocations, and latency by suite.
          </div>
        </div>
        <button class="secondary" @click=${props.onRefresh} ?disabled=${props.loading}>Refresh</button>
      </div>

      <div class="muted" style="font-size: 12px; line-height: 1.5;">
        Session model: each session is one persisted conversation key (chat, agent test, cron, or test-run session), not one app launch.
      </div>

      ${props.error ? html`<div class="alert error">${props.error}</div>` : null}
      ${props.status ? html`<div class="alert info">${props.status}</div>` : null}

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
          const runStatus = run?.status ? run.status.toUpperCase() : "Never run";

          return html`
            <div class="card" style="background: var(--panel); border: 1px solid var(--border);">
              <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;">
                <div style="display: grid; gap: 6px;">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <strong>${suite.name}</strong>
                    <span class="chip">${levelChip(suite.level)}</span>
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
                    ${isBusy ? "Running..." : "Run this suite"}
                  </button>
                  <span class="chip">${runStatus}</span>
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

              <div style="margin-top: 8px;" class="muted">
                User inputs ${formatTokens(metrics?.userInputs ?? 0)} · Tokens L ${formatTokens(metrics?.localTokens ?? 0)} / C ${formatTokens(metrics?.cloudTokens ?? 0)}
                ${run?.runId ? html` · run ${run.runId}${props.activeRunId === run.runId ? " (active)" : ""}` : null}
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}
