import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCalendarProfileSystemPrompt } from "./calendar-profile-system-prompt.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("buildCalendarProfileSystemPrompt", () => {
  it("returns empty for non-calendar agents", async () => {
    const dir = await makeTempDir("calendar-profile-non-calendar-");
    const prompt = await buildCalendarProfileSystemPrompt({
      agentId: "main",
      workspaceDir: dir,
    });
    expect(prompt).toBe("");
  });

  it("returns empty when settings file is missing", async () => {
    const dir = await makeTempDir("calendar-profile-missing-");
    const prompt = await buildCalendarProfileSystemPrompt({
      agentId: "calendar",
      workspaceDir: dir,
    });
    expect(prompt).toBe("");
  });

  it("injects compact trusted defaults from calendar-settings.json", async () => {
    const dir = await makeTempDir("calendar-profile-settings-");
    await fs.writeFile(
      path.join(dir, "calendar-settings.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          profile: {
            calendarId: "ikebotai@gmail.com",
            timezone: "America/Los_Angeles",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const prompt = await buildCalendarProfileSystemPrompt({
      agentId: "calendar",
      workspaceDir: dir,
    });
    expect(prompt).toContain("## Calendar Profile (trusted workspace config)");
    expect(prompt).toContain("calendarId: ikebotai@gmail.com");
    expect(prompt).toContain("timezone: America/Los_Angeles");
    expect(prompt).toContain("Do not run `pwd`, `ls`, or `cat calendar-settings.json`");
    expect(prompt).toContain("Read-window requests: first tool call should be one");
  });
});
