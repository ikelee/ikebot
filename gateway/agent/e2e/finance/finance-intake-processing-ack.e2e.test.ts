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

function weeklyWindowDateOffset(daysFromStart: number): string {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const day = (end.getDay() + 6) % 7;
  end.setDate(end.getDate() - day);
  const start = new Date(end);
  start.setDate(start.getDate() - 7 + daysFromStart);
  return start.toISOString().slice(0, 10);
}

async function ollamaAvailable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ollamaModelAvailable(baseUrl: string, modelId: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return false;
    }
    const json = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const names = new Set(
      (json.models ?? [])
        .flatMap((m) => [m.name ?? "", m.model ?? ""])
        .map((name) => name.trim())
        .filter(Boolean),
    );
    return names.has(modelId);
  } catch {
    return false;
  }
}

function flattenMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const p = part as { type?: unknown; text?: unknown };
      if (p.type === "text" && typeof p.text === "string") {
        return p.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

async function completeSimpleViaOllama(params: {
  baseUrl: string;
  modelId: string;
  systemPrompt?: string;
  messages: Array<{ role?: string; content?: unknown }>;
}): Promise<{
  content: Array<{ type: "text"; text: string }>;
  usage: { input: number; output: number };
}> {
  const payload = {
    model: params.modelId,
    stream: false,
    temperature: 0.1,
    messages: [
      ...(params.systemPrompt ? [{ role: "system", content: params.systemPrompt }] : []),
      ...params.messages.map((msg) => ({
        role: msg.role ?? "user",
        content: flattenMessageContent(msg.content),
      })),
    ],
  };
  const res = await fetch(`${params.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(`ollama chat failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = `${json.choices?.[0]?.message?.content ?? ""}`;
  return {
    content: [{ type: "text", text }],
    usage: {
      input: json.usage?.prompt_tokens ?? 0,
      output: json.usage?.completion_tokens ?? 0,
    },
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

      const ocrImageArgs = execFilePromiseMock.mock.calls
        .map((call) => `${call[1]?.[0] ?? ""}`)
        .filter(Boolean);
      expect(ocrImageArgs.length).toBeGreaterThanOrEqual(2);
      expect(ocrImageArgs).toContain(mediaA);
      expect(ocrImageArgs).toContain(mediaB);

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

  it("routes 11 screenshots to finance intake and processes OCR -> per-image qwen json -> weekly summary", async () => {
    __resetOnboardingStateForTests();
    execFilePromiseMock.mockReset();

    const mediaPaths = [
      "/Users/ikebot/.openclaw/media/inbound/9fd4466d-9181-45f6-8c39-f17d3286050f.png",
      "/Users/ikebot/.openclaw/media/inbound/05e96e6d-01f1-44ff-bc7e-9b51a1816fd2.png",
      "/Users/ikebot/.openclaw/media/inbound/95650a91-85d1-48a2-9a4c-78b28b56a2b8.png",
      "/Users/ikebot/.openclaw/media/inbound/785a6f6c-d53e-44d5-b18e-16c6d0c51ae2.png",
      "/Users/ikebot/.openclaw/media/inbound/96de363c-0173-4d7e-bdc2-9eb0c5f4ed8d.png",
      "/Users/ikebot/.openclaw/media/inbound/4ce011be-88fa-467f-b7bc-09cc8435f306.png",
      "/Users/ikebot/.openclaw/media/inbound/4921449f-355f-4906-abd5-0967e40fee0d.png",
      "/Users/ikebot/.openclaw/media/inbound/35932f85-a3d6-4b24-91d2-42ea2b7586cd.png",
      "/Users/ikebot/.openclaw/media/inbound/c99ed9d2-29c6-4752-b957-d55388a480dc.png",
      "/Users/ikebot/.openclaw/media/inbound/6ddec29a-293f-4168-b61f-001af8a5d637.png",
      "/Users/ikebot/.openclaw/media/inbound/32f1685a-57bb-44bd-976f-cfbba204b5c1.png",
    ];
    execFilePromiseMock.mockImplementation(async (_cmd: string, args: string[]) => {
      const imagePath = args?.[0] ?? "";
      const index = mediaPaths.indexOf(imagePath);
      if (index < 0) {
        throw new Error(`unexpected image: ${imagePath}`);
      }
      return { stdout: `OCR-${index + 1}: receipt snapshot`, stderr: "" };
    });

    const dateInWindow = weeklyWindowDateOffset(1);
    const llmResponses = Array.from({ length: mediaPaths.length }, (_, index) => ({
      date: dateInWindow,
      amount: index + 1,
      merchant: `Store ${index + 1}`,
      description: `txn ${index + 1}`,
      source: "capital_one",
      spender: "Ike",
      ownership: "mine",
      category: "groceries",
      confidence: 0.95,
    }));

    const completeMock = vi.mocked(completeSimple);
    completeMock.mockReset();
    completeMock.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"decision":"finance"}' }],
      usage: { input: 12, output: 4 },
    });
    for (const row of llmResponses) {
      completeMock.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify([row]) }],
        usage: { input: 90, output: 40 },
      });
    }

    await withTempHome(async (home) => {
      const cfg = cfgFor(home);
      const onBlockReply = vi.fn(async () => undefined);
      const body =
        "[BlueBubbles user:ikelee98@gmail.com Wed 2026-02-25 21:04 PST] Parse these spendings";
      const result = await getReplyFromConfig(
        {
          Body: body,
          RawBody: body,
          CommandBody: body,
          MediaPaths: mediaPaths,
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
      const ocrImageArgs = execFilePromiseMock.mock.calls
        .map((call) => `${call[1]?.[0] ?? ""}`)
        .filter(Boolean);
      expect(ocrImageArgs.length).toBeGreaterThanOrEqual(mediaPaths.length);
      for (const mediaPath of mediaPaths) {
        expect(ocrImageArgs).toContain(mediaPath);
      }

      const completeCalls = completeMock.mock.calls;
      expect(completeCalls).toHaveLength(1 + mediaPaths.length);
      const firstCallMessages = completeCalls[0]?.[1] as {
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const firstUserMessage = firstCallMessages.messages?.find((m) => m.role === "user");
      expect(typeof firstUserMessage?.content === "string" && firstUserMessage.content).toContain(
        "Parse these spendings",
      );

      const ocrCallBodies = completeCalls
        .slice(1)
        .map((call) => {
          const prompt = call[1] as { messages?: Array<{ role?: string; content?: unknown }> };
          const userMessage = prompt.messages?.find((m) => m.role === "user");
          return typeof userMessage?.content === "string" ? userMessage.content : "";
        })
        .filter(Boolean);
      expect(ocrCallBodies).toHaveLength(mediaPaths.length);
      for (const [index, ocrBody] of ocrCallBodies.entries()) {
        expect(ocrBody).toContain(`OCR-${index + 1}: receipt snapshot`);
      }
      expect(ocrCallBodies.join("\n")).not.toContain("[media attached");
      expect(ocrCallBodies.join("\n")).not.toContain("/Users/ikebot/.openclaw/media/inbound/");

      const replyText = extractReplyText(result);
      expect(replyText).toContain("Processed spendings from your screenshots.");
      expect(replyText).toContain("Category: groceries ($66.00)");
      expect(replyText).toContain("Weekly gross total: $66.00");

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
        .map((line) => JSON.parse(line) as { sourceRef?: string });
      expect(stagedLines).toHaveLength(mediaPaths.length);
      expect(stagedLines.map((line) => line.sourceRef)).toEqual(
        mediaPaths.map((imagePath) => imagePath.split("/").at(-1)),
      );
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

  it(
    "live: runs full 11-image routed flow with real OCR + real ollama qwen and prints summary",
    async () => {
      if (process.env.OPENCLAW_FINANCE_LIVE_E2E !== "1") {
        return;
      }
      __resetOnboardingStateForTests();
      const ollamaBase = "http://localhost:11434";
      const modelId = process.env.OPENCLAW_FINANCE_TEST_MODEL?.trim() || "qwen2.5:14b";
      const mediaPaths = [
        "/Users/ikebot/.openclaw/media/inbound/9fd4466d-9181-45f6-8c39-f17d3286050f.png",
        "/Users/ikebot/.openclaw/media/inbound/05e96e6d-01f1-44ff-bc7e-9b51a1816fd2.png",
        "/Users/ikebot/.openclaw/media/inbound/95650a91-85d1-48a2-9a4c-78b28b56a2b8.png",
        "/Users/ikebot/.openclaw/media/inbound/785a6f6c-d53e-44d5-b18e-16c6d0c51ae2.png",
        "/Users/ikebot/.openclaw/media/inbound/96de363c-0173-4d7e-bdc2-9eb0c5f4ed8d.png",
        "/Users/ikebot/.openclaw/media/inbound/4ce011be-88fa-467f-b7bc-09cc8435f306.png",
        "/Users/ikebot/.openclaw/media/inbound/4921449f-355f-4906-abd5-0967e40fee0d.png",
        "/Users/ikebot/.openclaw/media/inbound/35932f85-a3d6-4b24-91d2-42ea2b7586cd.png",
        "/Users/ikebot/.openclaw/media/inbound/c99ed9d2-29c6-4752-b957-d55388a480dc.png",
        "/Users/ikebot/.openclaw/media/inbound/6ddec29a-293f-4168-b61f-001af8a5d637.png",
        "/Users/ikebot/.openclaw/media/inbound/32f1685a-57bb-44bd-976f-cfbba204b5c1.png",
      ];
      if (mediaPaths.some((p) => !existsSync(p))) {
        console.log("[finance-live-e2e] skipping: one or more expected screenshots are missing");
        return;
      }
      if (!(await ollamaAvailable(ollamaBase))) {
        console.log("[finance-live-e2e] skipping: ollama not reachable at http://localhost:11434");
        return;
      }
      if (!(await ollamaModelAvailable(ollamaBase, modelId))) {
        console.log(`[finance-live-e2e] skipping: ollama model missing: ${modelId}`);
        return;
      }

      const actualChildProcess =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const realExecFileAsync = promisify(actualChildProcess.execFile);
      execFilePromiseMock.mockReset();
      execFilePromiseMock.mockImplementation((...args: unknown[]) =>
        realExecFileAsync(...(args as [string, ReadonlyArray<string>, object?])),
      );

      const completeMock = vi.mocked(completeSimple);
      completeMock.mockReset();
      completeMock.mockImplementation(async (_model: unknown, input: unknown) => {
        const prompt = input as {
          systemPrompt?: string;
          messages?: Array<{ role?: string; content?: unknown }>;
        };
        return completeSimpleViaOllama({
          baseUrl: ollamaBase,
          modelId,
          systemPrompt: prompt.systemPrompt,
          messages: prompt.messages ?? [],
        });
      });

      await withTempHome(async (home) => {
        const cfg = cfgFor(home);
        const onBlockReply = vi.fn(async () => undefined);
        const body =
          "[BlueBubbles user:ikelee98@gmail.com Wed 2026-02-25 21:04 PST] Parse these spendings";
        const result = await getReplyFromConfig(
          {
            Body: body,
            RawBody: body,
            CommandBody: body,
            MediaPaths: mediaPaths,
            From: "ikelee98@gmail.com",
            To: "ikelee98@gmail.com",
            Provider: "bluebubbles",
          },
          { onBlockReply },
          cfg,
        );

        const replyText = extractReplyText(result);
        console.log("[finance-live-e2e] final reply:");
        console.log(replyText);

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
          .map(
            (line) =>
              JSON.parse(line) as {
                sourceRef?: string;
                amount?: number;
                date?: string;
                merchant?: string;
              },
          );

        const bySource = new Map<string, number>();
        for (const row of stagedLines) {
          const key = row.sourceRef ?? "unknown";
          bySource.set(key, (bySource.get(key) ?? 0) + 1);
        }
        console.log(`[finance-live-e2e] staged rows: ${stagedLines.length}`);
        for (const source of mediaPaths.map((p) => p.split("/").at(-1) ?? p)) {
          console.log(`[finance-live-e2e] source=${source} rows=${bySource.get(source) ?? 0}`);
        }
        console.log("[finance-live-e2e] sample staged rows:");
        for (const row of stagedLines.slice(0, 15)) {
          console.log(
            `[finance-live-e2e] ${row.date ?? "unknown-date"} | ${row.merchant ?? "unknown"} | $${(row.amount ?? 0).toFixed(2)} | ${row.sourceRef ?? "unknown"}`,
          );
        }

        expect(onBlockReply).toHaveBeenCalled();
        expect(replyText.length).toBeGreaterThan(0);
        expect(execFilePromiseMock.mock.calls.length).toBeGreaterThanOrEqual(mediaPaths.length);
        expect(completeMock.mock.calls.length).toBeGreaterThanOrEqual(1 + mediaPaths.length);
      });
    },
    10 * 60_000,
  );
});
