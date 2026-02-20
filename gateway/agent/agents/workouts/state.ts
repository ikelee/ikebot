/**
 * Workout state schema and helpers.
 *
 * v2 schema keeps event logs as canonical and reducers in `views`.
 */

export type WorkoutEvent = {
  id?: string;
  timestamp?: string;
  modality?: "strength" | "cardio" | "mobility" | "sport" | "endurance" | string;
  exercise?: string;
  metrics?: Record<string, unknown>;
  notes?: string;
};

type PersonalBestRecord = { weight?: number; reps?: number; date?: string };

/** Loose workout state – all fields optional, extra keys allowed. */
export type WorkoutState = Record<string, unknown> & {
  schemaVersion?: number;
  profile?: Record<string, unknown>;
  program?: {
    name?: string;
    cycleLength?: number;
    currentDay?: number;
    currentCycle?: number;
    days?: Array<{ dayNumber?: number; exercises?: Array<Record<string, unknown>> }>;
  };
  events?: WorkoutEvent[];
  views?: {
    personalBests?: {
      strength?: Record<string, PersonalBestRecord>;
      cardio?: Record<string, unknown>;
      mobility?: Record<string, unknown>;
      sport?: Record<string, unknown>;
      endurance?: Record<string, unknown>;
    };
  };
};

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === "object" && !Array.isArray(entry),
  );
}

function normalizeExerciseName(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function canonicalExerciseName(name: string): string {
  const pretty = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!pretty) {
    return name;
  }
  return pretty
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeEvents(parsed: WorkoutState): WorkoutEvent[] {
  const events = asObjectArray(parsed.events).map((event) => {
    const rec = event as WorkoutEvent;
    return {
      ...rec,
      modality: typeof rec.modality === "string" ? rec.modality : "strength",
      exercise: typeof rec.exercise === "string" ? rec.exercise : undefined,
      metrics: rec.metrics && typeof rec.metrics === "object" ? rec.metrics : {},
    } satisfies WorkoutEvent;
  });
  if (events.length > 0) {
    return events;
  }
  return [];
}

function mergePersonalBests(
  a: Record<string, PersonalBestRecord>,
  b: Record<string, PersonalBestRecord>,
): Record<string, PersonalBestRecord> {
  const out: Record<string, PersonalBestRecord> = { ...a };
  const existingKeys = Object.keys(out);
  for (const [incomingName, value] of Object.entries(b)) {
    const targetKey =
      existingKeys.find(
        (key) => normalizeExerciseName(key) === normalizeExerciseName(incomingName),
      ) ?? canonicalExerciseName(incomingName);
    const prev = out[targetKey] ?? {};
    const prevWeight = toNumber(prev.weight) ?? -Infinity;
    const nextWeight = toNumber(value.weight) ?? -Infinity;
    if (nextWeight > prevWeight) {
      out[targetKey] = value;
      continue;
    }
    if (nextWeight < prevWeight) {
      continue;
    }
    const prevReps = toNumber(prev.reps) ?? -Infinity;
    const nextReps = toNumber(value.reps) ?? -Infinity;
    if (nextReps > prevReps) {
      out[targetKey] = value;
    }
  }
  return out;
}

export function getPersonalBestsMap(state: WorkoutState): Record<string, PersonalBestRecord> {
  const fromViews =
    state.views?.personalBests?.strength && typeof state.views.personalBests.strength === "object"
      ? state.views.personalBests.strength
      : {};
  return mergePersonalBests({}, fromViews);
}

/** Parse workouts.json – permissive, v2 only (`events` + `views`). */
export function parseWorkoutState(raw: string): WorkoutState {
  try {
    const parsed = JSON.parse(raw) as WorkoutState;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const events = normalizeEvents(parsed);
    const personalBests = getPersonalBestsMap(parsed);
    const normalizedBase: WorkoutState = {
      ...parsed,
      schemaVersion:
        typeof parsed.schemaVersion === "number" && Number.isFinite(parsed.schemaVersion)
          ? parsed.schemaVersion
          : 2,
    };
    if (events.length > 0 || Array.isArray(parsed.events)) {
      normalizedBase.events = events;
    }
    const views = parsed.views;
    const existingPersonalBests =
      views &&
      typeof views === "object" &&
      views.personalBests &&
      typeof views.personalBests === "object"
        ? views.personalBests
        : {};
    if (views && typeof views === "object") {
      normalizedBase.views = {
        ...views,
        personalBests: {
          ...existingPersonalBests,
          strength: personalBests,
        },
      };
    } else {
      normalizedBase.views = {
        personalBests: {
          strength: personalBests,
        },
      };
    }
    return normalizedBase;
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
  const pbs = getPersonalBestsMap(state);
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
