import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentOnboardingContext, AgentOnboardingHandler } from "../../onboarding/types.js";
import type { ReplyPayload } from "../../pipeline/types.js";

type CalendarState = {
  schemaVersion: number;
  profile: {
    calendarId?: string;
    timezone?: string;
    defaultDurationMin?: number;
  };
};

const execFileAsync = promisify(execFile);

const DEFAULT_CALENDAR_STATE: CalendarState = {
  schemaVersion: 1,
  profile: {
    calendarId: "",
    timezone: "",
    defaultDurationMin: 30,
  },
};

function memoPathForUser(workspaceDir: string, userIdentifier: string): string {
  const safe = userIdentifier
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return path.join(workspaceDir, safe ? `calendar-memo-${safe}.md` : "calendar-memo-default.md");
}

async function readCalendarState(workspaceDir: string): Promise<CalendarState> {
  const file = path.join(workspaceDir, "calendar-settings.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<CalendarState>;
    return {
      schemaVersion: 1,
      profile: {
        ...DEFAULT_CALENDAR_STATE.profile,
        ...parsed?.profile,
      },
    };
  } catch {
    return DEFAULT_CALENDAR_STATE;
  }
}

async function writeCalendarState(workspaceDir: string, state: CalendarState): Promise<void> {
  await fs.writeFile(
    path.join(workspaceDir, "calendar-settings.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

function missingFields(state: CalendarState): Array<"calendarId" | "timezone"> {
  const missing: Array<"calendarId" | "timezone"> = [];
  if (!state.profile.calendarId?.trim()) {
    missing.push("calendarId");
  }
  if (!state.profile.timezone?.trim()) {
    missing.push("timezone");
  }
  return missing;
}

async function hasGogCalendarAuth(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("gog", ["auth", "list", "--plain"], {
      timeout: 4000,
      env: { ...process.env, HOME: os.homedir() },
    });
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.some((line) => /\bcalendar\b/i.test(line));
  } catch {
    return false;
  }
}

function notReadyReply(missing: Array<"calendarId" | "timezone">, hasAuth: boolean): ReplyPayload {
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`Missing calendar settings: ${missing.join(", ")}`);
  }
  if (!hasAuth) {
    problems.push("Google Calendar auth is not configured in gog.");
  }
  return {
    text: [
      "Calendar agent is not ready yet.",
      "Setup required (manual):",
      "1. gog auth credentials /path/to/client_secret.json",
      "2. gog auth add you@gmail.com --services calendar",
      "3. Update calendar-settings.json profile.calendarId and profile.timezone",
      `Status: ${problems.join(" | ")}`,
    ].join("\n"),
  };
}

export const CALENDAR_ONBOARDING_HANDLER: AgentOnboardingHandler = {
  agentId: "calendar",
  async initializeFiles(context: AgentOnboardingContext): Promise<void> {
    await fs.mkdir(context.workspaceDir, { recursive: true });
    const settingsPath = path.join(context.workspaceDir, "calendar-settings.json");
    const notesPath = path.join(context.workspaceDir, "calendar-notes.txt");
    const memoPath = memoPathForUser(context.workspaceDir, context.userIdentifier);
    try {
      await fs.access(settingsPath);
    } catch {
      await writeCalendarState(context.workspaceDir, DEFAULT_CALENDAR_STATE);
    }
    try {
      await fs.access(notesPath);
    } catch {
      await fs.writeFile(notesPath, "", "utf8");
    }
    try {
      await fs.access(memoPath);
    } catch {
      await fs.writeFile(memoPath, "# Calendar Preferences\n\n", "utf8");
    }
  },
  async maybeHandleOnboarding(
    context: AgentOnboardingContext,
  ): Promise<ReplyPayload | ReplyPayload[] | undefined> {
    const state = await readCalendarState(context.workspaceDir);
    const missing = missingFields(state);
    const authReady = await hasGogCalendarAuth();
    if (missing.length === 0 && authReady) {
      return undefined;
    }
    return notReadyReply(missing, authReady);
  },
};
