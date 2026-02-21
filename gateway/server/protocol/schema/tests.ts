import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const TestsSuitesParamsSchema = Type.Object({}, { additionalProperties: false });

export const TestsRunParamsSchema = Type.Object(
  {
    suiteId: NonEmptyString,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000 })),
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
