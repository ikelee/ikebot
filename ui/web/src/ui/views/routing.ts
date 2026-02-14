import { html, nothing } from "lit";
import type { RoutingEventEntry } from "../app-events.ts";

const ROUTING_EVENTS_LIMIT = 200;

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

export type RoutingProps = {
  events: RoutingEventEntry[];
  replayEntry: RoutingEventEntry | null;
  onSelectEvent: (entry: RoutingEventEntry) => void;
  onClearReplay: () => void;
};

function renderFlowDiagram(entry: RoutingEventEntry) {
  const decision = entry.decision;
  const tier = entry.tier;
  const overridden = entry.overridden;
  return html`
    <div class="stack" style="gap: 8px;">
      <div class="muted">Path</div>
      <div class="row" style="align-items: center; flex-wrap: wrap; gap: 8px;">
        <span class="badge">Phase 1</span>
        <span aria-hidden="true">→</span>
        <span class="badge ${decision === "stay" ? "success" : "warn"}">${decision}</span>
        <span aria-hidden="true">→</span>
        <span class="badge">${tier}</span>
        ${
          overridden
            ? html`
                <span class="badge info">model overridden</span>
              `
            : nothing
        }
      </div>
    </div>
  `;
}

function renderReplayPanel(entry: RoutingEventEntry, onClear: () => void) {
  return html`
    <div class="card" style="margin-top: 16px;">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div class="card-title">Replay: ${formatTs(entry.ts)}</div>
        <button class="btn secondary" @click=${onClear}>Close</button>
      </div>
      <div class="card-sub">Run ${entry.runId.slice(0, 8)}… · seq ${entry.seq}</div>
      <div class="stack" style="margin-top: 16px; gap: 16px;">
        ${renderFlowDiagram(entry)}
        <div>
          <div class="muted">Stage 1 (Phase 1) input</div>
          <div class="code-block" style="margin-top: 4px; padding: 8px; white-space: pre-wrap; word-break: break-word;">${entry.bodyPreview || "(empty)"}</div>
        </div>
        <div>
          <div class="muted">Stage 1 output</div>
          <div class="row" style="gap: 8px; margin-top: 4px;">
            <span class="badge">decision: ${entry.decision}</span>
            <span class="badge">tier: ${entry.tier}</span>
          </div>
        </div>
        <div>
          <div class="muted">Model used</div>
          <div class="code-block" style="margin-top: 4px; padding: 8px;">${entry.provider}/${entry.model}</div>
        </div>
        <div>
          <div class="muted">Overridden</div>
          <div style="margin-top: 4px;">${entry.overridden ? "Yes (classifier model)" : "No (default)"}</div>
        </div>
        ${
          entry.sessionKey
            ? html`
          <div>
            <div class="muted">Session</div>
            <div class="code-block" style="margin-top: 4px; padding: 8px; font-size: 0.9em;">${entry.sessionKey}</div>
          </div>
        `
            : nothing
        }
      </div>
    </div>
  `;
}

export function renderRouting(props: RoutingProps) {
  const events = props.events.slice(0, ROUTING_EVENTS_LIMIT);
  const replay = props.replayEntry;

  return html`
    <section>
      <div class="card">
        <div class="card-title">Model routing</div>
        <div class="card-sub">
          Recent tiered routing decisions (Phase 1 → stay/escalate). Select a row to see the path and payload.
        </div>
        ${
          events.length === 0
            ? html`
                <p class="muted" style="margin-top: 16px">
                  No routing events yet. Send a message to see decisions.
                </p>
              `
            : html`
              <div class="table-wrap" style="margin-top: 16px;">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Decision</th>
                      <th>Tier</th>
                      <th>Model</th>
                      <th>Overridden</th>
                      <th>Input preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${events.map(
                      (e) => html`
                        <tr
                          class="clickable ${replay?.runId === e.runId && replay?.seq === e.seq ? "selected" : ""}"
                          @click=${() => props.onSelectEvent(e)}
                        >
                          <td>${formatTs(e.ts)}</td>
                          <td><span class="badge ${e.decision === "stay" ? "success" : "warn"}">${e.decision}</span></td>
                          <td>${e.tier}</td>
                          <td class="mono" style="font-size: 0.85em;">${e.provider}/${e.model}</td>
                          <td>${e.overridden ? "Yes" : "No"}</td>
                          <td class="truncate" style="max-width: 200px;" title=${e.bodyPreview}>${e.bodyPreview || "—"}</td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            `
        }
      </div>
      ${replay ? renderReplayPanel(replay, props.onClearReplay) : nothing}
    </section>
  `;
}
