import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_PARAM_GROUPS,
  extendOpenClawReadTool,
  extendOpenClawWriteTool,
  wrapToolParamNormalization,
  wrapWorkoutsJsonWriteGuard,
} from "./pi-tools.read.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tools-workouts-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("workouts.json write extensions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extends write with deterministic workout append parsing", async () => {
    await withTempDir(async (dir) => {
      const workoutsPath = path.join(dir, "workouts.json");
      await fs.writeFile(
        workoutsPath,
        JSON.stringify(
          {
            personalBests: {},
            workouts: [],
          },
          null,
          2,
        ),
        "utf8",
      );

      const baseExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const wrapped = wrapWorkoutsJsonWriteGuard(
        {
          name: "write",
          description: "write",
          parameters: { type: "object", properties: {} },
          execute: baseExecute,
        },
        dir,
      );

      await wrapped.execute("call-1", {
        path: "workouts.json",
        content: "Append this workout: Deadlift 3x5 at 305 lb",
      });

      const args = baseExecute.mock.calls[0]?.[1] as { content?: string };
      expect(typeof args?.content).toBe("string");
      const parsed = JSON.parse(String(args.content)) as {
        events?: Array<Record<string, unknown>>;
      };
      expect(Array.isArray(parsed.events)).toBe(true);
      expect(parsed.events?.at(-1)).toMatchObject({
        modality: "strength",
        exercise: "Deadlift",
        metrics: { sets: 3, reps: 5, weightLb: 305 },
      });
    });
  });

  it("extends write with explicit personal-bests override parsing", async () => {
    await withTempDir(async (dir) => {
      const workoutsPath = path.join(dir, "workouts.json");
      await fs.writeFile(
        workoutsPath,
        JSON.stringify(
          {
            personalBests: {
              "Bench Press": { weight: 315, reps: 1, date: "2026-02-01" },
            },
            workouts: [],
          },
          null,
          2,
        ),
        "utf8",
      );

      const baseExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const wrapped = wrapWorkoutsJsonWriteGuard(
        {
          name: "write",
          description: "write",
          parameters: { type: "object", properties: {} },
          execute: baseExecute,
        },
        dir,
      );

      await wrapped.execute("call-2", {
        path: "workouts.json",
        content: "Override personal best for Bench Press as 305lb for 5 reps",
      });

      const args = baseExecute.mock.calls[0]?.[1] as { content?: string };
      const parsed = JSON.parse(String(args.content)) as {
        views?: {
          personalBests?: {
            strength?: Record<string, { weight?: number; reps?: number }>;
          };
        };
      };
      expect(parsed.views?.personalBests?.strength?.["Bench Press"]).toMatchObject({
        weight: 305,
        reps: 5,
      });
    });
  });

  it("accepts escaped JSON-like PB payloads and extracts personalBests", async () => {
    await withTempDir(async (dir) => {
      const workoutsPath = path.join(dir, "workouts.json");
      await fs.writeFile(
        workoutsPath,
        JSON.stringify(
          {
            personalBests: {
              "Bench Press": { weight: 185, reps: 8, date: "2026-02-10" },
            },
            workouts: [],
          },
          null,
          2,
        ),
        "utf8",
      );

      const baseExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const wrapped = wrapWorkoutsJsonWriteGuard(
        {
          name: "write",
          description: "write",
          parameters: { type: "object", properties: {} },
          execute: baseExecute,
        },
        dir,
      );

      const escapedJsonLike =
        '{"personalBests":{"Bench Press":{"weight":195,"reps":5}},"workouts":[{"exercise":"Bench Press","sets":3,"reps":"5","weight":"195"}';
      await wrapped.execute("call-3", {
        path: "workouts.json",
        content: escapedJsonLike,
      });

      const args = baseExecute.mock.calls[0]?.[1] as { content?: string };
      const parsed = JSON.parse(String(args.content)) as {
        views?: {
          personalBests?: {
            strength?: Record<string, { weight?: number; reps?: number }>;
          };
        };
      };
      expect(parsed.views?.personalBests?.strength?.["Bench Press"]).toMatchObject({
        weight: 195,
        reps: 5,
      });
    });
  });

  it("auto-repairs missing write path to workouts.json for workout-style content", async () => {
    const baseExecute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const wrapped = wrapToolParamNormalization(
      {
        name: "write",
        description: "write",
        parameters: { type: "object", properties: {} },
        execute: baseExecute,
      },
      CLAUDE_PARAM_GROUPS.write,
    );

    await wrapped.execute("call-4", {
      content: "Log my personal best for deadlift as 305lb for 5 reps",
    });

    const args = baseExecute.mock.calls[0]?.[1] as { path?: string };
    expect(args.path).toBe("workouts.json");
  });

  it("canonicalizes event exercise names from camelCase to existing exercise names", async () => {
    await withTempDir(async (dir) => {
      const workoutsPath = path.join(dir, "workouts.json");
      await fs.writeFile(
        workoutsPath,
        JSON.stringify(
          {
            personalBests: {
              "Bench Press": { weight: 185, reps: 8, date: "2026-02-10" },
            },
            workouts: [],
          },
          null,
          2,
        ),
        "utf8",
      );

      const baseExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const wrapped = wrapWorkoutsJsonWriteGuard(
        {
          name: "write",
          description: "write",
          parameters: { type: "object", properties: {} },
          execute: baseExecute,
        },
        dir,
      );

      await wrapped.execute("call-5", {
        path: "workouts.json",
        content:
          '{"events":[{"modality":"strength","exercise":"benchPress","metrics":{"weightLb":195,"reps":5}}]}',
      });

      const args = baseExecute.mock.calls[0]?.[1] as { content?: string };
      const parsed = JSON.parse(String(args.content)) as {
        views?: {
          personalBests?: {
            strength?: Record<string, { weight?: number; reps?: number }>;
          };
        };
      };
      expect(parsed.views?.personalBests?.strength?.["Bench Press"]).toMatchObject({
        weight: 195,
        reps: 5,
      });
      expect(parsed.views?.personalBests?.strength?.benchPress).toBeUndefined();
    });
  });

  it("parses scalar string metrics from event payloads", async () => {
    await withTempDir(async (dir) => {
      const workoutsPath = path.join(dir, "workouts.json");
      await fs.writeFile(
        workoutsPath,
        JSON.stringify(
          {
            personalBests: {
              "Bench Press": { weight: 185, reps: 8, date: "2026-02-10" },
            },
            workouts: [],
          },
          null,
          2,
        ),
        "utf8",
      );

      const baseExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const wrapped = wrapWorkoutsJsonWriteGuard(
        {
          name: "write",
          description: "write",
          parameters: { type: "object", properties: {} },
          execute: baseExecute,
        },
        dir,
      );

      await wrapped.execute("call-6", {
        path: "workouts.json",
        content:
          '{"events":[{"modality":"strength","exercise":"Bench Press","metrics":{"weightLb":"195","reps":"5"}}]}',
      });

      const args = baseExecute.mock.calls[0]?.[1] as { content?: string };
      const parsed = JSON.parse(String(args.content)) as {
        views?: {
          personalBests?: {
            strength?: Record<string, { weight?: number; reps?: number }>;
          };
        };
      };
      expect(parsed.views?.personalBests?.strength?.["Bench Press"]).toMatchObject({
        weight: 195,
        reps: 5,
      });
    });
  });

  it("extends read with workouts summary alias mapping", async () => {
    await withTempDir(async (dir) => {
      const baseExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "{}" }],
      });
      const wrapped = extendOpenClawReadTool(
        {
          name: "read",
          description: "read",
          parameters: { type: "object", properties: {} },
          execute: baseExecute,
        },
        dir,
      );
      await wrapped.execute("call-7", {
        path: "workouts.json",
        summary: true,
        summary_keys: ["events", "views"],
        summary_tail: 4,
      });
      const args = baseExecute.mock.calls[0]?.[1] as {
        jsonSummary?: boolean;
        jsonSummaryKeys?: string[];
        jsonSummaryTail?: number;
      };
      expect(args.jsonSummary).toBe(true);
      expect(args.jsonSummaryKeys).toEqual(["events", "views"]);
      expect(args.jsonSummaryTail).toBe(4);
    });
  });

  it("extends write with workouts guard through the shared write extension helper", async () => {
    await withTempDir(async (dir) => {
      const workoutsPath = path.join(dir, "workouts.json");
      await fs.writeFile(workoutsPath, JSON.stringify({ personalBests: {}, workouts: [] }), "utf8");

      const baseExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const wrapped = extendOpenClawWriteTool(
        {
          name: "write",
          description: "write",
          parameters: { type: "object", properties: {} },
          execute: baseExecute,
        },
        dir,
      );

      await wrapped.execute("call-8", {
        path: "workouts.json",
        content: "Override personal best for Bench Press as 305lb for 5 reps",
      });

      const args = baseExecute.mock.calls[0]?.[1] as { content?: string };
      const parsed = JSON.parse(String(args.content)) as {
        views?: {
          personalBests?: {
            strength?: Record<string, { weight?: number; reps?: number }>;
          };
        };
      };
      expect(parsed.views?.personalBests?.strength?.["Bench Press"]).toMatchObject({
        weight: 305,
        reps: 5,
      });
    });
  });

  it("upserts personal best from workout entries even when model omits personalBests", async () => {
    await withTempDir(async (dir) => {
      const workoutsPath = path.join(dir, "workouts.json");
      await fs.writeFile(
        workoutsPath,
        JSON.stringify(
          {
            personalBests: {
              "Lateral Dumbbell Rows": { weight: 30, reps: 6, date: "2026-02-01" },
            },
            workouts: [],
          },
          null,
          2,
        ),
        "utf8",
      );

      const baseExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const wrapped = extendOpenClawWriteTool(
        {
          name: "write",
          description: "write",
          parameters: { type: "object", properties: {} },
          execute: baseExecute,
        },
        dir,
      );

      await wrapped.execute("call-9", {
        path: "workouts.json",
        content: JSON.stringify({
          workouts: [
            {
              date: "2026-02-19",
              type: "strength",
              exercises: [{ name: "Lateral Dumbbell Rows", sets: 3, reps: "4", weight: "35" }],
            },
          ],
        }),
      });

      const args = baseExecute.mock.calls[0]?.[1] as { content?: string };
      const parsed = JSON.parse(String(args.content)) as {
        views?: {
          personalBests?: {
            strength?: Record<string, { weight?: number; reps?: number; date?: string }>;
          };
        };
      };
      expect(parsed.views?.personalBests?.strength?.["Lateral Dumbbell Rows"]).toMatchObject({
        weight: 35,
        reps: 4,
      });
    });
  });

  it("derives views.personalBests.strength when workouts.json does not yet exist", async () => {
    await withTempDir(async (dir) => {
      const baseExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const wrapped = extendOpenClawWriteTool(
        {
          name: "write",
          description: "write",
          parameters: { type: "object", properties: {} },
          execute: baseExecute,
        },
        dir,
      );

      await wrapped.execute("call-10", {
        path: "workouts.json",
        content: JSON.stringify({
          events: [
            {
              timestamp: "2026-02-19T18:00:00Z",
              modality: "strength",
              exercise: "Bench Press",
              metrics: {
                sets: 3,
                reps: "5",
                weightLb: "195",
              },
            },
          ],
        }),
      });

      const args = baseExecute.mock.calls[0]?.[1] as { content?: string };
      const parsed = JSON.parse(String(args.content)) as {
        views?: {
          personalBests?: {
            strength?: Record<string, { weight?: number; reps?: number }>;
          };
        };
      };
      expect(parsed.views?.personalBests?.strength?.["Bench Press"]).toMatchObject({
        weight: 195,
        reps: 5,
      });
    });
  });

  it("derives views.personalBests.strength from event-only writes", async () => {
    await withTempDir(async (dir) => {
      const workoutsPath = path.join(dir, "workouts.json");
      await fs.writeFile(
        workoutsPath,
        JSON.stringify(
          {
            schemaVersion: 2,
            profile: { goals: ["strength"] },
            events: [],
            views: { personalBests: { strength: {} } },
          },
          null,
          2,
        ),
        "utf8",
      );

      const baseExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const wrapped = extendOpenClawWriteTool(
        {
          name: "write",
          description: "write",
          parameters: { type: "object", properties: {} },
          execute: baseExecute,
        },
        dir,
      );

      await wrapped.execute("call-11", {
        path: "workouts.json",
        content: JSON.stringify({
          events: [
            {
              modality: "strength",
              exercise: "Bench Press",
              timestamp: "2026-02-19T20:30:00Z",
              metrics: { sets: 3, reps: 5, weightLb: 205 },
            },
          ],
        }),
      });

      const args = baseExecute.mock.calls[0]?.[1] as { content?: string };
      const parsed = JSON.parse(String(args.content)) as {
        views?: {
          personalBests?: {
            strength?: Record<string, { weight?: number; reps?: number }>;
          };
        };
      };
      expect(parsed.views?.personalBests?.strength?.["Bench Press"]).toMatchObject({
        weight: 205,
        reps: 5,
      });
    });
  });

  it("salvages partially malformed event payloads with array metrics", async () => {
    await withTempDir(async (dir) => {
      const workoutsPath = path.join(dir, "workouts.json");
      await fs.writeFile(
        workoutsPath,
        JSON.stringify(
          {
            schemaVersion: 2,
            events: [],
            views: { personalBests: { strength: {} } },
          },
          null,
          2,
        ),
        "utf8",
      );

      const baseExecute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      const wrapped = extendOpenClawWriteTool(
        {
          name: "write",
          description: "write",
          parameters: { type: "object", properties: {} },
          execute: baseExecute,
        },
        dir,
      );

      const malformedLikeModel =
        '{"events":[{"timestamp":"2026-02-19T20:30:00Z","modality":"strength","exercise":"Bench Press","metrics":{"sets":3,"reps":[5],"weightLb":[195]}}]';
      await wrapped.execute("call-12", {
        path: "workouts.json",
        content: malformedLikeModel,
      });

      const args = baseExecute.mock.calls[0]?.[1] as { content?: string };
      const parsed = JSON.parse(String(args.content)) as {
        views?: {
          personalBests?: {
            strength?: Record<string, { weight?: number; reps?: number }>;
          };
        };
      };
      expect(parsed.views?.personalBests?.strength?.["Bench Press"]).toMatchObject({
        weight: 195,
        reps: 5,
      });
    });
  });
});
