import { completeSimple } from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentOnboardingContext, AgentOnboardingHandler } from "../../onboarding/types.js";
import type { ReplyPayload } from "../../pipeline/types.js";
import { parseModelRef } from "../../../models/model-selection.js";
import { resolveOpenClawAgentDir } from "../../../runtime/agent-paths.js";
import { resolveAgentModelPrimary } from "../../../runtime/agent-scope.js";
import { resolveModel } from "../../../runtime/pi-embedded-runner/model.js";
import { extractCompletionText, resolveCompleteSimpleApiKey } from "../llm-auth.js";

type MailField = "accountEmail" | "summaryWindowDays";
type MailState = {
  schemaVersion: number;
  profile: {
    accountEmail?: string;
    summaryWindowDays?: number;
    includeFolders?: string[];
  };
};

const DEFAULT_MAIL_STATE: MailState = {
  schemaVersion: 1,
  profile: {
    accountEmail: "",
    summaryWindowDays: 0,
    includeFolders: ["inbox"],
  },
};

function memoPathForUser(workspaceDir: string, userIdentifier: string): string {
  const safe = userIdentifier
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return path.join(workspaceDir, safe ? `mail-memo-${safe}.md` : "mail-memo-default.md");
}

async function readMailState(workspaceDir: string): Promise<MailState> {
  const file = path.join(workspaceDir, "mail-settings.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<MailState>;
    return {
      schemaVersion: 1,
      profile: {
        ...DEFAULT_MAIL_STATE.profile,
        ...parsed?.profile,
      },
    };
  } catch {
    return DEFAULT_MAIL_STATE;
  }
}

async function writeMailState(workspaceDir: string, state: MailState): Promise<void> {
  await fs.writeFile(
    path.join(workspaceDir, "mail-settings.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

function missingFields(state: MailState): MailField[] {
  const missing: MailField[] = [];
  if (!state.profile.accountEmail?.trim()) {
    missing.push("accountEmail");
  }
  const days = state.profile.summaryWindowDays;
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
    missing.push("summaryWindowDays");
  }
  return missing;
}

function promptFor(field: MailField): string {
  if (field === "accountEmail") {
    return [
      "Before we continue, quick mail onboarding.",
      "Quick reply in one line:",
      "accountEmail: ...",
      "- Example: you@gmail.com",
    ].join("\n");
  }
  return [
    "Before we continue, quick mail onboarding.",
    "Quick reply in one line:",
    "summaryWindowDays: ...",
    "- How many recent days to summarize by default (for example 7).",
  ].join("\n");
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function extractField(
  context: AgentOnboardingContext,
  field: MailField,
  body: string,
): Promise<string | number | null> {
  const modelRefRaw =
    resolveAgentModelPrimary(context.cfg, "mail") ??
    context.cfg?.agents?.defaults?.model ??
    "ollama/qwen2.5:14b";
  const raw = typeof modelRefRaw === "string" ? modelRefRaw : "";
  const ref = parseModelRef(raw, "ollama");
  if (!ref) {
    return null;
  }
  const resolved = resolveModel(ref.provider, ref.model, resolveOpenClawAgentDir(), context.cfg);
  if (!resolved.model) {
    return null;
  }
  const apiKey = await resolveCompleteSimpleApiKey({
    model: resolved.model,
    cfg: context.cfg,
    agentDir: resolveOpenClawAgentDir(),
  });
  const systemPrompt = `Extract only ${field} from user text. Return strict JSON only.
If field=${field}:
- accountEmail => {"accountEmail":"you@gmail.com"}
- summaryWindowDays => {"summaryWindowDays":7}
If unknown return {}.`;
  try {
    const response = await completeSimple(
      resolved.model,
      {
        systemPrompt,
        messages: [{ role: "user", content: body, timestamp: Date.now() }],
      },
      { apiKey, temperature: 0, maxTokens: 120 },
    );
    const text = extractCompletionText(response);
    const json = extractJsonObject(text);
    if (!json) {
      return null;
    }
    if (field === "accountEmail") {
      const value = json.accountEmail;
      return typeof value === "string" && value.trim() ? value.trim() : null;
    }
    const days = json.summaryWindowDays;
    return typeof days === "number" && Number.isFinite(days) && days > 0 ? Math.round(days) : null;
  } catch {
    return null;
  }
}

export const MAIL_ONBOARDING_HANDLER: AgentOnboardingHandler = {
  agentId: "mail",
  async initializeFiles(context: AgentOnboardingContext): Promise<void> {
    await fs.mkdir(context.workspaceDir, { recursive: true });
    const settingsPath = path.join(context.workspaceDir, "mail-settings.json");
    const notesPath = path.join(context.workspaceDir, "mail-notes.txt");
    const memoPath = memoPathForUser(context.workspaceDir, context.userIdentifier);
    try {
      await fs.access(settingsPath);
    } catch {
      await writeMailState(context.workspaceDir, DEFAULT_MAIL_STATE);
    }
    try {
      await fs.access(notesPath);
    } catch {
      await fs.writeFile(notesPath, "", "utf8");
    }
    try {
      await fs.access(memoPath);
    } catch {
      await fs.writeFile(memoPath, "# Mail Preferences\n\n", "utf8");
    }
  },
  async maybeHandleOnboarding(
    context: AgentOnboardingContext,
  ): Promise<ReplyPayload | ReplyPayload[] | undefined> {
    const state = await readMailState(context.workspaceDir);
    const missing = missingFields(state);
    if (missing.length === 0) {
      return undefined;
    }
    const field = missing[0];
    const body = context.cleanedBody.trim();
    if (!body) {
      return { text: promptFor(field) };
    }
    const value = await extractField(context, field, body);
    if (value == null) {
      return { text: promptFor(field) };
    }
    const next: MailState = {
      schemaVersion: 1,
      profile: {
        ...state.profile,
        [field]: value,
      },
    };
    await writeMailState(context.workspaceDir, next);
    const remaining = missingFields(next);
    if (remaining.length > 0) {
      return { text: promptFor(remaining[0]) };
    }
    return { text: "Mail onboarding saved. Ask me to check your inbox anytime." };
  },
};
