import { completeSimple } from "@mariozechner/pi-ai";
import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../../../test/helpers/temp-home.js";
import { runEmbeddedPiAgent } from "../../../runtime/pi-embedded.js";
import { runFinanceIntakeWorkflow } from "../../agents/finance/intake-workflow.js";
import { getReplyFromConfig } from "../../pipeline/reply.js";
import { __resetOnboardingStateForTests } from "../../run.js";

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
}));

const { execFilePromiseMock } = vi.hoisted(() => ({
  execFilePromiseMock: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = ((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback !== "function") {
      return;
    }
    execFilePromiseMock(...args.slice(0, -1))
      .then((result: { stdout?: string; stderr?: string }) => {
        (callback as (err: Error | null, stdout?: string, stderr?: string) => void)(
          null,
          result?.stdout ?? "",
          result?.stderr ?? "",
        );
      })
      .catch((err: unknown) => {
        (callback as (err: Error | null, stdout?: string, stderr?: string) => void)(
          err instanceof Error ? err : new Error(String(err)),
          "",
          "",
        );
      });
  }) as typeof actual.execFile;
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (...args: unknown[]) =>
    execFilePromiseMock(...args);
  return {
    ...actual,
    execFile,
  };
});

vi.mock("../../../runtime/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  compactEmbeddedPiSession: vi.fn(),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

vi.mock("../../onboarding/service.js", () => ({
  maybeRunAgentOnboarding: vi.fn(async () => undefined),
}));

function extractReplyText(reply: unknown): string {
  if (Array.isArray(reply)) {
    return extractReplyText(reply[0]);
  }
  if (!reply || typeof reply !== "object") {
    return "";
  }
  const text = (reply as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function cfgFor(home: string) {
  return {
    agents: {
      defaults: {
        model: "ollama/qwen2.5:14b",
        routing: { enabled: true, classifierModel: "ollama/qwen2.5:14b" },
        workspace: join(home, "openclaw"),
      },
      list: [
        { id: "main", default: true },
        { id: "finance", skills: [], tools: {} },
      ],
    },
    channels: { bluebubbles: { allowFrom: ["*"] } },
    models: {
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          models: [
            {
              id: "qwen2.5:14b",
              name: "Qwen 2.5 14B",
              api: "openai-completions",
              contextWindow: 32768,
              cost: { input: 0, output: 0 },
            },
          ],
        },
      },
    },
    session: { store: join(home, "sessions.json") },
  };
}

describe("finance intake e2e", () => {
  it("routes media-path intake through OCR-first per-image extraction without forwarding media envelope content", async () => {
    __resetOnboardingStateForTests();
    execFilePromiseMock.mockReset();
    execFilePromiseMock.mockImplementation(async (_cmd: string, args: string[]) => {
      const imagePath = args?.[0] ?? "";
      if (imagePath.endsWith("a.png")) {
        return { stdout: "OCR-A: Trader Joe's 02/20 $42.35", stderr: "" };
      }
      if (imagePath.endsWith("b.png")) {
        return { stdout: "OCR-B: Costco 2026-02-21 $120.00 cardholder Tanay", stderr: "" };
      }
      throw new Error("unexpected image");
    });

    vi.mocked(completeSimple)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"decision":"finance"}' }],
        usage: { input: 10, output: 8 },
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                date: "2026-02-20",
                amount: 42.35,
                merchant: "Trader Joe's",
                description: "groceries",
                source: "capital_one",
                spender: "Ike",
                ownership: "mine",
                category: "groceries",
                confidence: 0.93,
              },
            ]),
          },
        ],
        usage: { input: 120, output: 60 },
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                date: "2026-02-21",
                amount: 120,
                merchant: "Costco",
                description: "household",
                source: "capital_one",
                spender: "Tanay",
                ownership: "not_mine",
                category: "shopping",
                confidence: 0.1,
              },
            ]),
          },
        ],
        usage: { input: 115, output: 55 },
      });

    await withTempHome(async (home) => {
      const cfg = cfgFor(home);
      const onBlockReply = vi.fn(async () => undefined);
      const mediaA = "/Users/test/.openclaw/media/inbound/a.png";
      const mediaB = "/Users/test/.openclaw/media/inbound/b.png";
      const body =
        "[BlueBubbles user:ikelee98@gmail.com Tue 2026-02-24 00:24 PST] Process these spendings";

      const result = await getReplyFromConfig(
        {
          Body: body,
          RawBody: body,
          CommandBody: body,
          MediaPaths: [mediaA, mediaB],
          From: "ikelee98@gmail.com",
          To: "ikelee98@gmail.com",
          Provider: "bluebubbles",
        },
        { onBlockReply },
        cfg,
      );

      expect(onBlockReply).toHaveBeenCalledWith({
        text: "Processing images into spending log. I’ll send the full breakdown when it’s ready.",
      });
      expect(vi.mocked(runEmbeddedPiAgent)).not.toHaveBeenCalled();

      const replyText = extractReplyText(result);
      expect(replyText).toContain("Processed spendings from your screenshots.");
      expect(replyText).toContain("Category: groceries ($42.35)");
      expect(replyText).toContain("Not mine ($120.00)");
      expect(replyText).toContain("Weekly gross total: $42.35");

      expect(execFilePromiseMock).toHaveBeenCalledTimes(2);
      expect(execFilePromiseMock.mock.calls[0]?.[1]?.[0]).toBe(mediaA);
      expect(execFilePromiseMock.mock.calls[1]?.[1]?.[0]).toBe(mediaB);

      const completeCalls = vi.mocked(completeSimple).mock.calls;
      expect(completeCalls.length).toBe(3);
      const callBodies = completeCalls
        .map((call) => {
          const prompt = call[1] as { messages?: Array<{ role?: string; content?: unknown }> };
          const userMessage = prompt.messages?.find((m) => m.role === "user");
          return typeof userMessage?.content === "string" ? userMessage.content : "";
        })
        .filter(Boolean);
      expect(callBodies).toContain("OCR-A: Trader Joe's 02/20 $42.35");
      expect(callBodies).toContain("OCR-B: Costco 2026-02-21 $120.00 cardholder Tanay");
      expect(callBodies.join("\n")).not.toContain("[media attached");
      expect(callBodies.join("\n")).not.toContain("/Users/test/.openclaw/media/inbound/");

      const stagingCandidates = [
        join(home, "openclaw", "history", "staging_candidates.jsonl"),
        join(home, "workspace-finance", "history", "staging_candidates.jsonl"),
        join(home, ".openclaw", "workspace-finance", "history", "staging_candidates.jsonl"),
      ];
      let stagingPath = "";
      for (const candidate of stagingCandidates) {
        try {
          await access(candidate);
          stagingPath = candidate;
          break;
        } catch {
          // try next path
        }
      }
      expect(stagingPath).not.toBe("");
      const staging = await readFile(stagingPath, "utf8");
      const stagedLines = staging
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { sourceRef?: string; date?: string });
      expect(stagedLines).toHaveLength(2);
      expect(stagedLines[0]?.sourceRef).toBe("a.png");
      expect(stagedLines[1]?.sourceRef).toBe("b.png");
      expect(
        stagedLines.every((line) => typeof line.date === "string" && line.date.length > 0),
      ).toBe(true);
    });
  });

  it("can parse a real inbound BlueBubbles screenshot with deterministic fallback", async () => {
    __resetOnboardingStateForTests();
    const candidateImages = [
      "/Users/ikebot/.openclaw/media/inbound/4a3d29ed-fd13-4279-be4b-4343b5c59304.png",
      "/Users/ikebot/.openclaw/media/inbound/41e194f6-af14-4e88-a3c7-84fe801be99b.png",
      "/Users/ikebot/.openclaw/media/inbound/649f7b5c-c42e-4ce0-95c9-5ea1d7f9672e.png",
    ];
    const realImage = candidateImages.find((p) => existsSync(p));
    if (!realImage) {
      return;
    }
    const actualChildProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const realExecFileAsync = promisify(actualChildProcess.execFile);
    execFilePromiseMock.mockReset();
    execFilePromiseMock.mockImplementation((...args: unknown[]) =>
      realExecFileAsync(...(args as [string, ReadonlyArray<string>, object?])),
    );

    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
      usage: { input: 100, output: 5 },
    });

    await withTempHome(async (home) => {
      const cfg = cfgFor(home);
      const result = await runFinanceIntakeWorkflow({
        cleanedBody: "Process these spendings",
        mediaPaths: [realImage],
        provider: "ollama",
        model: "qwen2.5:14b",
        cfg,
        workspaceDir: join(home, "openclaw"),
      });
      expect(result).toBeDefined();
      expect(result).toContain("Processed spendings from your screenshots.");
      expect(result).toContain("Weekly gross total:");
      expect(result).toContain("$");
    });
  });
});
