import { completeSimple } from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_ONBOARDING_HANDLER } from "./onboarding.js";

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
    agentId: "mail",
    cleanedBody,
    workspaceDir,
    cfg: {} as never,
    userIdentifier: "mail-user",
    sessionKey: "mail-session",
  };
}

describe("mail onboarding handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes expected mail files", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mail-onboarding-"));
    await MAIL_ONBOARDING_HANDLER.initializeFiles(makeContext(workspaceDir, ""));

    await expect(
      fs.readFile(path.join(workspaceDir, "mail-settings.json"), "utf8"),
    ).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(workspaceDir, "mail-notes.txt"), "utf8")).resolves.toBe("");
    const files = await fs.readdir(workspaceDir);
    expect(files.some((name) => /^mail-memo-.*\.md$/i.test(name))).toBe(true);
  });

  it("collects one field at a time and completes onboarding", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mail-onboarding-"));
    await MAIL_ONBOARDING_HANDLER.initializeFiles(makeContext(workspaceDir, ""));

    const first = await MAIL_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(workspaceDir, ""),
    );
    expect(first).toMatchObject({ text: expect.stringContaining("accountEmail: ...") });

    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: '{"accountEmail":"ike@example.com"}' }],
    } as never);
    const second = await MAIL_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(workspaceDir, "use ike@example.com"),
    );
    expect(second).toMatchObject({ text: expect.stringContaining("summaryWindowDays: ...") });

    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: '{"summaryWindowDays":5}' }],
    } as never);
    const third = await MAIL_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(workspaceDir, "just summarize 5 days"),
    );
    expect(third).toMatchObject({ text: expect.stringContaining("onboarding saved") });

    const parsed = JSON.parse(
      await fs.readFile(path.join(workspaceDir, "mail-settings.json"), "utf8"),
    ) as { profile?: { accountEmail?: string; summaryWindowDays?: number } };
    expect(parsed.profile?.accountEmail).toBe("ike@example.com");
    expect(parsed.profile?.summaryWindowDays).toBe(5);

    const after = await MAIL_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(workspaceDir, "check my inbox"),
    );
    expect(after).toBeUndefined();
  });
});
