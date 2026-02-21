import { html } from "lit";
import type { SessionsUsageResult } from "../types.ts";

export type MonitorProps = {
  loading: boolean;
  error: string | null;
  days: string;
  result: SessionsUsageResult | null;
  onDaysChange: (v: string) => void;
  onRefresh: () => void;
};

type ProviderBucket = {
  invocations: number;
  input: number;
  output: number;
  total: number;
  latencyCount: number;
  latencyWeightedMs: number;
};

function isLocalProvider(provider: string | undefined): boolean {
  const p = (provider ?? "").trim().toLowerCase();
  return p === "ollama" || p === "lmstudio" || p === "claude-cli" || p === "codex-cli";
}

function formatInt(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString() : "0";
}

function formatMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "n/a";
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  return `${(value / 1000).toFixed(2)}s`;
}

function summarize(result: SessionsUsageResult | null) {
  const empty: ProviderBucket = {
    invocations: 0,
    input: 0,
    output: 0,
    total: 0,
    latencyCount: 0,
    latencyWeightedMs: 0,
  };
  if (!result) {
    return {
      userInputs: 0,
      local: { ...empty },
      cloud: { ...empty },
      totalInvocations: 0,
      totalTokens: 0,
      avgLatencyMs: 0,
    };
  }
  const local: ProviderBucket = { ...empty };
  const cloud: ProviderBucket = { ...empty };
  for (const byProvider of result.aggregates.byProvider ?? []) {
    const target = isLocalProvider(byProvider.provider) ? local : cloud;
    target.invocations += byProvider.count ?? 0;
    target.input += byProvider.totals.input ?? 0;
    target.output += byProvider.totals.output ?? 0;
    target.total += byProvider.totals.totalTokens ?? 0;
  }
  for (const session of result.sessions ?? []) {
    if (!session.usage?.latency || !session.modelProvider) {
      continue;
    }
    const bucket = isLocalProvider(session.modelProvider) ? local : cloud;
    const count = session.usage.latency.count ?? 0;
    const avgMs = session.usage.latency.avgMs ?? 0;
    if (count <= 0 || avgMs <= 0) {
      continue;
    }
    bucket.latencyCount += count;
    bucket.latencyWeightedMs += avgMs * count;
  }
  const totalInvocations = local.invocations + cloud.invocations;
  const totalTokens = result.totals.totalTokens ?? 0;
  const avgLatencyMs = result.aggregates.latency?.avgMs ?? 0;
  return {
    userInputs: result.aggregates.messages.user ?? 0,
    local,
    cloud,
    totalInvocations,
    totalTokens,
    avgLatencyMs,
  };
}

function bucketLatencyMs(bucket: ProviderBucket): number {
  if (bucket.latencyCount <= 0) {
    return 0;
  }
  return bucket.latencyWeightedMs / bucket.latencyCount;
}

export function renderMonitor(props: MonitorProps) {
  const summary = summarize(props.result);
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; gap: 12px; flex-wrap: wrap;">
        <div>
          <div class="card-title">Monitoring</div>
          <div class="card-sub">Model calls, latency, and token usage.</div>
        </div>
        <div class="row" style="gap: 8px;">
          <label class="field" style="min-width: 120px;">
            <span>Range (days)</span>
            <input
              type="number"
              min="1"
              max="365"
              .value=${props.days}
              @input=${(e: Event) => props.onDaysChange((e.target as HTMLInputElement).value)}
            />
          </label>
          <div style="display:flex; align-items:flex-end;">
            <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
              ${props.loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
      </div>
      ${props.error ? html`<div class="callout danger" style="margin-top: 10px;">${props.error}</div>` : ""}
    </section>

    <section class="grid grid-cols-2" style="margin-top: 16px;">
      <div class="card">
        <div class="card-title">Traffic</div>
        <div class="list" style="margin-top: 10px;">
          <div class="list-item"><div class="list-main">User inputs</div><div class="list-meta mono">${formatInt(summary.userInputs)}</div></div>
          <div class="list-item"><div class="list-main">Model invocations (total)</div><div class="list-meta mono">${formatInt(summary.totalInvocations)}</div></div>
          <div class="list-item"><div class="list-main">Local invocations</div><div class="list-meta mono">${formatInt(summary.local.invocations)}</div></div>
          <div class="list-item"><div class="list-main">Cloud invocations</div><div class="list-meta mono">${formatInt(summary.cloud.invocations)}</div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Latency</div>
        <div class="list" style="margin-top: 10px;">
          <div class="list-item"><div class="list-main">Average (overall)</div><div class="list-meta mono">${formatMs(summary.avgLatencyMs)}</div></div>
          <div class="list-item"><div class="list-main">Average (local)</div><div class="list-meta mono">${formatMs(bucketLatencyMs(summary.local))}</div></div>
          <div class="list-item"><div class="list-main">Average (cloud)</div><div class="list-meta mono">${formatMs(bucketLatencyMs(summary.cloud))}</div></div>
        </div>
      </div>
    </section>

    <section class="grid grid-cols-2" style="margin-top: 16px;">
      <div class="card">
        <div class="card-title">Tokens</div>
        <div class="list" style="margin-top: 10px;">
          <div class="list-item"><div class="list-main">Total tokens</div><div class="list-meta mono">${formatInt(summary.totalTokens)}</div></div>
          <div class="list-item"><div class="list-main">Local tokens</div><div class="list-meta mono">${formatInt(summary.local.total)}</div></div>
          <div class="list-item"><div class="list-main">Cloud tokens</div><div class="list-meta mono">${formatInt(summary.cloud.total)}</div></div>
          <div class="list-item"><div class="list-main">Local in/out</div><div class="list-meta mono">${formatInt(summary.local.input)} / ${formatInt(summary.local.output)}</div></div>
          <div class="list-item"><div class="list-main">Cloud in/out</div><div class="list-meta mono">${formatInt(summary.cloud.input)} / ${formatInt(summary.cloud.output)}</div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Reserved</div>
        <div class="card-sub">Space for additional metrics (errors, tool loops, success rates, retries).</div>
      </div>
    </section>
  `;
}
