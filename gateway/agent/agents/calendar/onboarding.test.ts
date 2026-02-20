import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_ONBOARDING_HANDLER } from "./onboarding.js";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

function makeContext(workspaceDir: string, cleanedBody: string) {
  return {
    agentId: "calendar",
    cleanedBody,
    workspaceDir,
    cfg: {} as never,
    userIdentifier: "calendar-user",
    sessionKey: "calendar-session",
  };
}

function mockExecFileFailure() {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: object, cb: Function) => {
    cb(new Error("auth unavailable"), "", "auth unavailable");
  });
}

describe("calendar onboarding handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes expected calendar files", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-onboarding-"));
    await CALENDAR_ONBOARDING_HANDLER.initializeFiles(makeContext(workspaceDir, ""));

    await expect(
      fs.readFile(path.join(workspaceDir, "calendar-settings.json"), "utf8"),
    ).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(workspaceDir, "calendar-notes.txt"), "utf8")).resolves.toBe(
      "",
    );
    const files = await fs.readdir(workspaceDir);
    expect(files.some((name) => /^calendar-memo-.*\.md$/i.test(name))).toBe(true);
  });

  it("returns readiness error when calendar setup is incomplete", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-onboarding-"));
    await CALENDAR_ONBOARDING_HANDLER.initializeFiles(makeContext(workspaceDir, ""));
    mockExecFileFailure();

    const reply = await CALENDAR_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(workspaceDir, "what's on my calendar today"),
    );
    expect(reply).toMatchObject({
      text: expect.stringContaining("Calendar agent is not ready yet"),
    });
    expect(reply).toMatchObject({ text: expect.stringContaining("gog auth add") });
    expect(reply).toMatchObject({ text: expect.stringContaining("calendarId") });
    expect(reply).toMatchObject({ text: expect.stringContaining("timezone") });
  });
});
