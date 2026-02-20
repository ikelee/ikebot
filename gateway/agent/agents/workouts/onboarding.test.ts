import { completeSimple } from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKOUTS_ONBOARDING_HANDLER } from "./onboarding.js";
import { parseWorkoutState } from "./state.js";

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
    agentId: "workouts",
    cleanedBody,
    workspaceDir,
    cfg: {} as never,
    userIdentifier: "user-1",
    sessionKey: "session-1",
  };
}

describe("workouts onboarding handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes workouts files when missing", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "workouts-onboarding-"));
    await WORKOUTS_ONBOARDING_HANDLER.initializeFiles(makeContext(workspaceDir, ""));

    const workoutsRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
    const state = parseWorkoutState(workoutsRaw);
    expect(state.schemaVersion).toBe(2);

    const notesRaw = await fs.readFile(path.join(workspaceDir, "workout-notes.txt"), "utf8");
    expect(notesRaw).toBe("");
  });

  it("captures onboarding response including coaching style", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "workouts-onboarding-"));
    const emptyState = {
      schemaVersion: 2,
      profile: {},
      program: {},
      events: [],
      views: { personalBests: { strength: {} } },
    };
    await fs.writeFile(
      path.join(workspaceDir, "workouts.json"),
      JSON.stringify(emptyState, null, 2),
      "utf8",
    );

    vi.mocked(completeSimple)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"program":"PPL"}' }],
      } as never)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"goals":["strength","hypertrophy"]}' }],
      } as never)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"bodyWeightLb":182}' }],
      } as never)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"coachingStyle":"assertive"}' }],
      } as never);

    await WORKOUTS_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(workspaceDir, "program: PPL"),
    );
    await WORKOUTS_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(workspaceDir, "goals: strength, hypertrophy"),
    );
    await WORKOUTS_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(workspaceDir, "bodyWeight: 182 lb"),
    );
    const reply = await WORKOUTS_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(workspaceDir, "style: assertive"),
    );
    expect(reply).toMatchObject({ text: expect.stringContaining("Onboarding saved") });

    const workoutsRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
    const state = parseWorkoutState(workoutsRaw);
    expect(state.profile?.coachingStyle).toBe("assertive");
    expect(state.profile?.goals).toEqual(["strength", "hypertrophy"]);
    expect(state.program?.name).toBe("PPL");
  });

  it("prompts one field at a time and accepts natural language answers", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "workouts-onboarding-"));
    await fs.writeFile(path.join(workspaceDir, "workouts.json"), JSON.stringify({}), "utf8");

    const step1 = await WORKOUTS_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(workspaceDir, ""),
    );
    expect(step1).toMatchObject({
      text: expect.stringContaining("program: ..."),
    });
    expect((step1 as { text: string }).text).not.toContain("goals:");

    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: '{"program":"5/3/1"}' }],
    } as never);
    const step2 = await WORKOUTS_ONBOARDING_HANDLER.maybeHandleOnboarding(
      makeContext(
        workspaceDir,
        "I want to run 5/3/1, gym 4 times a week. Gain muscles and increase my PRs. I'm 165lb",
      ),
    );
    expect(step2).toMatchObject({
      text: expect.stringContaining("goals: ..."),
    });

    const workoutsRaw = await fs.readFile(path.join(workspaceDir, "workouts.json"), "utf8");
    const state = parseWorkoutState(workoutsRaw);
    expect(state.program?.name).toBe("5/3/1");
    expect(state.profile?.daysPerWeek).toBeUndefined();
    expect(state.profile?.bodyWeightLb).toBeUndefined();
    expect(state.profile?.goals).toEqual([]);
  });
});
