import { completeSimple } from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REMINDERS_ONBOARDING_HANDLER } from "./onboarding.js";

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
}));
vi.mock("../../../runtime/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn(() => ({
    model: { provider: "ollama", id: "qwen2.5:14b", api: "openai-completions" },
  })),
}));
vi.mock("../../../runtime/agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/agents/main/agent"),
}));

function makeContext(workspaceDir: string, cleanedBody: string) {
  return {
    agentId: "reminders",
    cleanedBody,
    workspaceDir,
    cfg: {} as never,
    userIdentifier: "reminders-user",
    sessionKey: "reminders-session",
  };
}

describe("reminders onboarding handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes expected reminders files", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "reminders-onboarding-"));
    await REMINDERS_ONBOARDING_HANDLER.initializeFiles(makeContext(workspaceDir, ""));

    await expect(
      fs.readFile(path.join(workspaceDir, "reminders.json"), "utf8"),
    ).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(workspaceDir, "reminders-notes.txt"), "utf8")).resolves.toBe(
      "",
    );
    const files = await fs.readdir(workspaceDir);
    expect(files.some((name) => /^reminders-memo-.*\.md$/i.test(name))).toBe(true);
  });

  it("collects one field at a time and completes onboarding", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "reminders-onboarding-"));
    await REMINDERS_ONBOARDING_HANDLER.initializeFiles(makeContext(workspaceDir, ""));

    const first = await REMINDERS_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(workspaceDir, ""),
    );
    expect(first).toMatchObject({ text: expect.stringContaining("timezone: ...") });

    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: '{"timezone":"America/Los_Angeles"}' }],
    } as never);
    const second = await REMINDERS_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(workspaceDir, "I am on pacific time"),
    );
    expect(second).toMatchObject({ text: expect.stringContaining("defaultSnoozeMin: ...") });

    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: '{"defaultSnoozeMin":15}' }],
    } as never);
    const third = await REMINDERS_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(workspaceDir, "snooze 15 minutes"),
    );
    expect(third).toMatchObject({ text: expect.stringContaining("onboarding saved") });

    const parsed = JSON.parse(
      await fs.readFile(path.join(workspaceDir, "reminders.json"), "utf8"),
    ) as { settings?: { timezone?: string; defaultSnoozeMin?: number } };
    expect(parsed.settings?.timezone).toBe("America/Los_Angeles");
    expect(parsed.settings?.defaultSnoozeMin).toBe(15);

    const after = await REMINDERS_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(workspaceDir, "remind me to drink water at 3pm"),
    );
    expect(after).toBeUndefined();
  });
});
