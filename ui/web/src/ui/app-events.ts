export type EventLogEntry = {
  ts: number;
  event: string;
  payload?: unknown;
};

/** One routing decision event from the gateway (stream: "routing"). */
export type RoutingEventEntry = {
  runId: string;
  ts: number;
  seq: number;
  sessionKey?: string;
  decision: "stay" | "escalate";
  tier: "simple" | "complex";
  provider: string;
  model: string;
  overridden: boolean;
  bodyPreview: string;
};
