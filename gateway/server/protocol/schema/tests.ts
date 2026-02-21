import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const TestSuiteLevelSchema = Type.Union([
  Type.Literal("unit"),
  Type.Literal("agent"),
  Type.Literal("e2e"),
]);

export const TestsSuitesParamsSchema = Type.Object({}, { additionalProperties: false });

export const TestsDiscoverParamsSchema = Type.Object(
  {
    level: TestSuiteLevelSchema,
    query: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);

export const TestsRunParamsSchema = Type.Object(
  {
    suiteId: NonEmptyString,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000 })),
    files: Type.Optional(Type.Array(NonEmptyString, { minItems: 1, maxItems: 50 })),
    testName: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  },
  { additionalProperties: false },
);

export const TestsWaitParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
