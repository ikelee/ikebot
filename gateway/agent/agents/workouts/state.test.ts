import { describe, expect, it } from "vitest";
import {
  getCurrentDayInProgram,
  getPersonalBest,
  getPersonalBestsMap,
  getPushVsMinimum,
  getTodaysExercises,
  memoFilenameForIdentifier,
  parseWorkoutState,
  type WorkoutState,
} from "./state.js";

describe("workout state v2", () => {
  it("parses empty JSON into schemaVersion 2", () => {
    const state = parseWorkoutState("{}");
    expect(state.schemaVersion).toBe(2);
    expect(state.events).toBeUndefined();
    expect(state.views?.personalBests?.strength).toEqual({});
  });

  it("parses events and views.personalBests.strength", () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      events: [
        {
          modality: "strength",
          exercise: "Bench Press",
          timestamp: "2026-02-10T18:00:00Z",
          metrics: { sets: 3, reps: 8, weightLb: 185 },
        },
      ],
      views: {
        personalBests: {
          strength: {
            "Bench Press": { weight: 185, reps: 8, date: "2026-02-10" },
          },
        },
      },
    });
    const state = parseWorkoutState(raw);
    expect(state.events).toHaveLength(1);
    expect(getPersonalBest(state, "Bench Press")).toMatchObject({ weight: 185, reps: 8 });
    expect(getPersonalBestsMap(state)["Bench Press"]).toMatchObject({ weight: 185 });
  });

  it("returns empty state on invalid JSON", () => {
    const state = parseWorkoutState("not json");
    expect(state).toEqual({});
  });

  it("reads current day and exercises from program", () => {
    const state: WorkoutState = {
      schemaVersion: 2,
      program: {
        name: "5/3/1",
        cycleLength: 4,
        currentDay: 2,
        currentCycle: 1,
        days: [
          { dayNumber: 1, exercises: [{ name: "Bench Press", sets: 3, minReps: 5, pushReps: 8 }] },
          { dayNumber: 2, exercises: [{ name: "Squat", sets: 3, minReps: 5, pushReps: 8 }] },
        ],
      },
      views: { personalBests: { strength: {} } },
    };

    expect(getCurrentDayInProgram(state)).toBe(2);
    expect(getTodaysExercises(state)).toHaveLength(1);
    expect((getTodaysExercises(state)[0] as { name?: string }).name).toBe("Squat");
    expect(getPushVsMinimum(state, "squat")).toEqual({ minReps: 5, pushReps: 8 });
  });

  it("returns undefined when exercise PR is missing", () => {
    const state: WorkoutState = {
      schemaVersion: 2,
      views: { personalBests: { strength: {} } },
    };
    expect(getPersonalBest(state, "Deadlift")).toBeUndefined();
  });

  it("memo filename sanitization works", () => {
    expect(memoFilenameForIdentifier("user@example.com")).toBe("workout-memo-user-example-com.md");
    expect(memoFilenameForIdentifier("telegram:12345")).toBe("workout-memo-telegram-12345.md");
    expect(memoFilenameForIdentifier("---")).toBe("workout-memo-default.md");
  });
});
