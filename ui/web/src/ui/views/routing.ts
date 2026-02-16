import { html, nothing } from "lit";
import type { RoutingEventEntry } from "../app-events.ts";
import { ROUTING_ENTRY, ROUTING_AGENTS, type RoutingAgentNode } from "./routing-architecture.ts";
import { routingStylesString } from "./routingStyles.ts";

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

function renderNodeWithTooltip(node: RoutingAgentNode) {
  return html`
    <div class="routing-node tier-${node.tier}">
      <div class="routing-node-name">${node.name}</div>
      <div class="routing-node-purpose">${node.purpose}</div>
      <div class="routing-node-meta">
        <span>${node.modelHint}</span>
        <span>·</span>
        <span>${node.access.tools.length ? node.access.tools.join(", ") : "no tools"}</span>
      </div>
      <div class="routing-tooltip">
        <div class="routing-tooltip-title">System prompt</div>
        ${node.systemPrompt}
      </div>
    </div>
  `;
}

function renderEntryNode() {
  return html`
    <div class="routing-node entry">
      <div class="routing-node-name">${ROUTING_ENTRY.name}</div>
      <div class="routing-node-purpose">${ROUTING_ENTRY.file}</div>
      <div class="routing-node-meta">${ROUTING_ENTRY.caller}</div>
      <div class="routing-tooltip">
        <div class="routing-tooltip-title">Entry point</div>
        All messages flow through runAgentFlow() in gateway/agent/run.ts, called from get-reply.ts after stageSandboxMedia.
      </div>
    </div>
  `;
}

function renderArchitectureOverview() {
  const router = ROUTING_AGENTS.find((a) => a.id === "router")!;
  const simple = ROUTING_AGENTS.find((a) => a.id === "simple-responder")!;
  const complex = ROUTING_AGENTS.find((a) => a.id === "complex")!;

  return html`
    <style>${routingStylesString}</style>
    <div class="card" style="margin-bottom: 16px;">
      <div class="card-title">Architecture</div>
      <div class="card-sub">Simple path = 2 model calls (Router classifies, Simple Responder replies). Hover boxes for prompts.</div>
      <div class="routing-diagram">
        <div class="routing-diagram-row">
          ${renderEntryNode()}
          <span class="routing-arrow">→</span>
          ${renderNodeWithTooltip(router)}
        </div>
        <div class="routing-flow-connector">
          <svg class="routing-flow-connector-svg" viewBox="0 0 320 50" preserveAspectRatio="xMidYMin meet">
            <line x1="160" y1="0" x2="160" y2="18" />
            <line x1="50" y1="18" x2="270" y2="18" />
            <line x1="50" y1="18" x2="50" y2="50" />
            <line x1="270" y1="18" x2="270" y2="50" />
          </svg>
        </div>
        <div class="routing-flow-branches">
          <div class="routing-flow-branch">
            <div class="routing-flow-branch-content">
              <span class="routing-edge-label stay">stay</span>
              <span class="routing-arrow">→</span>
              ${renderNodeWithTooltip(simple)}
            </div>
          </div>
          <div class="routing-flow-branch">
            <div class="routing-flow-branch-content">
              <span class="routing-edge-label escalate">escalate</span>
              <span class="routing-arrow">→</span>
              ${renderNodeWithTooltip(complex)}
            </div>
          </div>
        </div>
      </div>
      <div style="margin-top: 20px;">
        <div class="muted" style="font-size: 12px; margin-bottom: 8px;">Agents (from config)</div>
        <div class="routing-agents-grid">
          ${ROUTING_AGENTS.map(
            (a) => html`
              <div class="routing-agent-card">
                <div class="routing-node-name">${a.name}</div>
                <div class="routing-node-purpose">${a.purpose}</div>
                <div class="routing-node-meta">
                  ${a.tier} · ${a.modelHint}
                </div>
                <div class="routing-tooltip">
                  <div class="routing-tooltip-title">System prompt</div>
                  ${a.systemPrompt}
                </div>
              </div>
            `,
          )}
        </div>
      </div>
    </div>
  `;
}

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
        <div class="card-title">Path taken for this input</div>
        <button class="btn secondary" @click=${onClear}>Close</button>
      </div>
      <div class="card-sub">${formatTs(entry.ts)} · Run ${entry.runId.slice(0, 8)}… · seq ${entry.seq}</div>
      <div class="stack" style="margin-top: 16px; gap: 16px;">
        ${renderFlowDiagram(entry)}
        <div>
          <div class="muted">Input (user message)</div>
          <div class="code-block" style="margin-top: 4px; padding: 8px; white-space: pre-wrap; word-break: break-word;">${entry.bodyPreview || "(empty)"}</div>
        </div>
        <div>
          <div class="muted">Path taken (model response)</div>
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
      ${renderArchitectureOverview()}
      <div class="card">
        <div class="card-title">Model routing</div>
        <div class="card-sub">
          Recent tiered routing decisions (Phase 1 → stay/escalate). Select a row to see the path taken and model response.
        </div>
        <p class="muted" style="margin-top: 8px; font-size: 0.9em;">
          Events are buffered in memory (up to ${ROUTING_EVENTS_LIMIT}); not persisted. Refresh clears history.
        </p>
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
