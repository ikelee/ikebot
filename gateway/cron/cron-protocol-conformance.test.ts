import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CronDeliverySchema } from "../server/protocol/schema.js";

type SchemaLike = {
  anyOf?: Array<{ properties?: Record<string, unknown>; const?: unknown }>;
  properties?: Record<string, unknown>;
  const?: unknown;
};

function extractDeliveryModes(schema: SchemaLike): string[] {
  const modeSchema = schema.properties?.mode as SchemaLike | undefined;
  return (modeSchema?.anyOf ?? [])
    .map((entry) => entry?.const)
    .filter((value): value is string => typeof value === "string");
}

const UI_FILES = [
  "ui/web/src/ui/types.ts",
  "ui/web/src/ui/ui-types.ts",
  "ui/web/src/ui/views/cron.ts",
];

describe("cron protocol conformance", () => {
  it("ui includes all cron delivery modes from gateway schema", async () => {
    const modes = extractDeliveryModes(CronDeliverySchema as SchemaLike);
    expect(modes.length).toBeGreaterThan(0);

    const cwd = process.cwd();
    for (const relPath of UI_FILES) {
      const content = await fs.readFile(path.join(cwd, relPath), "utf-8");
      for (const mode of modes) {
        expect(content.includes(`"${mode}"`), `${relPath} missing delivery mode ${mode}`).toBe(
          true,
        );
      }
    }
  });

  it("cron status shape matches gateway fields in UI", async () => {
    const cwd = process.cwd();
    const uiTypes = await fs.readFile(path.join(cwd, "ui/web/src/ui/types.ts"), "utf-8");
    expect(uiTypes.includes("export type CronStatus")).toBe(true);
    expect(uiTypes.includes("jobs:")).toBe(true);
    expect(uiTypes.includes("jobCount")).toBe(false);
  });
});
