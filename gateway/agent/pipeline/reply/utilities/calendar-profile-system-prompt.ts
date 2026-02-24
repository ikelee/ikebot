import fs from "node:fs/promises";
import path from "node:path";

type CalendarSettings = {
  profile?: {
    calendarId?: string;
    timezone?: string;
  };
};

function normalizeOneLine(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  return compact.slice(0, 200);
}

export async function buildCalendarProfileSystemPrompt(params: {
  agentId?: string;
  workspaceDir: string;
}): Promise<string> {
  if (params.agentId !== "calendar") {
    return "";
  }
  const settingsPath = path.join(params.workspaceDir, "calendar-settings.json");
  let parsed: CalendarSettings | undefined;
  try {
    parsed = JSON.parse(await fs.readFile(settingsPath, "utf8")) as CalendarSettings;
  } catch {
    return "";
  }

  const calendarId = normalizeOneLine(parsed?.profile?.calendarId);
  const timezone = normalizeOneLine(parsed?.profile?.timezone);
  if (!calendarId && !timezone) {
    return "";
  }

  return [
    "## Calendar Profile (trusted workspace config)",
    calendarId ? `calendarId: ${calendarId}` : "",
    timezone ? `timezone: ${timezone}` : "",
    "Use these values directly unless the user overrides them.",
    "Do not run `pwd`, `ls`, or `cat calendar-settings.json` before the first `gog` command.",
    "Read-window requests: first tool call should be one `gog calendar events ... --from ... --to ...` command.",
    "If a `gog` call fails with config/auth errors, do at most one diagnostic read, then retry once.",
  ]
    .filter(Boolean)
    .join("\n");
}
