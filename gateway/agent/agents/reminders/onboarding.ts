import { completeSimple } from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentOnboardingContext, AgentOnboardingHandler } from "../../onboarding/types.js";
import type { ReplyPayload } from "../../pipeline/types.js";
import { parseModelRef } from "../../../models/model-selection.js";
import { resolveOpenClawAgentDir } from "../../../runtime/agent-paths.js";
import { resolveAgentModelPrimary } from "../../../runtime/agent-scope.js";
import { resolveModel } from "../../../runtime/pi-embedded-runner/model.js";
import {
  buildCompleteSimpleOptions,
  extractCompletionText,
  resolveCompleteSimpleApiKey,
} from "../llm-auth.js";

type RemindersField = "timezone" | "defaultSnoozeMin";
type RemindersState = {
  schemaVersion: number;
  settings: {
    timezone?: string;
    defaultSnoozeMin?: number;
  };
  reminders: Array<Record<string, unknown>>;
};

const DEFAULT_REMINDERS_STATE: RemindersState = {
  schemaVersion: 1,
  settings: {
    timezone: "",
    defaultSnoozeMin: 0,
  },
  reminders: [],
};

function memoPathForUser(workspaceDir: string, userIdentifier: string): string {
  const safe = userIdentifier
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return path.join(workspaceDir, safe ? `reminders-memo-${safe}.md` : "reminders-memo-default.md");
}

async function readRemindersState(workspaceDir: string): Promise<RemindersState> {
  const file = path.join(workspaceDir, "reminders.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<RemindersState>;
    return {
      schemaVersion: 1,
      settings: {
        ...DEFAULT_REMINDERS_STATE.settings,
        ...parsed?.settings,
      },
      reminders: Array.isArray(parsed?.reminders) ? parsed.reminders : [],
    };
  } catch {
    return DEFAULT_REMINDERS_STATE;
  }
}

async function writeRemindersState(workspaceDir: string, state: RemindersState): Promise<void> {
  await fs.writeFile(
    path.join(workspaceDir, "reminders.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

function missingFields(state: RemindersState): RemindersField[] {
  const missing: RemindersField[] = [];
  if (!state.settings.timezone?.trim()) {
    missing.push("timezone");
  }
  const snooze = state.settings.defaultSnoozeMin;
  if (typeof snooze !== "number" || !Number.isFinite(snooze) || snooze <= 0) {
    missing.push("defaultSnoozeMin");
  }
  return missing;
}

function promptFor(field: RemindersField): string {
  if (field === "timezone") {
    return [
      "Before we continue, quick reminders onboarding.",
      "Quick reply in one line:",
      "timezone: ...",
      "- Use an IANA timezone like America/Los_Angeles.",
    ].join("\n");
  }
  return [
    "Before we continue, quick reminders onboarding.",
    "Quick reply in one line:",
    "defaultSnoozeMin: ...",
    "- Default snooze minutes (for example 10).",
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
  field: RemindersField,
  body: string,
): Promise<string | number | null> {
  const modelRefRaw =
    resolveAgentModelPrimary(context.cfg, "reminders") ??
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
- timezone => {"timezone":"America/Los_Angeles"}
- defaultSnoozeMin => {"defaultSnoozeMin":10}
If unknown return {}.`;
  try {
    const response = await completeSimple(
      resolved.model,
      {
        systemPrompt,
        messages: [{ role: "user", content: body, timestamp: Date.now() }],
      },
      buildCompleteSimpleOptions({
        model: resolved.model,
        apiKey,
        temperature: 0,
        maxTokens: 120,
      }),
    );
    const text = extractCompletionText(response);
    const json = extractJsonObject(text);
    if (!json) {
      return null;
    }
    if (field === "timezone") {
      const value = json.timezone;
      return typeof value === "string" && value.trim() ? value.trim() : null;
    }
    const snooze = json.defaultSnoozeMin;
    return typeof snooze === "number" && Number.isFinite(snooze) && snooze > 0
      ? Math.round(snooze)
      : null;
  } catch {
    return null;
  }
}

export const REMINDERS_ONBOARDING_HANDLER: AgentOnboardingHandler = {
  agentId: "reminders",
  async initializeFiles(context: AgentOnboardingContext): Promise<void> {
    await fs.mkdir(context.workspaceDir, { recursive: true });
    const remindersPath = path.join(context.workspaceDir, "reminders.json");
    const notesPath = path.join(context.workspaceDir, "reminders-notes.txt");
    const memoPath = memoPathForUser(context.workspaceDir, context.userIdentifier);
    try {
      await fs.access(remindersPath);
    } catch {
      await writeRemindersState(context.workspaceDir, DEFAULT_REMINDERS_STATE);
    }
    try {
      await fs.access(notesPath);
    } catch {
      await fs.writeFile(notesPath, "", "utf8");
    }
    try {
      await fs.access(memoPath);
    } catch {
      await fs.writeFile(memoPath, "# Reminders Preferences\n\n", "utf8");
    }
  },
  async maybeHandleOnboarding(
    context: AgentOnboardingContext,
  ): Promise<ReplyPayload | ReplyPayload[] | undefined> {
    const state = await readRemindersState(context.workspaceDir);
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
    const next: RemindersState = {
      schemaVersion: 1,
      settings: {
        ...state.settings,
        [field]: value,
      },
      reminders: state.reminders,
    };
    await writeRemindersState(context.workspaceDir, next);
    const remaining = missingFields(next);
    if (remaining.length > 0) {
      return { text: promptFor(remaining[0]) };
    }
    return { text: "Reminders onboarding saved. You can ask me to set reminders now." };
  },
};
