/**
 * Workout state tests: schema, parsing, and derived values.
 *
 * Verifies the workouts agent can hold and serve:
 * - Overarching: goals, workout patterns, program, personal bests
 * - Day to day: current day, today's exercises, push vs minimum
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getCurrentDayInProgram,
  getPersonalBest,
  getPushVsMinimum,
  getTodaysExercises,
  memoFilenameForIdentifier,
  parseWorkoutState,
  type WorkoutState,
} from "./state.js";

describe("workout state", () => {
  describe("parseWorkoutState", () => {
    it("parses empty JSON into empty state", () => {
      const state = parseWorkoutState("{}");
      expect(state).toEqual({});
      expect(state.profile).toBeUndefined();
      expect(state.workouts).toBeUndefined();
    });

    it("parses overarching profile: goals, focus, program", () => {
      const raw = JSON.stringify({
        profile: {
          goals: ["build muscle", "get stronger"],
          focus: "weights",
          program: "5/3/1",
          programStartDate: "2026-01-01",
        },
      });
      const state = parseWorkoutState(raw);
      expect(state.profile?.goals).toEqual(["build muscle", "get stronger"]);
      expect(state.profile?.focus).toBe("weights");
      expect(state.profile?.program).toBe("5/3/1");
      expect(state.profile?.programStartDate).toBe("2026-01-01");
    });

    it("parses personal bests per exercise", () => {
      const raw = JSON.stringify({
        personalBests: {
          "Bench Press": { weight: 225, reps: 5, date: "2026-02-10" },
          Squat: { weight: 315, reps: 3, date: "2026-02-08" },
        },
      });
      const state = parseWorkoutState(raw);
      expect(state.personalBests?.["Bench Press"]).toEqual({
        weight: 225,
        reps: 5,
        date: "2026-02-10",
      });
      expect(state.personalBests?.["Squat"]).toEqual({
        weight: 315,
        reps: 3,
        date: "2026-02-08",
      });
    });

    it("parses program with current day and cycle", () => {
      const raw = JSON.stringify({
        program: {
          name: "PPL",
          cycleLength: 6,
          currentDay: 3,
          currentCycle: 2,
          days: [
            {
              dayNumber: 1,
              exercises: [
                { name: "Bench Press", sets: 4, minReps: 8, pushReps: 10, targetWeight: 185 },
              ],
            },
            {
              dayNumber: 2,
              exercises: [{ name: "Squat", sets: 4, minReps: 6, pushReps: 8, targetWeight: 275 }],
            },
            {
              dayNumber: 3,
              exercises: [
                { name: "Deadlift", sets: 3, minReps: 5, pushReps: 6 },
                { name: "Rows", sets: 3, minReps: 10, pushReps: 12 },
              ],
            },
          ],
        },
      });
      const state = parseWorkoutState(raw);
      expect(state.program?.name).toBe("PPL");
      expect(state.program?.currentDay).toBe(3);
      expect(state.program?.currentCycle).toBe(2);
      expect(state.program?.days).toHaveLength(3);
    });

    it("parses workout history (backward compatible)", () => {
      const raw = JSON.stringify({
        workouts: [
          {
            date: "2026-02-12",
            type: "strength",
            exercises: [{ name: "Bench Press", sets: 3, reps: "10", weight: "135" }],
            notes: "",
          },
        ],
      });
      const state = parseWorkoutState(raw);
      expect(state.workouts).toHaveLength(1);
      expect(state.workouts?.[0].exercises[0].name).toBe("Bench Press");
    });

    it("returns empty state on invalid JSON", () => {
      const state = parseWorkoutState("not json");
      expect(state).toEqual({});
    });
  });

  describe("getCurrentDayInProgram", () => {
    it("returns current day when program exists", () => {
      const state: WorkoutState = {
        program: {
          name: "5/3/1",
          cycleLength: 4,
          currentDay: 2,
          currentCycle: 1,
          days: [
            { dayNumber: 1, exercises: [] },
            { dayNumber: 2, exercises: [] },
          ],
        },
      };
      expect(getCurrentDayInProgram(state)).toBe(2);
    });

    it("returns undefined when no program", () => {
      expect(getCurrentDayInProgram({})).toBeUndefined();
      expect(getCurrentDayInProgram({ program: undefined })).toBeUndefined();
    });
  });

  describe("getTodaysExercises", () => {
    it("returns exercises for current day", () => {
      const state: WorkoutState = {
        program: {
          name: "PPL",
          cycleLength: 6,
          currentDay: 2,
          currentCycle: 1,
          days: [
            { dayNumber: 1, exercises: [{ name: "Bench", sets: 4, minReps: 8 }] },
            {
              dayNumber: 2,
              exercises: [
                { name: "Squat", sets: 4, minReps: 6 },
                { name: "Leg Press", sets: 3, minReps: 12 },
              ],
            },
          ],
        },
      };
      const exercises = getTodaysExercises(state);
      expect(exercises).toHaveLength(2);
      expect((exercises[0] as { name?: string }).name).toBe("Squat");
      expect((exercises[1] as { name?: string }).name).toBe("Leg Press");
    });

    it("returns empty array when no program or day mismatch", () => {
      expect(getTodaysExercises({})).toEqual([]);
      const state: WorkoutState = {
        program: {
          name: "X",
          cycleLength: 1,
          currentDay: 99,
          currentCycle: 1,
          days: [{ dayNumber: 1, exercises: [] }],
        },
      };
      expect(getTodaysExercises(state)).toEqual([]);
    });
  });

  describe("getPushVsMinimum", () => {
    it("returns min and push reps for exercise in today's program", () => {
      const state: WorkoutState = {
        program: {
          name: "PPL",
          cycleLength: 6,
          currentDay: 1,
          currentCycle: 1,
          days: [
            {
              dayNumber: 1,
              exercises: [{ name: "Bench Press", sets: 4, minReps: 8, pushReps: 10 }],
            },
          ],
        },
      };
      expect(getPushVsMinimum(state, "Bench Press")).toEqual({
        minReps: 8,
        pushReps: 10,
      });
    });

    it("returns only minReps when pushReps not set", () => {
      const state: WorkoutState = {
        program: {
          name: "X",
          cycleLength: 1,
          currentDay: 1,
          currentCycle: 1,
          days: [
            {
              dayNumber: 1,
              exercises: [{ name: "Squat", sets: 3, minReps: 5 }],
            },
          ],
        },
      };
      expect(getPushVsMinimum(state, "Squat")).toEqual({
        minReps: 5,
        pushReps: undefined,
      });
    });

    it("matches exercise name case-insensitively", () => {
      const state: WorkoutState = {
        program: {
          name: "X",
          cycleLength: 1,
          currentDay: 1,
          currentCycle: 1,
          days: [
            {
              dayNumber: 1,
              exercises: [{ name: "Bench Press", sets: 4, minReps: 8, pushReps: 10 }],
            },
          ],
        },
      };
      expect(getPushVsMinimum(state, "bench press")).toEqual({
        minReps: 8,
        pushReps: 10,
      });
    });

    it("returns undefined when exercise not in today's program", () => {
      const state: WorkoutState = {
        program: {
          name: "X",
          cycleLength: 1,
          currentDay: 1,
          currentCycle: 1,
          days: [
            {
              dayNumber: 1,
              exercises: [{ name: "Squat", sets: 3, minReps: 5 }],
            },
          ],
        },
      };
      expect(getPushVsMinimum(state, "Deadlift")).toBeUndefined();
    });
  });

  describe("getPersonalBest", () => {
    it("returns PR for exercise", () => {
      const state: WorkoutState = {
        personalBests: {
          "Bench Press": { weight: 225, reps: 5, date: "2026-02-10" },
        },
      };
      expect(getPersonalBest(state, "Bench Press")).toEqual({
        weight: 225,
        reps: 5,
        date: "2026-02-10",
      });
    });

    it("matches exercise name case-insensitively", () => {
      const state: WorkoutState = {
        personalBests: {
          "Bench Press": { weight: 225, reps: 5, date: "2026-02-10" },
        },
      };
      expect(getPersonalBest(state, "bench press")).toEqual({
        weight: 225,
        reps: 5,
        date: "2026-02-10",
      });
    });

    it("returns undefined when no PR for exercise", () => {
      const state: WorkoutState = { personalBests: {} };
      expect(getPersonalBest(state, "Deadlift")).toBeUndefined();
    });
  });

  describe("full state round-trip", () => {
    it("parses and derives all user-facing values", () => {
      const raw = JSON.stringify({
        profile: {
          goals: ["build muscle", "strength"],
          focus: "weights",
          program: "5/3/1",
        },
        personalBests: {
          "Bench Press": { weight: 225, reps: 5, date: "2026-02-10" },
          Squat: { weight: 315, reps: 3, date: "2026-02-08" },
        },
        program: {
          name: "5/3/1",
          cycleLength: 4,
          currentDay: 2,
          currentCycle: 1,
          days: [
            {
              dayNumber: 1,
              exercises: [
                {
                  name: "Bench Press",
                  sets: 3,
                  minReps: 5,
                  pushReps: 8,
                  targetWeight: 185,
                },
              ],
            },
            {
              dayNumber: 2,
              exercises: [
                {
                  name: "Squat",
                  sets: 3,
                  minReps: 5,
                  pushReps: 8,
                  targetWeight: 275,
                },
              ],
            },
          ],
        },
        workouts: [
          {
            date: "2026-02-12",
            type: "strength",
            exercises: [{ name: "Bench Press", sets: 3, reps: "8", weight: "185" }],
          },
        ],
      });

      const state = parseWorkoutState(raw);

      // Overarching
      expect(state.profile?.goals).toContain("build muscle");
      expect(state.profile?.focus).toBe("weights");
      expect(state.profile?.program).toBe("5/3/1");
      expect(getPersonalBest(state, "Bench Press")?.weight).toBe(225);
      expect(getPersonalBest(state, "Squat")?.weight).toBe(315);

      // Day to day
      expect(getCurrentDayInProgram(state)).toBe(2);
      const todays = getTodaysExercises(state);
      expect(todays).toHaveLength(1);
      expect((todays[0] as { name?: string }).name).toBe("Squat");
      expect(getPushVsMinimum(state, "Squat")).toEqual({
        minReps: 5,
        pushReps: 8,
      });

      // History
      expect(state.workouts).toHaveLength(1);
    });
  });

  describe("workspace integration", () => {
    it("loads and parses workouts.json from workspace", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workouts-state-"));
      try {
        const workoutsPath = path.join(dir, "workouts.json");
        const stateContent = {
          profile: { goals: ["strength"], focus: "weights", program: "5/3/1" },
          personalBests: { "Bench Press": { weight: 225, reps: 5, date: "2026-02-10" } },
          program: {
            name: "5/3/1",
            cycleLength: 4,
            currentDay: 1,
            currentCycle: 1,
            days: [
              {
                dayNumber: 1,
                exercises: [{ name: "Bench Press", sets: 3, minReps: 5, pushReps: 8 }],
              },
            ],
          },
          workouts: [],
        };
        await fs.writeFile(workoutsPath, JSON.stringify(stateContent), "utf8");

        const raw = await fs.readFile(workoutsPath, "utf8");
        const state = parseWorkoutState(raw);

        expect(state.profile?.program).toBe("5/3/1");
        expect(getPersonalBest(state, "Bench Press")?.weight).toBe(225);
        expect(getCurrentDayInProgram(state)).toBe(1);
        expect((getTodaysExercises(state)[0] as { name?: string }).name).toBe("Bench Press");
        expect(getPushVsMinimum(state, "Bench Press")).toEqual({
          minReps: 5,
          pushReps: 8,
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("memoFilenameForIdentifier", () => {
    it("sanitizes identifier to safe filename", () => {
      expect(memoFilenameForIdentifier("user@example.com")).toBe(
        "workout-memo-user-example-com.md",
      );
      expect(memoFilenameForIdentifier("telegram:12345")).toBe("workout-memo-telegram-12345.md");
    });

    it("handles empty or invalid identifiers", () => {
      expect(memoFilenameForIdentifier("")).toBe("workout-memo-default.md");
      expect(memoFilenameForIdentifier("---")).toBe("workout-memo-default.md");
    });

    it("preserves alphanumeric and common chars", () => {
      expect(memoFilenameForIdentifier("alice_123")).toBe("workout-memo-alice_123.md");
    });
  });
});
