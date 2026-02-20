import { describe, expect, it } from "vitest";
import {
  mergeJsonWithContract,
  mergeUniqueObjectArrays,
  parseJsonObjectLenient,
} from "./json-memory.js";

describe("json-memory", () => {
  it("parses fenced json leniently", () => {
    const parsed = parseJsonObjectLenient('```json\n{"a":1}\n```');
    expect(parsed).toEqual({ a: 1 });
  });

  it("merges unique object arrays", () => {
    const merged = mergeUniqueObjectArrays(
      [
        { id: 1, n: "a" },
        { id: 2, n: "b" },
      ],
      [
        { id: 2, n: "b" },
        { id: 3, n: "c" },
      ],
    );
    expect(merged).toEqual([
      { id: 1, n: "a" },
      { id: 2, n: "b" },
      { id: 3, n: "c" },
    ]);
  });

  it("applies contract-based merge for object and array keys", () => {
    const merged = mergeJsonWithContract(
      {
        workouts: [{ id: 1 }],
        personalBests: { Bench: { weight: 185 } },
      },
      {
        workouts: [{ id: 2 }],
        personalBests: { Squat: { weight: 315 } },
      },
      {
        appendObjectArrayKeys: ["workouts"],
        mergeObjectKeys: ["personalBests"],
      },
    );
    expect(merged).toEqual({
      workouts: [{ id: 1 }, { id: 2 }],
      personalBests: {
        Bench: { weight: 185 },
        Squat: { weight: 315 },
      },
    });
  });
});
