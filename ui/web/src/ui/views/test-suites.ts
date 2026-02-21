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

function modelExecutionScope(
  metrics: {
    localInvocations?: number;
    cloudInvocations?: number;
    totalInvocations?: number;
  } | null,
): "local-only" | "cloud-integrated" | "none" {
  const local = metrics?.localInvocations ?? 0;
  const cloud = metrics?.cloudInvocations ?? 0;
  const total = metrics?.totalInvocations ?? local + cloud;
  if (total <= 0 && local <= 0 && cloud <= 0) {
    return "none";
  }
  if (local > 0 && cloud <= 0) {
    return "local-only";
  }
  return "cloud-integrated";
}

function modelExecutionLabel(
  metrics: {
    localInvocations?: number;
    cloudInvocations?: number;
    totalInvocations?: number;
  } | null,
): string {
  const scope = modelExecutionScope(metrics);
  if (scope === "local-only") {
    return "Local only";
  }
  if (scope === "cloud-integrated") {
    return "Cloud integrated";
  }
  return "No model calls yet";
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

type ParsedModelCall = {
  id: string;
  model: string;
  reqNum?: number;
  startedAtLine: number;
  durationMs?: number;
  waitMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  done: boolean;
  source: "req";
};

function stripAnsiAndControl(input: string): string {
  if (!input) {
    return "";
  }
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input.charCodeAt(i);
    if (ch === 27) {
      const next = input.charCodeAt(i + 1);
      if (next === 91) {
        i += 2;
        while (i < input.length) {
          const code = input.charCodeAt(i);
          if (code >= 64 && code <= 126) {
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }
      if (next === 93) {
        i += 2;
        while (i < input.length) {
          const code = input.charCodeAt(i);
          if (code === 7) {
            i += 1;
            break;
          }
          if (code === 27 && input.charCodeAt(i + 1) === 92) {
            i += 2;
            break;
          }
          i += 1;
        }
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === 13 && input.charCodeAt(i + 1) !== 10) {
      out += "\n";
      i += 1;
      continue;
    }
    out += input[i];
    i += 1;
  }
  return out;
}

function parseModelCalls(output: string): ParsedModelCall[] {
  const lines = output.split(/\r?\n/);
  const calls: ParsedModelCall[] = [];
  const callIndexById = new Map<string, number>();
  const openReqIdsByNum = new Map<number, string[]>();
  let latestReqId: string | null = null;
  let syntheticSeq = 0;

  const pushCall = (call: ParsedModelCall) => {
    callIndexById.set(call.id, calls.length);
    calls.push(call);
    latestReqId = call.id;
    if (call.reqNum !== undefined && !call.done) {
      const current = openReqIdsByNum.get(call.reqNum) ?? [];
      openReqIdsByNum.set(call.reqNum, [...current, call.id]);
    }
  };
  const getCall = (id: string | null | undefined): ParsedModelCall | null => {
    if (!id) {
      return null;
    }
    const index = callIndexById.get(id);
    if (index === undefined) {
      return null;
    }
    return calls[index] ?? null;
  };
  const updateCall = (id: string, patch: Partial<ParsedModelCall>) => {
    const index = callIndexById.get(id);
    if (index === undefined) {
      return;
    }
    const next = {
      ...calls[index],
      ...patch,
    };
    calls[index] = next;
  };
  const takeOpenReqId = (reqNum: number): string | null => {
    const current = openReqIdsByNum.get(reqNum) ?? [];
    if (current.length === 0) {
      return null;
    }
    const id = current[current.length - 1] ?? null;
    const next = current.slice(0, -1);
    if (next.length > 0) {
      openReqIdsByNum.set(reqNum, next);
    } else {
      openReqIdsByNum.delete(reqNum);
    }
    return id;
  };
  const normalizeModel = (value: string) => value.trim().toLowerCase();
  const sameModel = (a: string, b: string) => {
    const aa = normalizeModel(a);
    const bb = normalizeModel(b);
    if (!aa || !bb) {
      return false;
    }
    return aa === bb || aa.endsWith(`/${bb}`) || bb.endsWith(`/${aa}`);
  };
  const findLatestOpenCall = (model?: string): ParsedModelCall | null => {
    for (let idx = calls.length - 1; idx >= 0; idx -= 1) {
      const call = calls[idx];
      if (!call || call.done) {
        continue;
      }
      if (!model || sameModel(call.model, model)) {
        return call;
      }
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const modelInputMatch = line.match(/model input:\s+([^\s]+)/i);
    if (modelInputMatch) {
      const model = modelInputMatch[1];
      const existing = findLatestOpenCall(model);
      if (!existing) {
        syntheticSeq += 1;
        pushCall({
          id: `model-${syntheticSeq}`,
          model,
          startedAtLine: i,
          done: false,
          source: "req",
        });
      } else {
        latestReqId = existing.id;
      }
      continue;
    }

    const startMatch = line.match(/req#(\d+) start model=([^\s]+)/);
    if (startMatch) {
      const reqNum = Number(startMatch[1]);
      syntheticSeq += 1;
      const id = `req-${reqNum}-${syntheticSeq}`;
      pushCall({
        id,
        reqNum,
        model: startMatch[2],
        startedAtLine: i,
        done: false,
        source: "req",
      });
      continue;
    }

    const doneMatch = line.match(
      /req#(\d+) done\s+(\d+)ms(?:\s+.*?usage\.in=(\d+))?(?:\s+.*?usage\.out=(\d+))?/,
    );
    if (doneMatch) {
      const reqNum = Number(doneMatch[1]);
      const id = takeOpenReqId(reqNum);
      const existing = getCall(id);
      if (existing) {
        const inputTokens =
          doneMatch[3] !== undefined ? Number(doneMatch[3]) : existing.inputTokens;
        const outputTokens =
          doneMatch[4] !== undefined ? Number(doneMatch[4]) : existing.outputTokens;
        updateCall(existing.id, {
          done: true,
          durationMs: Number(doneMatch[2]),
          inputTokens,
          outputTokens,
        });
        latestReqId = existing.id;
      } else {
        syntheticSeq += 1;
        pushCall({
          id: `req-${reqNum}-done-${syntheticSeq}`,
          reqNum,
          model: "unknown",
          startedAtLine: i,
          done: true,
          durationMs: Number(doneMatch[2]),
          inputTokens: doneMatch[3] !== undefined ? Number(doneMatch[3]) : undefined,
          outputTokens: doneMatch[4] !== undefined ? Number(doneMatch[4]) : undefined,
          source: "req",
        });
      }
      continue;
    }

    const modelOutputMatch = line.match(
      /model output:\s+([^\s]+).*?(?:\sinput=(\d+))?(?:\soutput=(\d+))?/i,
    );
    if (modelOutputMatch) {
      const model = modelOutputMatch[1];
      const existing = findLatestOpenCall(model) ?? getCall(latestReqId);
      if (existing) {
        const inputTokens =
          modelOutputMatch[2] !== undefined ? Number(modelOutputMatch[2]) : existing.inputTokens;
        const outputTokens =
          modelOutputMatch[3] !== undefined ? Number(modelOutputMatch[3]) : existing.outputTokens;
        updateCall(existing.id, {
          done: true,
          inputTokens,
          outputTokens,
        });
        latestReqId = existing.id;
      } else {
        syntheticSeq += 1;
        pushCall({
          id: `model-${syntheticSeq}`,
          model,
          startedAtLine: i,
          done: true,
          inputTokens: modelOutputMatch[2] !== undefined ? Number(modelOutputMatch[2]) : undefined,
          outputTokens: modelOutputMatch[3] !== undefined ? Number(modelOutputMatch[3]) : undefined,
          source: "req",
        });
      }
      continue;
    }

    const timingWaitMatch = line.match(
      /activeSession\.prompt\(\)\s+still running after\s+(\d+)ms\s+provider=([^\s]+)\s+model=([^\s]+)/i,
    );
    if (timingWaitMatch) {
      const waitMs = Number(timingWaitMatch[1]);
      if (latestReqId) {
        const existing = getCall(latestReqId);
        if (existing && !existing.done) {
          updateCall(latestReqId, {
            waitMs,
          });
          continue;
        }
      }
      const syntheticId = `req-wait-${i}`;
      pushCall({
        id: syntheticId,
        model: `${timingWaitMatch[2]}/${timingWaitMatch[3]}`,
        startedAtLine: i,
        waitMs,
        done: false,
        source: "req",
      });
      continue;
    }

    const promptTookMatch = line.match(/activeSession\.prompt\(\)\s+took\s+(\d+)ms/i);
    if (promptTookMatch) {
      const existing = getCall(latestReqId) ?? findLatestOpenCall();
      if (existing) {
        updateCall(existing.id, {
          durationMs: Number(promptTookMatch[1]),
          done: true,
        });
        latestReqId = existing.id;
      }
      continue;
    }

    const usageFallbackMatch = line.match(
      /model output:\s+[^\s]+\s+response=\d+\s+chars\s+input=(\d+)\s+output=(\d+)/,
    );
    if (usageFallbackMatch && latestReqId) {
      const existing = getCall(latestReqId);
      if (existing) {
        updateCall(latestReqId, {
          inputTokens: existing.inputTokens ?? Number(usageFallbackMatch[1]),
          outputTokens: existing.outputTokens ?? Number(usageFallbackMatch[2]),
        });
      }
    }
  }

  return calls.toSorted((a, b) => a.startedAtLine - b.startedAtLine);
}

function renderRunDetails(
  selectedRun: TestSuiteRunResult | null,
  runEvents: TestSuiteRunEvent[],
  selectedRunId: string | null,
  runHistory: TestSuiteRunResult[],
  onSelectRun: (runId: string) => void,
  onRerunSuite: (suiteId: string) => void,
  runBusy: boolean,
) {
  const outputRaw = [selectedRun?.stdoutTail ?? "", selectedRun?.stderrTail ?? ""]
    .filter(Boolean)
    .join("\n");
  const output = stripAnsiAndControl(outputRaw);

  const modelCalls = parseModelCalls(output);
  const anyInflight = modelCalls.some((call) => !call.done);
  const liveInputTokens = modelCalls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0);
  const liveOutputTokens = modelCalls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0);
  const liveTotalTokens = liveInputTokens + liveOutputTokens;
  const liveInvocationCount = modelCalls.length;
  const completedCalls = modelCalls.filter((call) => call.done);
  const liveAvgLatencyMs =
    completedCalls.length > 0
      ? completedCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0) /
        completedCalls.length
      : 0;
  const displayTotalTokens =
    liveTotalTokens > 0 ? liveTotalTokens : (selectedRun?.metrics?.totalTokens ?? 0);
  const displayLocalTokens =
    liveTotalTokens > 0 ? liveTotalTokens : (selectedRun?.metrics?.localTokens ?? 0);
  const displayCloudTokens = liveTotalTokens > 0 ? 0 : (selectedRun?.metrics?.cloudTokens ?? 0);
  const displayInvocations =
    liveInvocationCount > 0 ? liveInvocationCount : (selectedRun?.metrics?.totalInvocations ?? 0);
  const displayLocalInvocations =
    liveInvocationCount > 0 ? liveInvocationCount : (selectedRun?.metrics?.localInvocations ?? 0);
  const displayCloudInvocations =
    liveInvocationCount > 0 ? 0 : (selectedRun?.metrics?.cloudInvocations ?? 0);
  const displayAvgLatency =
    liveAvgLatencyMs > 0 ? liveAvgLatencyMs : (selectedRun?.metrics?.avgLatencyMs ?? 0);
  const displayExecutionMetrics = {
    localInvocations: displayLocalInvocations,
    cloudInvocations: displayCloudInvocations,
    totalInvocations: displayInvocations,
  };

  return html`
    <div class="card" style="background: var(--panel); border: 1px solid var(--border);">
      <div class="card-title" style="margin-bottom: 8px;">Test Run Dashboard</div>
      ${
        selectedRun
          ? html`
              <div style="display: flex; justify-content: flex-end; margin-bottom: 8px;">
                <button
                  class="secondary"
                  ?disabled=${runBusy}
                  @click=${() => onRerunSuite(selectedRun.suiteId)}
                >
                  ${runBusy ? "Running..." : "Rerun"}
                </button>
              </div>
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
                  <div class="metric-value">${formatTokens(displayTotalTokens)}</div>
                  <div class="muted" style="font-size: 11px;">L ${formatTokens(displayLocalTokens)} · C ${formatTokens(displayCloudTokens)}</div>
                </div>
                <div class="metric-card">
                  <div class="muted" style="font-size: 11px;">Model Calls</div>
                  <div class="metric-value">${formatTokens(displayInvocations)}</div>
                  <div class="muted" style="font-size: 11px;">avg ${formatMs(displayAvgLatency)}</div>
                </div>
              </div>
              <div style="margin-top: 8px;">
                <span class="chip">${modelExecutionLabel(displayExecutionMetrics)}</span>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px;">
                <div class="card" style="background: var(--bg); border: 1px solid var(--border);">
                  <div class="card-title" style="font-size: 12px;">Model Routing View (Live)</div>
                  <div class="muted" style="font-size: 12px; margin-top: 4px;">router -> model calls parsed from live log output.</div>
                  <div style="margin-top: 8px; display: grid; gap: 6px;">
                    ${
                      modelCalls.length === 0
                        ? html`
                            <div class="muted">No model calls detected in output yet.</div>
                          `
                        : modelCalls.map(
                            (call) => html`
                            <div style="display: grid; grid-template-columns: auto 1fr auto auto; gap: 8px; align-items: center; border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px;">
                              <span class="chip">${call.id}</span>
                              <span class="mono" style="font-size: 12px;">router -> ${call.model}</span>
                              <span class="mono muted" style="font-size: 11px;">in ${formatTokens(call.inputTokens ?? 0)} · out ${formatTokens(call.outputTokens ?? 0)}</span>
                              <span class="chip" style="border-color: ${call.done ? "var(--success)" : "var(--accent)"};">
                                ${
                                  call.done
                                    ? `done ${formatMs(call.durationMs ?? 0)}`
                                    : call.waitMs
                                      ? `waiting ${formatMs(call.waitMs)}`
                                      : "waiting"
                                }
                              </span>
                            </div>
                          `,
                          )
                    }
                  </div>
                  ${
                    anyInflight
                      ? html`
                          <div class="muted" style="margin-top: 8px">A model call is currently in-flight.</div>
                        `
                      : null
                  }
                </div>

                <div class="card" style="background: var(--bg); border: 1px solid var(--border);">
                  <div class="card-title" style="font-size: 12px;">Run Activity</div>
                  <div style="margin-top: 8px; max-height: 220px; overflow: auto;">
                    ${
                      runEvents.length === 0
                        ? html`
                            <div class="muted">Run activity events will appear here.</div>
                          `
                        : runEvents
                            .toReversed()
                            .slice(0, 40)
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
                </div>
              </div>

              <div class="card" style="background: var(--bg); border: 1px solid var(--border); margin-top: 10px;">
                <div class="card-title" style="font-size: 12px;">CLI Output (Live)</div>
                <div class="muted" style="font-size: 12px; margin-top: 4px;">
                  PID ${selectedRun.pid ?? "—"} · last output ${selectedRun.lastOutputAt ? new Date(selectedRun.lastOutputAt).toLocaleTimeString() : "—"}
                </div>
                <pre style="margin-top: 8px; background: #0f1116; color: #d6d8de; border: 1px solid #222938; border-radius: 8px; padding: 10px; max-height: 320px; overflow: auto; white-space: pre-wrap; font-size: 11px; line-height: 1.35;">${output || "(no output yet)"}</pre>
              </div>

              <div class="mono muted" style="margin-top: 8px; font-size: 11px;">${selectedRun.command.join(" ")}</div>
            `
          : html`
              <div class="muted">No run selected yet. Start a suite below.</div>
            `
      }

      ${
        runHistory.length > 0
          ? html`
              <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px;">
                ${runHistory.slice(0, 18).map((run) => {
                  const selected = selectedRunId === run.runId;
                  return html`
                    <button
                      class="chip"
                      style="cursor: pointer; ${selected ? "border-color: var(--accent);" : ""}"
                      @click=${() => onSelectRun(run.runId)}
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
  `;
}

function renderOverview(
  suites: TestSuiteEntry[],
  props: {
    busySuiteId: string | null;
    loading: boolean;
    fileQueryBySuite: Record<string, string>;
    filesBySuite: Record<string, string[]>;
    filesLoadingBySuite: Record<string, boolean>;
    selectedFilesBySuite: Record<string, string[]>;
    singleFileBySuite: Record<string, string>;
    testNameBySuite: Record<string, string>;
    onFileQueryChange: (suiteId: string, value: string) => void;
    onDiscoverFiles: (suiteId: string) => void;
    onToggleFileSelection: (suiteId: string, file: string, enabled: boolean) => void;
    onSingleFileChange: (suiteId: string, value: string) => void;
    onTestNameChange: (suiteId: string, value: string) => void;
    onRunSuite: (suiteId: string) => void;
  },
) {
  return html`
    <div style="display: grid; gap: 10px;">
      ${suites.map((suite) => {
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
                  <span class="chip">${modelExecutionLabel(run?.metrics ?? null)}</span>
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
  `;
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
  viewTab: "overview" | "run";
  fileQueryBySuite: Record<string, string>;
  filesBySuite: Record<string, string[]>;
  filesLoadingBySuite: Record<string, boolean>;
  selectedFilesBySuite: Record<string, string[]>;
  singleFileBySuite: Record<string, string>;
  testNameBySuite: Record<string, string>;
  status: string | null;
  localOnly: boolean;
  onRefresh: () => void;
  onSelectRun: (runId: string) => void;
  onSelectView: (tab: "overview" | "run") => void;
  onFileQueryChange: (suiteId: string, value: string) => void;
  onDiscoverFiles: (suiteId: string) => void;
  onToggleFileSelection: (suiteId: string, file: string, enabled: boolean) => void;
  onSingleFileChange: (suiteId: string, value: string) => void;
  onTestNameChange: (suiteId: string, value: string) => void;
  onRunSuite: (suiteId: string) => void;
  onLocalOnlyChange: (value: boolean) => void;
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
      ${
        props.viewTab === "overview"
          ? html`
              <div style="display: flex; align-items: center; gap: 8px;">
                <label style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer;">
                  <input
                    type="checkbox"
                    .checked=${props.localOnly}
                    @change=${(e: Event) =>
                      props.onLocalOnlyChange((e.target as HTMLInputElement).checked)}
                  />
                  <span>Local only</span>
                </label>
                <span class="muted" style="font-size: 12px;">
                  ${props.localOnly ? "Using local model config for test runs." : "Using cloud-integrated config (Codex where configured)."}
                </span>
              </div>
            `
          : null
      }

      <div style="display: flex; gap: 6px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
        <button
          class="chip"
          style="cursor: pointer; ${props.viewTab === "overview" ? "border-color: var(--accent);" : ""}"
          @click=${() => props.onSelectView("overview")}
        >
          Overview
        </button>
        <button
          class="chip"
          style="cursor: pointer; ${props.viewTab === "run" ? "border-color: var(--accent);" : ""}"
          @click=${() => props.onSelectView("run")}
        >
          Test Run
        </button>
      </div>

      ${props.error ? html`<div class="alert error">${props.error}</div>` : null}
      ${props.status ? html`<div class="alert info">${props.status}</div>` : null}

      ${
        props.viewTab === "run"
          ? renderRunDetails(
              selectedRun,
              props.runEvents,
              props.selectedRunId,
              props.runHistory,
              props.onSelectRun,
              props.onRunSuite,
              Boolean(props.busySuiteId),
            )
          : renderOverview(props.suites, {
              busySuiteId: props.busySuiteId,
              loading: props.loading,
              fileQueryBySuite: props.fileQueryBySuite,
              filesBySuite: props.filesBySuite,
              filesLoadingBySuite: props.filesLoadingBySuite,
              selectedFilesBySuite: props.selectedFilesBySuite,
              singleFileBySuite: props.singleFileBySuite,
              testNameBySuite: props.testNameBySuite,
              onFileQueryChange: props.onFileQueryChange,
              onDiscoverFiles: props.onDiscoverFiles,
              onToggleFileSelection: props.onToggleFileSelection,
              onSingleFileChange: props.onSingleFileChange,
              onTestNameChange: props.onTestNameChange,
              onRunSuite: props.onRunSuite,
            })
      }
    </div>
  `;
}
