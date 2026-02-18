/**
 * Workout state schema and helpers.
 *
 * Loose schema: workouts.json (stats, PRs, program), workout-notes.txt (injuries,
 * restrictions), workout-memo-{id}.md (per-user goals, preferences).
 *
 * JSON is for ongoing statistics; don't send full history to LLM. Use recent
 * entries or summaries.
 */

/** Loose workout state – all fields optional, extra keys allowed. */
export type WorkoutState = Record<string, unknown> & {
  profile?: Record<string, unknown>;
  personalBests?: Record<string, { weight?: number; reps?: number; date?: string }>;
  program?: {
    name?: string;
    cycleLength?: number;
    currentDay?: number;
    currentCycle?: number;
    days?: Array<{ dayNumber?: number; exercises?: Array<Record<string, unknown>> }>;
  };
  workouts?: Array<Record<string, unknown>>;
};

/** Parse workouts.json – permissive, preserves extra keys. */
export function parseWorkoutState(raw: string): WorkoutState {
  try {
    const parsed = JSON.parse(raw) as WorkoutState;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Get current day in program (1-based). */
export function getCurrentDayInProgram(state: WorkoutState): number | undefined {
  return state.program?.currentDay;
}

/** Get today's exercises from program. */
export function getTodaysExercises(state: WorkoutState): Array<Record<string, unknown>> {
  const prog = state.program;
  if (!prog?.days?.length) {
    return [];
  }
  const day = prog.days.find((d) => d.dayNumber === prog.currentDay);
  return day?.exercises ?? [];
}

/** Get push vs minimum for an exercise in today's program. */
export function getPushVsMinimum(
  state: WorkoutState,
  exerciseName: string,
): { minReps?: number; pushReps?: number } | undefined {
  const exercises = getTodaysExercises(state);
  const ex = exercises.find(
    (e) =>
      String(e?.name ?? "")
        .toLowerCase()
        .trim() === exerciseName.toLowerCase().trim(),
  );
  if (!ex) {
    return undefined;
  }
  return {
    minReps: typeof ex.minReps === "number" ? ex.minReps : undefined,
    pushReps: typeof ex.pushReps === "number" ? ex.pushReps : undefined,
  };
}

/** Get personal best for an exercise. */
export function getPersonalBest(
  state: WorkoutState,
  exerciseName: string,
): { weight?: number; reps?: number; date?: string } | undefined {
  const pbs = state.personalBests;
  if (!pbs || typeof pbs !== "object") {
    return undefined;
  }
  const key = Object.keys(pbs).find(
    (k) => k.toLowerCase().trim() === exerciseName.toLowerCase().trim(),
  );
  return key ? pbs[key] : undefined;
}

/** Sanitize user/session identifier for use in memo filename. */
export function memoFilenameForIdentifier(identifier: string): string {
  const safe = identifier
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return safe ? `workout-memo-${safe}.md` : "workout-memo-default.md";
}

/** Paths the workouts agent may read/write. */
export const WORKOUTS_NOTES_PATH = "workout-notes.txt";
export const WORKOUTS_JSON_PATH = "workouts.json";
