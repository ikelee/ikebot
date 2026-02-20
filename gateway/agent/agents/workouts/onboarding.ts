import { completeSimple } from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentOnboardingContext, AgentOnboardingHandler } from "../../onboarding/types.js";
import type { ReplyPayload } from "../../pipeline/types.js";
import { parseModelRef } from "../../../models/model-selection.js";
import { resolveOpenClawAgentDir } from "../../../runtime/agent-paths.js";
import { resolveAgentModelPrimary } from "../../../runtime/agent-scope.js";
import { resolveModel } from "../../../runtime/pi-embedded-runner/model.js";
import { memoFilenameForIdentifier, parseWorkoutState, type WorkoutState } from "./state.js";

type CoachingStyle = "supportive" | "assertive" | "aggressive";
type MissingOnboardingField = "program" | "goals" | "bodyWeight" | "coachingStyle";

const DEFAULT_WORKOUTS_STATE: WorkoutState = {
  schemaVersion: 2,
  profile: {
    goals: [],
    equipment: [],
  },
  program: {
    name: "",
    cycleLength: 0,
    currentDay: 0,
    currentCycle: 0,
    days: [],
  },
  events: [],
  views: {
    personalBests: {
      strength: {},
      cardio: {},
      mobility: {},
      sport: {},
      endurance: {},
    },
  },
};

export async function resetWorkoutsOnboardingFiles(
  workspaceDir: string,
  userIdentifier: string,
): Promise<void> {
  await fs.mkdir(workspaceDir, { recursive: true });
  const notesPath = path.join(workspaceDir, "workout-notes.txt");
  const memoPath = path.join(workspaceDir, memoFilenameForIdentifier(userIdentifier));
  const legacyLogsPath = path.join(workspaceDir, "workout_logs.txt");

  await writeWorkoutState(workspaceDir, DEFAULT_WORKOUTS_STATE);
  await fs.writeFile(notesPath, "", "utf8");
  await fs.writeFile(memoPath, "# Workout Persona\n\n", "utf8");
  try {
    await fs.unlink(legacyLogsPath);
  } catch {
    // Best effort: file may not exist.
  }
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

function normalizeExtractionResult(
  field: MissingOnboardingField,
  extracted: Record<string, unknown>,
): Partial<WorkoutState> {
  const profilePatch: Record<string, unknown> = {};
  const programPatch: Record<string, unknown> = {};

  if (field === "program") {
    const program = typeof extracted.program === "string" ? extracted.program.trim() : "";
    if (program) {
      profilePatch.program = program;
      programPatch.name = program;
    }
  }
  if (field === "goals") {
    const goals = Array.isArray(extracted.goals)
      ? extracted.goals
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean)
          .slice(0, 3)
      : [];
    if (goals.length > 0) {
      profilePatch.goals = goals;
    }
  }
  if (field === "bodyWeight") {
    const bodyWeightLb = extracted.bodyWeightLb;
    const bodyWeightKg = extracted.bodyWeightKg;
    if (typeof bodyWeightLb === "number" && Number.isFinite(bodyWeightLb)) {
      profilePatch.bodyWeightLb = bodyWeightLb;
    } else if (typeof bodyWeightKg === "number" && Number.isFinite(bodyWeightKg)) {
      profilePatch.bodyWeightKg = bodyWeightKg;
    }
  }
  if (field === "coachingStyle") {
    const style = typeof extracted.coachingStyle === "string" ? extracted.coachingStyle.trim() : "";
    const normalized = style.toLowerCase();
    if (normalized === "supportive" || normalized === "assertive" || normalized === "aggressive") {
      profilePatch.coachingStyle = normalized;
    }
  }

  return {
    ...(Object.keys(profilePatch).length > 0 ? { profile: profilePatch } : {}),
    ...(Object.keys(programPatch).length > 0
      ? { program: programPatch as WorkoutState["program"] }
      : {}),
  };
}

async function extractPatchWithModel(
  context: AgentOnboardingContext,
  field: MissingOnboardingField,
  body: string,
): Promise<Partial<WorkoutState>> {
  const rawModel =
    resolveAgentModelPrimary(context.cfg, "workouts") ??
    context.cfg?.agents?.defaults?.model ??
    "ollama/qwen2.5:14b";
  const modelRefRaw =
    typeof rawModel === "string"
      ? rawModel
      : rawModel && typeof rawModel === "object" && typeof rawModel.primary === "string"
        ? rawModel.primary
        : "";
  const modelRef = parseModelRef(modelRefRaw, "ollama");
  if (!modelRef) {
    return {};
  }
  const resolvedModel = resolveModel(
    modelRef.provider,
    modelRef.model,
    resolveOpenClawAgentDir(),
    context.cfg,
  );
  if (!resolvedModel.model) {
    return {};
  }

  const systemPrompt = `Extract a single workouts onboarding field from user text.
Field: ${field}
Return ONLY JSON with one of these shapes:
- {"program":"5/3/1"}
- {"goals":["build muscle","strength"]}
- {"bodyWeightLb":165} or {"bodyWeightKg":75}
- {"coachingStyle":"supportive"|"assertive"|"aggressive"}
If the field is missing/unclear, return {}.`;

  try {
    const response = await completeSimple(
      resolvedModel.model,
      {
        systemPrompt,
        messages: [{ role: "user", content: body, timestamp: Date.now() }],
      },
      {
        apiKey: "no-api-key-needed",
        temperature: 0,
        maxTokens: 180,
      },
    );
    const text = Array.isArray(response.content)
      ? response.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("")
      : "";
    const parsed = extractJsonObject(text);
    if (!parsed) {
      return {};
    }
    return normalizeExtractionResult(field, parsed);
  } catch {
    return {};
  }
}

function mergeWorkoutState(base: WorkoutState, patch: Partial<WorkoutState>): WorkoutState {
  return {
    ...base,
    ...patch,
    schemaVersion: 2,
    profile: {
      ...base.profile,
      ...patch.profile,
    },
    program: {
      ...base.program,
      ...patch.program,
    },
    views: {
      ...base.views,
      personalBests: {
        ...base.views?.personalBests,
        ...patch.views?.personalBests,
      },
    },
  };
}

function resolveMissingFields(state: WorkoutState): MissingOnboardingField[] {
  const profile = state.profile ?? {};
  const goals = Array.isArray(profile.goals) ? profile.goals.filter(Boolean) : [];
  const programName =
    typeof state.program?.name === "string" && state.program.name.trim()
      ? state.program.name.trim()
      : typeof profile.program === "string" && profile.program.trim()
        ? profile.program.trim()
        : "";
  const bodyWeight =
    (typeof profile.bodyWeightLb === "number" && Number.isFinite(profile.bodyWeightLb)
      ? profile.bodyWeightLb
      : null) ??
    (typeof profile.bodyWeightKg === "number" && Number.isFinite(profile.bodyWeightKg)
      ? profile.bodyWeightKg
      : null) ??
    (typeof profile.weight === "number" && Number.isFinite(profile.weight) ? profile.weight : null);
  const coachingStyle =
    typeof profile.coachingStyle === "string" ? profile.coachingStyle.trim().toLowerCase() : "";
  const missing: MissingOnboardingField[] = [];
  if (goals.length === 0) {
    missing.push("goals");
  }
  if (!programName) {
    missing.push("program");
  }
  if (bodyWeight == null) {
    missing.push("bodyWeight");
  }
  if (!["supportive", "assertive", "aggressive"].includes(coachingStyle)) {
    missing.push("coachingStyle");
  }
  return missing;
}

function selectPromptField(missing: MissingOnboardingField[]): MissingOnboardingField {
  const order: MissingOnboardingField[] = ["program", "goals", "bodyWeight", "coachingStyle"];
  const set = new Set(missing);
  for (const item of order) {
    if (set.has(item)) {
      return item;
    }
  }
  return missing[0] ?? "program";
}

function buildOnboardingPrompt(missing: MissingOnboardingField[]): string {
  const field = selectPromptField(missing);
  const lines: string[] = [
    "Before we continue, quick workouts onboarding.",
    "Quick reply in one line:",
  ];
  if (field === "program") {
    lines.push("program: ...");
    lines.push("- Program: what you normally run (for example 5/3/1, PPL, upper/lower).");
  } else if (field === "goals") {
    lines.push("goals: ...");
    lines.push("- Goals: 1-3 priorities.");
  } else if (field === "bodyWeight") {
    lines.push("bodyWeight: ...");
    lines.push("- Body weight: include unit (lb/kg).");
  } else {
    lines.push("style: supportive|assertive|aggressive");
    lines.push("- Coaching style: supportive, assertive, or aggressive.");
  }
  return lines.join("\n");
}

async function readWorkoutState(workspaceDir: string): Promise<WorkoutState> {
  const workoutsPath = path.join(workspaceDir, "workouts.json");
  try {
    const raw = await fs.readFile(workoutsPath, "utf8");
    const parsed = parseWorkoutState(raw);
    return mergeWorkoutState(DEFAULT_WORKOUTS_STATE, parsed);
  } catch {
    return DEFAULT_WORKOUTS_STATE;
  }
}

async function writeWorkoutState(workspaceDir: string, state: WorkoutState): Promise<void> {
  const workoutsPath = path.join(workspaceDir, "workouts.json");
  await fs.writeFile(workoutsPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function buildOnboardingSavedReply(state: WorkoutState): ReplyPayload {
  const styleRaw = String(state.profile?.coachingStyle ?? "supportive").toLowerCase();
  const style: CoachingStyle = ["supportive", "assertive", "aggressive"].includes(styleRaw)
    ? (styleRaw as CoachingStyle)
    : "supportive";
  return {
    text: `Onboarding saved. Coaching style set to ${style}. You can start logging workouts now.`,
  };
}

export const WORKOUTS_ONBOARDING_HANDLER: AgentOnboardingHandler = {
  agentId: "workouts",
  async initializeFiles(context: AgentOnboardingContext): Promise<void> {
    await fs.mkdir(context.workspaceDir, { recursive: true });
    const workoutsPath = path.join(context.workspaceDir, "workouts.json");
    const notesPath = path.join(context.workspaceDir, "workout-notes.txt");
    const memoPath = path.join(
      context.workspaceDir,
      memoFilenameForIdentifier(context.userIdentifier),
    );

    try {
      await fs.access(workoutsPath);
    } catch {
      await writeWorkoutState(context.workspaceDir, DEFAULT_WORKOUTS_STATE);
    }
    try {
      await fs.access(notesPath);
    } catch {
      await fs.writeFile(notesPath, "", "utf8");
    }
    try {
      await fs.access(memoPath);
    } catch {
      await fs.writeFile(memoPath, "# Workout Persona\n\n", "utf8");
    }
  },

  async maybeHandleOnboarding(
    context: AgentOnboardingContext,
  ): Promise<ReplyPayload | ReplyPayload[] | undefined> {
    const body = context.cleanedBody.trim();
    const baseState = await readWorkoutState(context.workspaceDir);
    const missingBefore = resolveMissingFields(baseState);
    if (missingBefore.length === 0) {
      return undefined;
    }
    if (!body) {
      return { text: buildOnboardingPrompt(missingBefore) };
    }

    const targetField = selectPromptField(missingBefore);
    const patch = await extractPatchWithModel(context, targetField, body);
    const hasPatch = !!patch.profile || !!patch.program;
    if (!hasPatch) {
      return { text: buildOnboardingPrompt(missingBefore) };
    }

    const merged = mergeWorkoutState(baseState, patch);
    await writeWorkoutState(context.workspaceDir, merged);
    const missingAfter = resolveMissingFields(merged);
    if (missingAfter.length > 0) {
      return { text: buildOnboardingPrompt(missingAfter) };
    }
    return buildOnboardingSavedReply(merged);
  },
};
