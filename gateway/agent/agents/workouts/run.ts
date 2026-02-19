/**
 * Workouts Agent – Pi path invocation
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentConfig, resolveAgentDir } from "../../../runtime/agent-scope.js";
import { runPreparedReply } from "../../pipeline/reply/reply-building/get-reply-run.js";
import { runComplexReply } from "../complex/index.js";
import { parseWorkoutState } from "./state.js";

export type RunWorkoutsReplyParams = Parameters<typeof runPreparedReply>[0];

const WORKOUTS_AGENT_ID = "workouts";

function isPersonalBestsQuestion(text: string): boolean {
  return /\b(personal best|personal bests|pbs|records?)\b/i.test(text);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function tryBuildPersonalBestsReply(workspaceDir: string): Promise<string | null> {
  const workoutsPath = path.join(workspaceDir, "workouts.json");
  let raw = "";
  try {
    raw = await fs.readFile(workoutsPath, "utf-8");
  } catch {
    return "I couldn't find `workouts.json` yet. Log one workout and I'll start tracking your personal bests.";
  }

  const state = parseWorkoutState(raw);
  const lines: string[] = [];
  const pbsRaw = state.personalBests;
  if (pbsRaw && typeof pbsRaw === "object") {
    for (const [exercise, value] of Object.entries(pbsRaw)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const rec = value as { weight?: unknown; reps?: unknown; date?: unknown };
      const weight = toNumber(rec.weight);
      const reps = toNumber(rec.reps);
      const date = typeof rec.date === "string" && rec.date.trim() ? rec.date.trim() : undefined;
      const parts: string[] = [];
      if (weight != null) {
        parts.push(`${weight} lb`);
      }
      if (reps != null) {
        parts.push(`${reps} reps`);
      }
      if (date) {
        parts.push(`(${date})`);
      }
      if (parts.length > 0) {
        lines.push(`${exercise}: ${parts.join(" ")}`);
      }
    }
  }

  if (lines.length === 0) {
    return "I don't see any personal bests saved yet in `workouts.json`. If you want, I can infer PBs from your logged workouts next.";
  }
  return `Your personal bests so far:\\n- ${lines.join("\\n- ")}`;
}

export async function runWorkoutsReply(
  params: RunWorkoutsReplyParams,
): Promise<ReturnType<typeof runPreparedReply>> {
  const { cfg } = params;
  const agentConfig = resolveAgentConfig(cfg, WORKOUTS_AGENT_ID);

  if (!agentConfig) {
    console.warn(
      `[workouts] agent "${WORKOUTS_AGENT_ID}" not in agents.list; falling back to complex agent`,
    );
    return runComplexReply(params);
  }

  const agentDir = resolveAgentDir(cfg, WORKOUTS_AGENT_ID);
  const body = String(params.ctx?.BodyForAgent ?? params.ctx?.Body ?? "").trim();
  if (isPersonalBestsQuestion(body)) {
    const deterministic = await tryBuildPersonalBestsReply(params.workspaceDir);
    if (deterministic) {
      return { text: deterministic };
    }
  }
  return runPreparedReply({
    ...params,
    agentId: WORKOUTS_AGENT_ID,
    agentDir,
    replyTier: "complex",
  });
}
