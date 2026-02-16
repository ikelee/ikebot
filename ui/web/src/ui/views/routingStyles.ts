export const routingStylesString = `
  .routing-diagram {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
    margin-top: 16px;
  }
  .routing-diagram-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .routing-flow-connector {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    padding: 4px 0 8px;
  }
  .routing-flow-connector-svg {
    width: 320px;
    height: 50px;
  }
  .routing-flow-connector-svg line {
    stroke: var(--border);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .routing-flow-branches {
    display: flex;
    justify-content: center;
    gap: 24px;
    width: 100%;
    max-width: 420px;
  }
  .routing-flow-branch {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
    min-width: 0;
  }
  .routing-flow-branch-content {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .routing-node {
    position: relative;
    padding: 12px 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    min-width: 140px;
    cursor: help;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .routing-node:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-md);
  }
  .routing-node.entry {
    border-style: dashed;
    background: var(--bg);
  }
  .routing-node.tier-small { border-left: 3px solid var(--ok); }
  .routing-node.tier-medium { border-left: 3px solid var(--warn); }
  .routing-node.tier-large { border-left: 3px solid #6366f1; }
  .routing-node-name {
    font-weight: 600;
    font-size: 14px;
    color: var(--text-strong);
  }
  .routing-node-purpose {
    font-size: 12px;
    color: var(--muted);
    margin-top: 4px;
    line-height: 1.4;
  }
  .routing-node-meta {
    font-size: 11px;
    color: var(--muted);
    margin-top: 6px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .routing-arrow {
    color: var(--muted);
    font-size: 14px;
    flex-shrink: 0;
  }
  .routing-edge-label {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--border);
    color: var(--text-muted);
  }
  .routing-edge-label.stay { background: rgba(34, 197, 94, 0.2); color: var(--ok); }
  .routing-edge-label.escalate { background: rgba(234, 179, 8, 0.2); color: var(--warn); }
  .routing-tooltip {
    display: none;
    position: absolute;
    z-index: 100;
    left: 0;
    top: 100%;
    margin-top: 8px;
    min-width: 320px;
    max-width: 480px;
    max-height: 320px;
    overflow-y: auto;
    padding: 12px;
    background: var(--card);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: var(--shadow-lg);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .routing-node:hover .routing-tooltip {
    display: block;
  }
  .routing-tooltip-title {
    font-weight: 600;
    margin-bottom: 8px;
    color: var(--text-strong);
  }
  .routing-agents-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
    margin-top: 12px;
  }
  .routing-agent-card {
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    position: relative;
    cursor: help;
  }
  .routing-agent-card .routing-tooltip {
    min-width: 280px;
  }
  .routing-agent-card:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-sm);
  }
`;
