/**
 * Agent Flow Orchestration
 *
 * This is the single entry point for all agent invocation. All agents live under
 * gateway/agent/agents/:
 * 1. Router (classifier) → stay | escalate | calendar
 * 2. Simple → SimpleResponderAgent
 * 3. Calendar → runCalendarReply
 * 4. Complex → runComplexReply (full Pi path)
 */

import crypto from "node:crypto";
import type { OpenClawConfig } from "../infra/config/config.js";
import type { ModelAliasIndex } from "../models/model-selection.js";
import type { runPreparedReply } from "./pipeline/reply/reply-building/get-reply-run.js";
import type { ReplyPayload } from "./pipeline/types.js";
import {
  emitAgentEvent,
  getAgentRunContext,
  registerAgentRunContext,
} from "../infra/agent-events.js";
import {
  beginUserInput,
  endAgentLoop,
  endUserInput,
  ensureAgentLoop,
} from "../infra/agent-telemetry.js";
import { formatUtcTimestamp } from "../infra/format-time/format-datetime.js";
import { logModelIo } from "../logging/model-io.js";
import { resolveModelRefFromString, parseModelRef } from "../models/model-selection.js";
import { resolveOpenClawAgentDir } from "../runtime/agent-paths.js";
import {
  resolveAgentConfig,
  resolveAgentModelPrimary,
  resolveAgentWorkspaceDir,
} from "../runtime/agent-scope.js";
import { log } from "../runtime/pi-embedded-runner/logger.js";
import { resolveModel } from "../runtime/pi-embedded-runner/model.js";
import { runCalendarReply } from "./agents/calendar/index.js";
import { RouterAgent, type RouterAgentModelResolver } from "./agents/classifier/agent.js";
import { runComplexReply } from "./agents/complex/index.js";
import { runFinanceReply } from "./agents/finance/index.js";
import { runMailReply } from "./agents/mail/index.js";
import { runMultiReply } from "./agents/multi/index.js";
import { runRemindersReply } from "./agents/reminders/index.js";
import { SimpleResponderAgent } from "./agents/simple-responder/agent.js";
import { runWorkoutsReply } from "./agents/workouts/index.js";
import { executeAgent } from "./core/agent-executor.js";
import { maybeRunAgentOnboarding } from "./onboarding/service.js";

export type RunAgentFlowParams = {
  /** Normalized user message body - used for Router and SimpleResponder */
  cleanedBody: string;
  /** Session key for routing/context */
  sessionKey: string;
  /** Current provider/model (before routing override) */
  provider: string;
  model: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  cfg: OpenClawConfig;
  /** Full params for complex/calendar path */
  runPreparedReplyParams: Parameters<typeof runPreparedReply>[0];
  /** User identifier for agent context */
  userIdentifier?: string;
};

const TOP_LEVEL_ONBOARDING_PATTERNS: Array<{ agentId: string; re: RegExp }> = [
  {
    agentId: "workouts",
    re: /\b(?:onboard|setup|set up|configure|initialize|init)\s+(?:the\s+)?(?:workouts?|fitness|gym)(?:\s+agent)?\b/i,
  },
  {
    agentId: "calendar",
    re: /\b(?:onboard|setup|set up|configure|initialize|init)\s+(?:the\s+)?calendar(?:\s+agent)?\b/i,
  },
  {
    agentId: "mail",
    re: /\b(?:onboard|setup|set up|configure|initialize|init)\s+(?:the\s+)?(?:mail|email)(?:\s+agent)?\b/i,
  },
  {
    agentId: "finance",
    re: /\b(?:onboard|setup|set up|configure|initialize|init)\s+(?:the\s+)?(?:finance|money|budget)(?:\s+agent)?\b/i,
  },
  {
    agentId: "reminders",
    re: /\b(?:onboard|setup|set up|configure|initialize|init)\s+(?:the\s+)?reminders?(?:\s+agent)?\b/i,
  },
  {
    agentId: "multi",
    re: /\b(?:onboard|setup|set up|configure|initialize|init)\s+(?:the\s+)?multi(?:\s+agent)?\b/i,
  },
  {
    agentId: "workouts",
    re: /\b(?:program|goals?|bodyweight|body weight|style|coachingstyle|coaching style|equipment|daysperweek|days\/week)\s*:/i,
  },
  {
    agentId: "workouts",
    re: /^\s*(?:5\s*\/?\s*3\s*\/?\s*1|531|ppl|upper\s*\/?\s*lower|full\s*body)\s*$/i,
  },
  {
    agentId: "workouts",
    re: /^\s*(?:supportive|assertive|aggressive)\s*$/i,
  },
  {
    agentId: "workouts",
    re: /^\s*\d+(?:\.\d+)?\s*(?:lb|lbs|kg)\s*$/i,
  },
];

const ACTIVE_ONBOARDING_BY_SESSION = new Map<string, string>();
const ACTIVE_ONBOARDING_BY_USER = new Map<string, string>();
const ACTIVE_SPECIALIZED_AGENT_BY_SESSION = new Map<string, { agentId: string; at: number }>();
const ACTIVE_SPECIALIZED_AGENT_BY_USER = new Map<string, { agentId: string; at: number }>();
type RouterHold = {
  agentId: string;
  acquiredAt: number;
  updatedAt: number;
  reason?: string;
};
const ROUTER_HOLDS_BY_SESSION = new Map<string, RouterHold[]>();
const ROUTER_HOLDS_BY_USER = new Map<string, RouterHold[]>();
const ROUTER_PENDING_HOLDS_BY_SESSION = new Map<string, string[]>();
const ROUTER_PENDING_HOLDS_BY_USER = new Map<string, string[]>();
const ROUTER_HOLD_TTL_MS = 30 * 60 * 1000;
const SPECIALIZED_FOLLOW_UP_WINDOW_MS = 10 * 60 * 1000;
const CONFIRMATION_FOLLOW_UP_RE =
  /^(?:yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|do it|go ahead|please do|proceed|sounds good|that works)\b/i;
const ROUTING_CONTEXT_WRAPPER_RE =
  /\n+Conversation info \(context only;[^\n]*\)\s*\n```json[\s\S]*?```/gi;
const ROUTING_CONTEXT_MARKER_RE = /Conversation info \(context only;/i;
const BRACKETED_TIMESTAMP_PREFIX_RE = /^\[[^\]]+\]\s*/;
const ROUTER_HOLD_DIRECTIVE_RE =
  /\[\[router_hold:(acquire|release)(?:\s+reason=(["']?)([^"'\]]+)\2)?\s*\]\]/gi;
const ROUTER_HANDOFF_DIRECTIVE_RE =
  /\[\[router_handoff:([a-z0-9_-]+)(?:\s+reason=(["']?)([^"'\]]+)\2)?\s*\]\]/gi;
const FOLLOWUP_PROMPT_RE =
  /\b(?:please\s+confirm|confirm(?:ation)?|should\s+i|do\s+you\s+want\s+me\s+to|is\s+that\s+right|is\s+that\s+correct|would\s+you\s+like\s+me\s+to|can\s+you\s+confirm)\b/i;
const CALENDAR_CONFIRMATION_FASTPATH_HINT =
  "Router confirmation fast-path: user confirmed the pending calendar action. Execute the already pending calendar mutation now with an exec call. Do not ask for confirmation again unless execution fails.";
const NEXT_WEEKDAY_RE = /\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;
const WEEKDAY_TO_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};
const MONTH_TO_INDEX: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const TZ_ABBR_TO_OFFSET_MINUTES: Record<string, number> = {
  UTC: 0,
  PST: -8 * 60,
  PDT: -7 * 60,
};

type ParsedAnchor = {
  date: Date;
  tzOffsetMinutes: number;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatIsoDateUtc(date: Date): string {
  return formatUtcTimestamp(date).slice(0, 10);
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  return `${sign}${pad2(hh)}:${pad2(mm)}`;
}

function toIsoLocalWithOffset(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  offsetMinutes: number,
): string {
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00${formatOffset(offsetMinutes)}`;
}

function formatUtcIsoWithSeconds(date: Date): string {
  return formatUtcTimestamp(date, { displaySeconds: true });
}

function extractAnchor(cleanedBody: string): ParsedAnchor {
  const stamped = cleanedBody.match(
    /\[[^\]]*?(\d{4})-(\d{2})-(\d{2})(?:\s+\d{2}:\d{2}\s+([A-Z]{2,4}))?[^\]]*?\]/,
  );
  if (stamped) {
    const year = Number(stamped[1]);
    const month = Number(stamped[2]);
    const day = Number(stamped[3]);
    const tzAbbr = (stamped[4] ?? "").toUpperCase();
    const tzOffsetMinutes =
      typeof TZ_ABBR_TO_OFFSET_MINUTES[tzAbbr] === "number"
        ? TZ_ABBR_TO_OFFSET_MINUTES[tzAbbr]
        : -new Date().getTimezoneOffset();
    if (
      Number.isInteger(year) &&
      Number.isInteger(month) &&
      Number.isInteger(day) &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    ) {
      // Noon UTC avoids accidental day rollovers while keeping weekday math deterministic.
      return {
        date: new Date(Date.UTC(year, month - 1, day, 12, 0, 0)),
        tzOffsetMinutes,
      };
    }
  }
  return {
    date: new Date(),
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
  };
}

function resolveNextWeekdayDate(anchor: Date, targetDay: number): Date {
  const currentDay = anchor.getUTCDay();
  let delta = (targetDay - currentDay + 7) % 7;
  if (delta === 0) {
    delta = 7;
  }
  const result = new Date(anchor.getTime());
  result.setUTCDate(result.getUTCDate() + delta);
  return result;
}

function extractRequestedTime(
  cleanedBody: string,
): { hour24: number; minute: number; label: string } | null {
  const compact = cleanedBody.match(/\b(?:at\s+)?(\d{3,4})\s*(am|pm)\b/i);
  if (compact) {
    const digits = compact[1] ?? "";
    const meridiem = (compact[2] ?? "").toLowerCase();
    if (/^\d{3,4}$/.test(digits)) {
      const hourDigits = digits.length === 3 ? digits.slice(0, 1) : digits.slice(0, 2);
      const minuteDigits = digits.slice(-2);
      const rawHour = Number(hourDigits);
      const minute = Number(minuteDigits);
      if (
        Number.isInteger(rawHour) &&
        Number.isInteger(minute) &&
        rawHour >= 1 &&
        rawHour <= 12 &&
        minute >= 0 &&
        minute <= 59
      ) {
        const hour24 = (rawHour % 12) + (meridiem === "pm" ? 12 : 0);
        return {
          hour24,
          minute,
          label: `${rawHour}:${pad2(minute)}${meridiem}`,
        };
      }
    }
  }

  const match = cleanedBody.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match) {
    return null;
  }
  const rawHour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (!Number.isInteger(rawHour) || !Number.isInteger(minute) || rawHour < 1 || rawHour > 12) {
    return null;
  }
  if (minute < 0 || minute > 59) {
    return null;
  }
  const meridiem = (match[3] ?? "").toLowerCase();
  const hour24 = (rawHour % 12) + (meridiem === "pm" ? 12 : 0);
  return {
    hour24,
    minute,
    label: `${rawHour}:${pad2(minute)}${meridiem}`,
  };
}

function extractRequestedDurationMinutes(cleanedBody: string): number | null {
  const hourWord = cleanedBody.match(/\bfor\s+an?\s+hour\b/i);
  if (hourWord) {
    return 60;
  }
  const hourCount = cleanedBody.match(/\bfor\s+(\d+(?:\.\d+)?)\s*hours?\b/i);
  if (hourCount) {
    const hours = Number(hourCount[1]);
    if (Number.isFinite(hours) && hours > 0) {
      return Math.round(hours * 60);
    }
  }
  const minuteCount = cleanedBody.match(/\bfor\s+(\d+)\s*(?:m|min|mins|minute|minutes)\b/i);
  if (minuteCount) {
    const minutes = Number(minuteCount[1]);
    if (Number.isInteger(minutes) && minutes > 0) {
      return minutes;
    }
  }
  return null;
}

function addMinutesToClock(
  hour24: number,
  minute: number,
  minutesToAdd: number,
): { hour24: number; minute: number } {
  const total = hour24 * 60 + minute + minutesToAdd;
  const wrapped = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  return { hour24: Math.floor(wrapped / 60), minute: wrapped % 60 };
}

function extractRequestedTimeWithoutMeridiem(
  cleanedBody: string,
): { hour24: number; minute: number; label: string } | null {
  const compactRangeNoMeridiem = cleanedBody.match(/\b(\d{3,4})\s*-\s*(\d{3,4})\b/);
  const compactToken = compactRangeNoMeridiem?.[1];
  const compactNoMeridiem = cleanedBody.match(/\b(?:at\s+)?(\d{3,4})(?!\s*(?:am|pm))\b/i);
  const digits = compactToken ?? compactNoMeridiem?.[1];
  if (!digits) {
    return null;
  }
  if (!/^\d{3,4}$/.test(digits)) {
    return null;
  }
  const hourDigits = digits.length === 3 ? digits.slice(0, 1) : digits.slice(0, 2);
  const minuteDigits = digits.slice(-2);
  const rawHour = Number(hourDigits);
  const minute = Number(minuteDigits);
  if (
    !Number.isInteger(rawHour) ||
    !Number.isInteger(minute) ||
    rawHour < 1 ||
    rawHour > 12 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  // For compact time without meridiem in scheduling phrasing (e.g. 530-730),
  // assume PM to avoid morning misfires.
  const hour24 = rawHour % 12 === 0 ? 12 : (rawHour % 12) + 12;
  return {
    hour24,
    minute,
    label: `${rawHour}:${pad2(minute)}pm (assumed)`,
  };
}

function extractRequestedTimeWindow(cleanedBody: string): {
  start: { hour24: number; minute: number; label: string };
  end?: { hour24: number; minute: number; label: string };
} | null {
  const compactRangeNoMeridiem = cleanedBody.match(/\b(\d{3,4})\s*-\s*(\d{3,4})\b/);
  if (compactRangeNoMeridiem) {
    const startDigits = compactRangeNoMeridiem[1] ?? "";
    const endDigits = compactRangeNoMeridiem[2] ?? "";
    const parseAssumedPm = (
      digits: string,
    ): { hour24: number; minute: number; label: string } | null => {
      if (!/^\d{3,4}$/.test(digits)) {
        return null;
      }
      const hourDigits = digits.length === 3 ? digits.slice(0, 1) : digits.slice(0, 2);
      const minuteDigits = digits.slice(-2);
      const rawHour = Number(hourDigits);
      const minute = Number(minuteDigits);
      if (
        !Number.isInteger(rawHour) ||
        !Number.isInteger(minute) ||
        rawHour < 1 ||
        rawHour > 12 ||
        minute < 0 ||
        minute > 59
      ) {
        return null;
      }
      const hour24 = rawHour % 12 === 0 ? 12 : (rawHour % 12) + 12;
      return {
        hour24,
        minute,
        label: `${rawHour}:${pad2(minute)}pm (assumed)`,
      };
    };
    const start = parseAssumedPm(startDigits);
    const end = parseAssumedPm(endDigits);
    if (start && end) {
      return { start, end };
    }
  }

  const start =
    extractRequestedTime(cleanedBody) ?? extractRequestedTimeWithoutMeridiem(cleanedBody);
  if (!start) {
    return null;
  }
  const durationMinutes = extractRequestedDurationMinutes(cleanedBody);
  if (!durationMinutes) {
    return { start };
  }
  const endClock = addMinutesToClock(start.hour24, start.minute, durationMinutes);
  return {
    start,
    end: {
      hour24: endClock.hour24,
      minute: endClock.minute,
      label: `${pad2(endClock.hour24)}:${pad2(endClock.minute)} (from duration ${durationMinutes}m)`,
    },
  };
}

function collectAbsoluteMonthDayDates(
  cleanedBody: string,
  anchor: ParsedAnchor,
): Array<{
  phrase: string;
  date: Date;
}> {
  const out: Array<{ phrase: string; date: Date }> = [];
  const re =
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/gi;
  let match: RegExpExecArray | null = re.exec(cleanedBody);
  while (match) {
    const monthToken = (match[1] ?? "").toLowerCase();
    const month = MONTH_TO_INDEX[monthToken];
    const day = Number(match[2]);
    if (!month || !Number.isInteger(day) || day < 1 || day > 31) {
      match = re.exec(cleanedBody);
      continue;
    }
    let year = Number(match[3]);
    if (!Number.isInteger(year)) {
      year = anchor.date.getUTCFullYear();
      const candidate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
      const anchorDay = new Date(
        Date.UTC(
          anchor.date.getUTCFullYear(),
          anchor.date.getUTCMonth(),
          anchor.date.getUTCDate(),
          12,
          0,
          0,
        ),
      );
      if (candidate.getTime() < anchorDay.getTime()) {
        year += 1;
      }
    }
    out.push({
      phrase: (match[0] ?? "").trim().toLowerCase(),
      date: new Date(Date.UTC(year, month - 1, day, 12, 0, 0)),
    });
    match = re.exec(cleanedBody);
  }
  return out;
}

function augmentCalendarPromptWithDateHints(cleanedBody: string): string {
  const hints: string[] = [];
  const seen = new Set<string>();
  const anchor = extractAnchor(cleanedBody);
  const requestedWindow = extractRequestedTimeWindow(cleanedBody);
  const requestedTime = requestedWindow?.start;
  let emittedExactWindow = false;
  NEXT_WEEKDAY_RE.lastIndex = 0;
  let match: RegExpExecArray | null = NEXT_WEEKDAY_RE.exec(cleanedBody);
  while (match) {
    const weekday = (match[1] ?? "").toLowerCase();
    const index = WEEKDAY_TO_INDEX[weekday];
    if (index !== undefined) {
      const date = resolveNextWeekdayDate(anchor.date, index);
      const normalizedPhrase = `next ${weekday}`;
      const line = `${normalizedPhrase} = ${formatIsoDateUtc(date)}`;
      if (!seen.has(line)) {
        seen.add(line);
        hints.push(line);
      }
      if (requestedTime) {
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth() + 1;
        const day = date.getUTCDate();
        const localIso = toIsoLocalWithOffset(
          year,
          month,
          day,
          requestedTime.hour24,
          requestedTime.minute,
          anchor.tzOffsetMinutes,
        );
        const utcMillis =
          Date.UTC(year, month - 1, day, requestedTime.hour24, requestedTime.minute, 0) -
          anchor.tzOffsetMinutes * 60 * 1000;
        const utcIso = formatUtcIsoWithSeconds(new Date(utcMillis));
        const timeLine = `${normalizedPhrase} at ${requestedTime.label} local = ${localIso} (UTC ${utcIso})`;
        if (!seen.has(timeLine)) {
          seen.add(timeLine);
          hints.push(timeLine);
        }
        if (requestedWindow?.end) {
          const endLocalIso = toIsoLocalWithOffset(
            year,
            month,
            day,
            requestedWindow.end.hour24,
            requestedWindow.end.minute,
            anchor.tzOffsetMinutes,
          );
          const endUtcMillis =
            Date.UTC(
              year,
              month - 1,
              day,
              requestedWindow.end.hour24,
              requestedWindow.end.minute,
              0,
            ) -
            anchor.tzOffsetMinutes * 60 * 1000;
          const endUtcIso = formatUtcIsoWithSeconds(new Date(endUtcMillis));
          const endLine = `${normalizedPhrase} ends at ${requestedWindow.end.label} local = ${endLocalIso} (UTC ${endUtcIso})`;
          if (!seen.has(endLine)) {
            seen.add(endLine);
            hints.push(endLine);
          }
          const exactLine = `${normalizedPhrase} execution UTC window: --from ${utcIso} --to ${endUtcIso}`;
          if (!seen.has(exactLine)) {
            seen.add(exactLine);
            hints.push(exactLine);
            emittedExactWindow = true;
          }
        }
      }
    }
    match = NEXT_WEEKDAY_RE.exec(cleanedBody);
  }

  for (const absolute of collectAbsoluteMonthDayDates(cleanedBody, anchor)) {
    const line = `${absolute.phrase} = ${formatIsoDateUtc(absolute.date)}`;
    if (!seen.has(line)) {
      seen.add(line);
      hints.push(line);
    }
    if (requestedTime) {
      const year = absolute.date.getUTCFullYear();
      const month = absolute.date.getUTCMonth() + 1;
      const day = absolute.date.getUTCDate();
      const localIso = toIsoLocalWithOffset(
        year,
        month,
        day,
        requestedTime.hour24,
        requestedTime.minute,
        anchor.tzOffsetMinutes,
      );
      const utcMillis =
        Date.UTC(year, month - 1, day, requestedTime.hour24, requestedTime.minute, 0) -
        anchor.tzOffsetMinutes * 60 * 1000;
      const utcIso = formatUtcIsoWithSeconds(new Date(utcMillis));
      const timeLine = `${absolute.phrase} at ${requestedTime.label} local = ${localIso} (UTC ${utcIso})`;
      if (!seen.has(timeLine)) {
        seen.add(timeLine);
        hints.push(timeLine);
      }
      if (requestedWindow?.end) {
        const endLocalIso = toIsoLocalWithOffset(
          year,
          month,
          day,
          requestedWindow.end.hour24,
          requestedWindow.end.minute,
          anchor.tzOffsetMinutes,
        );
        const endUtcMillis =
          Date.UTC(
            year,
            month - 1,
            day,
            requestedWindow.end.hour24,
            requestedWindow.end.minute,
            0,
          ) -
          anchor.tzOffsetMinutes * 60 * 1000;
        const endUtcIso = formatUtcIsoWithSeconds(new Date(endUtcMillis));
        const endLine = `${absolute.phrase} ends at ${requestedWindow.end.label} local = ${endLocalIso} (UTC ${endUtcIso})`;
        if (!seen.has(endLine)) {
          seen.add(endLine);
          hints.push(endLine);
        }
        const exactLine = `${absolute.phrase} execution UTC window: --from ${utcIso} --to ${endUtcIso}`;
        if (!seen.has(exactLine)) {
          seen.add(exactLine);
          hints.push(exactLine);
          emittedExactWindow = true;
        }
      }
    }
  }

  if (hints.length === 0) {
    return cleanedBody;
  }

  if (emittedExactWindow) {
    hints.push(
      "Execution rule: for calendar create/update commands, use the exact UTC --from/--to window above; do not reinterpret timezone.",
    );
  }

  return `${cleanedBody}\n\nCalendar date hints (deterministic):\n${hints.map((h) => `- ${h}`).join("\n")}`;
}

function withCalendarDateHints(
  preparedParams: Parameters<typeof runPreparedReply>[0],
  cleanedBody: string,
): Parameters<typeof runPreparedReply>[0] {
  const augmented = augmentCalendarPromptWithDateHints(cleanedBody);
  if (augmented === cleanedBody) {
    return preparedParams;
  }
  return {
    ...preparedParams,
    sessionCtx: {
      ...preparedParams.sessionCtx,
      BodyForAgent: augmented,
      Body: augmented,
      BodyStripped: augmented,
    },
  };
}

function withCalendarConfirmationFastPathHint(
  preparedParams: Parameters<typeof runPreparedReply>[0],
  cleanedBody: string,
): Parameters<typeof runPreparedReply>[0] {
  const augmented = `${cleanedBody}\n\n${CALENDAR_CONFIRMATION_FASTPATH_HINT}`;
  return {
    ...preparedParams,
    sessionCtx: {
      ...preparedParams.sessionCtx,
      BodyForAgent: augmented,
      Body: augmented,
      BodyStripped: augmented,
    },
  };
}

export function __resetOnboardingStateForTests(): void {
  ACTIVE_ONBOARDING_BY_SESSION.clear();
  ACTIVE_ONBOARDING_BY_USER.clear();
  ACTIVE_SPECIALIZED_AGENT_BY_SESSION.clear();
  ACTIVE_SPECIALIZED_AGENT_BY_USER.clear();
  ROUTER_HOLDS_BY_SESSION.clear();
  ROUTER_HOLDS_BY_USER.clear();
  ROUTER_PENDING_HOLDS_BY_SESSION.clear();
  ROUTER_PENDING_HOLDS_BY_USER.clear();
}

function resolveOnboardingSessionKey(userIdentifier: string, sessionKey: string): string {
  return `${userIdentifier}::${sessionKey}`;
}

function resolveTopLevelOnboardingAgentId(cleanedBody: string): string | null {
  const body = cleanedBody.trim();
  if (!body) {
    return null;
  }
  for (const entry of TOP_LEVEL_ONBOARDING_PATTERNS) {
    if (entry.re.test(body)) {
      return entry.agentId;
    }
  }
  return null;
}

function normalizeRoutingBody(cleanedBody: string): string {
  const withoutContextWrapper = cleanedBody.replace(ROUTING_CONTEXT_WRAPPER_RE, "");
  const markerIndex = withoutContextWrapper.search(ROUTING_CONTEXT_MARKER_RE);
  const withoutMarkerTail =
    markerIndex >= 0 ? withoutContextWrapper.slice(0, markerIndex) : withoutContextWrapper;
  return withoutMarkerTail.replace(BRACKETED_TIMESTAMP_PREFIX_RE, "").trim();
}

function getHolds(store: Map<string, RouterHold[]>, key: string): RouterHold[] {
  const now = Date.now();
  const holds = (store.get(key) ?? []).filter((hold) => now - hold.updatedAt <= ROUTER_HOLD_TTL_MS);
  if (holds.length > 0) {
    store.set(key, holds);
  } else {
    store.delete(key);
  }
  return holds;
}

function currentRouterHold(sessionKey: string, userKey: string): RouterHold | undefined {
  const sessionHolds = getHolds(ROUTER_HOLDS_BY_SESSION, sessionKey);
  if (sessionHolds.length > 0) {
    return sessionHolds[0];
  }
  const userHolds = getHolds(ROUTER_HOLDS_BY_USER, userKey);
  return userHolds[0];
}

function upsertRouterHold(
  store: Map<string, RouterHold[]>,
  key: string,
  agentId: string,
  reason?: string,
): void {
  const now = Date.now();
  const existing = getHolds(store, key)[0];
  if (existing && existing.agentId === agentId) {
    existing.updatedAt = now;
    if (reason) {
      existing.reason = reason;
    }
    store.set(key, [existing]);
    return;
  }

  // Mutex semantics: new holder replaces any previous holder.
  store.set(key, [{ agentId, acquiredAt: now, updatedAt: now, reason }]);
}

function releaseRouterHold(store: Map<string, RouterHold[]>, key: string, agentId: string): void {
  const holds = getHolds(store, key).filter((hold) => hold.agentId !== agentId);
  if (holds.length === 0) {
    store.delete(key);
    return;
  }
  store.set(key, holds);
}

function getPendingHolds(store: Map<string, string[]>, key: string): string[] {
  const queue = (store.get(key) ?? []).filter(Boolean);
  if (queue.length > 0) {
    store.set(key, queue);
  } else {
    store.delete(key);
  }
  return queue;
}

function enqueuePendingHold(store: Map<string, string[]>, key: string, agentId: string): void {
  const queue = getPendingHolds(store, key);
  const normalized = agentId.trim().toLowerCase();
  if (!normalized) {
    return;
  }
  if (!queue.includes(normalized)) {
    queue.push(normalized);
  }
  store.set(key, queue);
}

function shiftPendingHold(store: Map<string, string[]>, key: string): string | undefined {
  const queue = getPendingHolds(store, key);
  const next = queue.shift();
  if (queue.length > 0) {
    store.set(key, queue);
  } else {
    store.delete(key);
  }
  return next;
}

function removePendingAgentOnce(store: Map<string, string[]>, key: string, agentId: string): void {
  const queue = getPendingHolds(store, key);
  const idx = queue.indexOf(agentId);
  if (idx < 0) {
    return;
  }
  queue.splice(idx, 1);
  if (queue.length > 0) {
    store.set(key, queue);
  } else {
    store.delete(key);
  }
}

function activateNextPendingHold(sessionKey: string, userKey: string): RouterHold | undefined {
  const nextSession = shiftPendingHold(ROUTER_PENDING_HOLDS_BY_SESSION, sessionKey);
  if (nextSession) {
    removePendingAgentOnce(ROUTER_PENDING_HOLDS_BY_USER, userKey, nextSession);
    upsertRouterHold(ROUTER_HOLDS_BY_SESSION, sessionKey, nextSession, "handoff");
    upsertRouterHold(ROUTER_HOLDS_BY_USER, userKey, nextSession, "handoff");
    return currentRouterHold(sessionKey, userKey);
  }
  const nextUser = shiftPendingHold(ROUTER_PENDING_HOLDS_BY_USER, userKey);
  if (nextUser) {
    removePendingAgentOnce(ROUTER_PENDING_HOLDS_BY_SESSION, sessionKey, nextUser);
    upsertRouterHold(ROUTER_HOLDS_BY_SESSION, sessionKey, nextUser, "handoff");
    upsertRouterHold(ROUTER_HOLDS_BY_USER, userKey, nextUser, "handoff");
    return currentRouterHold(sessionKey, userKey);
  }
  return undefined;
}

function isFollowUpPromptText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (FOLLOWUP_PROMPT_RE.test(trimmed)) {
    return true;
  }
  return trimmed.endsWith("?") && trimmed.length <= 320;
}

function applyRouterHoldDirectivesToText(text: string): {
  text: string;
  acquireReason?: string;
  release: boolean;
  acquire: boolean;
  handoffAgents: string[];
} {
  let acquireReason: string | undefined;
  let release = false;
  let acquire = false;
  const handoffAgents: string[] = [];
  const withoutHold = text.replace(
    ROUTER_HOLD_DIRECTIVE_RE,
    (_, action: string, _q: string, reason: string) => {
      if (action === "acquire") {
        acquire = true;
        acquireReason = reason?.trim() || acquireReason;
      } else if (action === "release") {
        release = true;
      }
      return "";
    },
  );
  const stripped = withoutHold.replace(
    ROUTER_HANDOFF_DIRECTIVE_RE,
    (_full: string, agentId: string) => {
      const normalized = agentId?.trim().toLowerCase();
      if (normalized) {
        handoffAgents.push(normalized);
      }
      return "";
    },
  );
  return { text: stripped.trim(), acquireReason, release, acquire, handoffAgents };
}

function extractPayloads(reply: ReplyPayload | ReplyPayload[] | undefined): ReplyPayload[] {
  if (!reply) {
    return [];
  }
  return Array.isArray(reply) ? reply : [reply];
}

/**
 * Run the full agent flow: Router → SimpleResponder (if simple) or Complex path (if complex).
 */
export async function runAgentFlow(
  params: RunAgentFlowParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const { cleanedBody, sessionKey, provider, model, cfg, defaultProvider, aliasIndex } = params;
  const routingBody = normalizeRoutingBody(cleanedBody);
  const routingCfg = cfg?.agents?.defaults?.routing;
  const enabled = Boolean(routingCfg?.enabled);
  const classifierModelRaw = (routingCfg?.classifierModel ?? "").trim();
  const runId = params.runPreparedReplyParams.opts?.runId ?? crypto.randomUUID();
  const existingRunContext = getAgentRunContext(runId);
  const isInfrastructureRun =
    params.runPreparedReplyParams.opts?.isHeartbeat === true ||
    existingRunContext?.isHeartbeat === true;
  if (isInfrastructureRun) {
    console.log(`[runAgentFlow] infrastructure input: ${cleanedBody.length} chars`);
  } else {
    console.log(`[runAgentFlow] user input: ${cleanedBody.length} chars`);
    logModelIo(log.info.bind(log), "user input", cleanedBody, true);
  }
  const preparedReplyParamsWithRunId = {
    ...params.runPreparedReplyParams,
    opts: {
      ...params.runPreparedReplyParams.opts,
      runId,
    },
  };
  const userInputId = isInfrastructureRun
    ? undefined
    : beginUserInput({
        runId,
        sessionKey,
        bodyChars: cleanedBody.length,
      });
  registerAgentRunContext(runId, { sessionKey, ...(userInputId ? { userInputId } : {}) });
  let userInputStatus: "ok" | "error" = "ok";
  let userInputError: string | undefined;

  const directAgentId = (params.runPreparedReplyParams.agentId ?? "").trim().toLowerCase();

  const maybeHandleOnboarding = async (
    agentId: string,
    body: string = routingBody,
  ): Promise<ReplyPayload | ReplyPayload[] | undefined> =>
    maybeRunAgentOnboarding({
      agentId,
      cleanedBody: body,
      workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
      cfg,
      userIdentifier: params.userIdentifier ?? sessionKey,
      sessionKey,
    });

  try {
    const userScopeKey = params.userIdentifier ?? sessionKey;
    const onboardingSessionKey = resolveOnboardingSessionKey(userScopeKey, sessionKey);
    const holdSessionKey = onboardingSessionKey;
    const holdUserKey = userScopeKey;
    const activeOnboardingAgentId =
      ACTIVE_ONBOARDING_BY_SESSION.get(onboardingSessionKey) ??
      ACTIVE_ONBOARDING_BY_USER.get(userScopeKey);

    const runOnboardingStep = async (
      agentId: string,
    ): Promise<{ reply: ReplyPayload | ReplyPayload[] | undefined; complete: boolean }> => {
      const reply = await maybeHandleOnboarding(agentId, cleanedBody);
      if (!reply) {
        return { reply: undefined, complete: true };
      }
      const completionProbe = await maybeHandleOnboarding(agentId, "");
      return { reply, complete: completionProbe === undefined };
    };

    const trackOnboardingProgress = (agentId: string, complete: boolean): void => {
      if (complete) {
        ACTIVE_ONBOARDING_BY_SESSION.delete(onboardingSessionKey);
        ACTIVE_ONBOARDING_BY_USER.delete(userScopeKey);
        releaseRouterHold(ROUTER_HOLDS_BY_SESSION, holdSessionKey, agentId);
        releaseRouterHold(ROUTER_HOLDS_BY_USER, holdUserKey, agentId);
        return;
      }
      ACTIVE_ONBOARDING_BY_SESSION.set(onboardingSessionKey, agentId);
      ACTIVE_ONBOARDING_BY_USER.set(userScopeKey, agentId);
      upsertRouterHold(ROUTER_HOLDS_BY_SESSION, holdSessionKey, agentId, "onboarding");
      upsertRouterHold(ROUTER_HOLDS_BY_USER, holdUserKey, agentId, "onboarding");
    };

    const ensureSpecializedLoop = (agentId: string): string => {
      if (!userInputId) {
        return "";
      }
      const agentLoopId = ensureAgentLoop({
        runId,
        userInputId,
        sessionKey: holdSessionKey,
        agentId,
      });
      registerAgentRunContext(runId, {
        sessionKey: holdSessionKey,
        userInputId,
        agentLoopId,
        agentId,
      });
      return agentLoopId;
    };
    const endSpecializedLoop = (params: {
      agentId: string;
      status: "ok" | "error" | "aborted";
      error?: string;
    }): void => {
      if (!userInputId) {
        return;
      }
      endAgentLoop({
        runId,
        sessionKey: holdSessionKey,
        agentId: params.agentId,
        status: params.status,
        error: params.error,
      });
    };

    const runDirectSpecialized = async (
      agentId: "calendar" | "reminders" | "mail" | "workouts" | "finance" | "multi",
      invoke: () => Promise<ReplyPayload | ReplyPayload[] | undefined>,
    ): Promise<ReplyPayload | ReplyPayload[] | undefined> => {
      ensureSpecializedLoop(agentId);
      const { reply: onboardingReply, complete } = await runOnboardingStep(agentId);
      if (onboardingReply) {
        trackOnboardingProgress(agentId, complete);
        endSpecializedLoop({ agentId, status: "ok" });
        return onboardingReply;
      }
      try {
        const reply = await invoke();
        endSpecializedLoop({ agentId, status: "ok" });
        return reply;
      } catch (err) {
        endSpecializedLoop({
          agentId,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };

    if (activeOnboardingAgentId) {
      const { reply, complete } = await runOnboardingStep(activeOnboardingAgentId);
      trackOnboardingProgress(activeOnboardingAgentId, complete);
      if (reply) {
        console.log(
          `[runAgentFlow] active onboarding intercepted for agent=${activeOnboardingAgentId}`,
        );
        return reply;
      }
    }

    const topLevelOnboardingAgentId = resolveTopLevelOnboardingAgentId(routingBody);
    if (topLevelOnboardingAgentId) {
      const { reply: onboardingReply, complete } =
        await runOnboardingStep(topLevelOnboardingAgentId);
      if (onboardingReply) {
        trackOnboardingProgress(topLevelOnboardingAgentId, complete);
        console.log(
          `[runAgentFlow] top-level onboarding intercepted for agent=${topLevelOnboardingAgentId}`,
        );
        return onboardingReply;
      }
    }

    if (!enabled && directAgentId && directAgentId !== "main") {
      console.log(
        `[runAgentFlow] routing disabled; bypassing classifier and using direct agent=${directAgentId}`,
      );
      if (directAgentId === "calendar") {
        return await runDirectSpecialized("calendar", async () =>
          runCalendarReply({
            ...withCalendarDateHints(preparedReplyParamsWithRunId, cleanedBody),
            provider,
            model,
          }),
        );
      }
      if (directAgentId === "reminders") {
        return await runDirectSpecialized("reminders", async () =>
          runRemindersReply({
            ...preparedReplyParamsWithRunId,
            provider,
            model,
          }),
        );
      }
      if (directAgentId === "mail") {
        return await runDirectSpecialized("mail", async () =>
          runMailReply({
            ...preparedReplyParamsWithRunId,
            provider,
            model,
          }),
        );
      }
      if (directAgentId === "workouts") {
        return await runDirectSpecialized("workouts", async () =>
          runWorkoutsReply({
            ...preparedReplyParamsWithRunId,
            provider,
            model,
          }),
        );
      }
      if (directAgentId === "finance") {
        return await runDirectSpecialized("finance", async () =>
          runFinanceReply({
            ...preparedReplyParamsWithRunId,
            provider,
            model,
          }),
        );
      }
      if (directAgentId === "multi") {
        return await runDirectSpecialized("multi", async () =>
          runMultiReply({
            ...preparedReplyParamsWithRunId,
            provider,
            model,
          }),
        );
      }
    }

    const applyRouterHoldState = (
      agentId: string,
      reply: ReplyPayload | ReplyPayload[] | undefined,
    ): ReplyPayload | ReplyPayload[] | undefined => {
      const payloads = extractPayloads(reply);
      if (payloads.length === 0) {
        releaseRouterHold(ROUTER_HOLDS_BY_SESSION, holdSessionKey, agentId);
        releaseRouterHold(ROUTER_HOLDS_BY_USER, holdUserKey, agentId);
        endSpecializedLoop({ agentId, status: "ok" });
        return reply;
      }

      let sawAcquire = false;
      let sawRelease = false;
      let acquireReason: string | undefined;
      let sawFollowupPrompt = false;
      const handoffAgents = new Set<string>();

      for (const payload of payloads) {
        if (!payload?.text) {
          continue;
        }
        const directive = applyRouterHoldDirectivesToText(payload.text);
        payload.text = directive.text;
        sawAcquire = sawAcquire || directive.acquire;
        sawRelease = sawRelease || directive.release;
        for (const handoff of directive.handoffAgents) {
          handoffAgents.add(handoff);
        }
        if (directive.acquireReason) {
          acquireReason = directive.acquireReason;
        }
        sawFollowupPrompt = sawFollowupPrompt || isFollowUpPromptText(directive.text);
      }

      if (handoffAgents.size > 0) {
        for (const handoff of handoffAgents) {
          enqueuePendingHold(ROUTER_PENDING_HOLDS_BY_SESSION, holdSessionKey, handoff);
          enqueuePendingHold(ROUTER_PENDING_HOLDS_BY_USER, holdUserKey, handoff);
        }
        console.log(
          `[runAgentFlow] router handoff queued by agent=${agentId} -> ${Array.from(handoffAgents).join(",")}`,
        );
      }

      if (sawRelease) {
        releaseRouterHold(ROUTER_HOLDS_BY_SESSION, holdSessionKey, agentId);
        releaseRouterHold(ROUTER_HOLDS_BY_USER, holdUserKey, agentId);
        endSpecializedLoop({ agentId, status: "ok" });
        console.log(`[runAgentFlow] router hold released by agent=${agentId}`);
        const next = activateNextPendingHold(holdSessionKey, holdUserKey);
        if (next) {
          console.log(
            `[runAgentFlow] router handoff activated next holder=${next.agentId} reason=${next.reason ?? "handoff"}`,
          );
        }
        return reply;
      }

      if (sawAcquire || sawFollowupPrompt) {
        const reason = acquireReason ?? (sawFollowupPrompt ? "followup_prompt" : undefined);
        upsertRouterHold(ROUTER_HOLDS_BY_SESSION, holdSessionKey, agentId, reason);
        upsertRouterHold(ROUTER_HOLDS_BY_USER, holdUserKey, agentId, reason);
        console.log(
          `[runAgentFlow] router hold acquired by agent=${agentId}${reason ? ` reason=${reason}` : ""}`,
        );
        return reply;
      }

      releaseRouterHold(ROUTER_HOLDS_BY_SESSION, holdSessionKey, agentId);
      releaseRouterHold(ROUTER_HOLDS_BY_USER, holdUserKey, agentId);
      endSpecializedLoop({ agentId, status: "ok" });
      return reply;
    };

    // ─── STEP 1: Invoke Router Agent ─────────────────────────────────────────
    const modelResolver: RouterAgentModelResolver = async () => {
      if (!enabled || !classifierModelRaw) {
        return undefined;
      }
      const modelRef = parseModelRef(classifierModelRaw, defaultProvider);
      if (!modelRef) {
        return undefined;
      }
      const agentDir = resolveOpenClawAgentDir();
      const resolved = resolveModel(modelRef.provider, modelRef.model, agentDir, cfg);
      if (!resolved.model) {
        return undefined;
      }
      return resolved.model;
    };

    const specializedTiers = [
      "calendar",
      "reminders",
      "mail",
      "workouts",
      "finance",
      "multi",
    ] as const;
    let hold = currentRouterHold(holdSessionKey, holdUserKey);
    if (!hold) {
      hold = activateNextPendingHold(holdSessionKey, holdUserKey);
      if (hold) {
        console.log(
          `[runAgentFlow] router pending handoff activated holder=${hold.agentId} reason=${hold.reason ?? "handoff"}`,
        );
      }
    }
    let routerDecision: string = "stay";
    let tier:
      | "simple"
      | "calendar"
      | "reminders"
      | "mail"
      | "workouts"
      | "finance"
      | "multi"
      | "complex";
    let requestedAgents: string[] = [];
    let classifierInvoked = false;

    if (hold) {
      tier = hold.agentId as typeof tier;
      console.log(
        `[runAgentFlow] router hold override: tier=${tier} reason=${hold.reason ?? "unspecified"} (classifier bypassed)`,
      );
    } else {
      classifierInvoked = true;
      const routerAgent = new RouterAgent(modelResolver);
      const routerOutput = await executeAgent(
        routerAgent,
        {
          userIdentifier: params.userIdentifier ?? sessionKey,
          message: routingBody,
          context: { sessionKey },
        },
        { recordTrace: true },
      );
      const routedDecision = routerOutput.decision ?? "stay";
      routerDecision = routedDecision;
      requestedAgents = (routerOutput.agents ?? []).map((a) => a.trim().toLowerCase());

      tier =
        routedDecision === "stay"
          ? "simple"
          : specializedTiers.includes(routedDecision as (typeof specializedTiers)[number])
            ? (routedDecision as (typeof specializedTiers)[number])
            : "complex";
      const activeSpecialized =
        ACTIVE_SPECIALIZED_AGENT_BY_SESSION.get(onboardingSessionKey) ??
        ACTIVE_SPECIALIZED_AGENT_BY_USER.get(userScopeKey);
      const confirmationLike =
        routingBody.length <= 40 && CONFIRMATION_FOLLOW_UP_RE.test(routingBody);
      if (
        tier === "simple" &&
        confirmationLike &&
        activeSpecialized &&
        Date.now() - activeSpecialized.at <= SPECIALIZED_FOLLOW_UP_WINDOW_MS
      ) {
        tier = activeSpecialized.agentId as typeof tier;
        console.log(
          `[runAgentFlow] follow-up continuity override: decision=stay -> ${activeSpecialized.agentId}`,
        );
      }
    }
    if (classifierInvoked) {
      console.log(`[runAgentFlow] Router model call 1: decision=${routerDecision} tier=${tier}`);
    } else {
      console.log(`[runAgentFlow] Router classifier skipped (hold active): tier=${tier}`);
    }

    // Resolve provider/model for this turn.
    // Priority:
    // 1) simple tier uses classifier model (if configured)
    // 2) specialized tiers use per-agent model.primary (if configured)
    // 3) otherwise keep caller/session model
    let effectiveProvider = provider;
    let effectiveModel = model;
    if (tier === "simple" && enabled && classifierModelRaw) {
      const resolved = resolveModelRefFromString({
        raw: classifierModelRaw,
        defaultProvider,
        aliasIndex,
      });
      if (resolved?.ref) {
        effectiveProvider = resolved.ref.provider;
        effectiveModel = resolved.ref.model;
      }
    } else if (tier !== "complex") {
      const agentPrimary = resolveAgentModelPrimary(cfg, tier);
      if (agentPrimary) {
        const resolved = resolveModelRefFromString({
          raw: agentPrimary,
          defaultProvider,
          aliasIndex,
        });
        if (resolved?.ref) {
          effectiveProvider = resolved.ref.provider;
          effectiveModel = resolved.ref.model;
        }
      }
    }

    emitAgentEvent({
      runId,
      stream: "routing",
      data: {
        decision: tier === "simple" ? routerDecision : tier,
        tier,
        sessionKey,
        provider: effectiveProvider,
        model: effectiveModel,
        overridden: tier === "simple" && effectiveProvider !== provider,
        bodyPreview: cleanedBody.slice(0, 80),
      },
    });

    // ─── STEP 2a: Simple path → Invoke SimpleResponderAgent ──────────────────
    if (tier === "simple") {
      const agentDir = resolveOpenClawAgentDir();
      const modelResolved = resolveModel(effectiveProvider, effectiveModel, agentDir, cfg);
      if (!modelResolved.model) {
        throw new Error(
          modelResolved.error ??
            `Simple path: model not found: ${effectiveProvider}/${effectiveModel}`,
        );
      }

      const simpleAgent = new SimpleResponderAgent();
      const simpleOutput = await executeAgent(
        simpleAgent,
        {
          userIdentifier: params.userIdentifier ?? sessionKey,
          message: routingBody,
          context: {
            userTimezone: "UTC",
            sessionKey,
            config: cfg,
            model: {
              provider: effectiveProvider,
              modelId: effectiveModel,
              resolved: modelResolved.model,
            },
          },
        },
        { recordTrace: true },
      );

      const responseText = simpleOutput.response ?? "";
      const outLen = responseText.length;
      const usageStr =
        simpleOutput.tokenUsage &&
        (simpleOutput.tokenUsage.input !== undefined ||
          simpleOutput.tokenUsage.output !== undefined)
          ? ` input=${simpleOutput.tokenUsage.input ?? "?"} output=${simpleOutput.tokenUsage.output ?? "?"}`
          : "";
      console.log(
        `[runAgentFlow] SimpleResponder model call 2: ${effectiveProvider}/${effectiveModel} response=${outLen} chars${usageStr}`,
      );

      return {
        text: responseText,
      };
    }

    if (
      tier === "calendar" ||
      tier === "reminders" ||
      tier === "mail" ||
      tier === "workouts" ||
      tier === "finance"
    ) {
      const active = { agentId: tier, at: Date.now() };
      ACTIVE_SPECIALIZED_AGENT_BY_SESSION.set(onboardingSessionKey, active);
      ACTIVE_SPECIALIZED_AGENT_BY_USER.set(userScopeKey, active);
    }

    // ─── STEP 2b: Specialized agent paths ────────────────────────────────────
    if (tier === "calendar") {
      ensureSpecializedLoop("calendar");
      console.log("[runAgentFlow] calendar path: invoking runCalendarReply");
      const { reply: onboardingReply, complete } = await runOnboardingStep("calendar");
      if (onboardingReply) {
        trackOnboardingProgress("calendar", complete);
        return onboardingReply;
      }
      const confirmationLike =
        routingBody.length <= 40 && CONFIRMATION_FOLLOW_UP_RE.test(routingBody);
      const confirmationHoldReason = (hold?.reason ?? "").toLowerCase();
      const shouldFastPathConfirmation =
        hold?.agentId === "calendar" &&
        confirmationLike &&
        (confirmationHoldReason.includes("confirm") ||
          confirmationHoldReason === "followup_prompt");
      const calendarParams = shouldFastPathConfirmation
        ? withCalendarConfirmationFastPathHint(preparedReplyParamsWithRunId, cleanedBody)
        : preparedReplyParamsWithRunId;
      const reply = await runCalendarReply({
        ...withCalendarDateHints(calendarParams, cleanedBody),
        provider: effectiveProvider,
        model: effectiveModel,
      });
      return applyRouterHoldState("calendar", reply);
    }
    if (tier === "reminders") {
      ensureSpecializedLoop("reminders");
      console.log("[runAgentFlow] reminders path: invoking runRemindersReply");
      const { reply: onboardingReply, complete } = await runOnboardingStep("reminders");
      if (onboardingReply) {
        trackOnboardingProgress("reminders", complete);
        return onboardingReply;
      }
      const reply = await runRemindersReply({
        ...preparedReplyParamsWithRunId,
        provider: effectiveProvider,
        model: effectiveModel,
      });
      return applyRouterHoldState("reminders", reply);
    }
    if (tier === "mail") {
      ensureSpecializedLoop("mail");
      console.log("[runAgentFlow] mail path: invoking runMailReply");
      const { reply: onboardingReply, complete } = await runOnboardingStep("mail");
      if (onboardingReply) {
        trackOnboardingProgress("mail", complete);
        return onboardingReply;
      }
      const reply = await runMailReply({
        ...preparedReplyParamsWithRunId,
        provider: effectiveProvider,
        model: effectiveModel,
      });
      return applyRouterHoldState("mail", reply);
    }
    if (tier === "workouts") {
      ensureSpecializedLoop("workouts");
      console.log("[runAgentFlow] workouts path: invoking runWorkoutsReply");
      const { reply: onboardingReply, complete } = await runOnboardingStep("workouts");
      if (onboardingReply) {
        trackOnboardingProgress("workouts", complete);
        return onboardingReply;
      }
      const reply = await runWorkoutsReply({
        ...preparedReplyParamsWithRunId,
        provider: effectiveProvider,
        model: effectiveModel,
      });
      return applyRouterHoldState("workouts", reply);
    }
    if (tier === "finance") {
      ensureSpecializedLoop("finance");
      console.log("[runAgentFlow] finance path: invoking runFinanceReply");
      const { reply: onboardingReply, complete } = await runOnboardingStep("finance");
      if (onboardingReply) {
        trackOnboardingProgress("finance", complete);
        return onboardingReply;
      }
      const reply = await runFinanceReply({
        ...preparedReplyParamsWithRunId,
        provider: effectiveProvider,
        model: effectiveModel,
      });
      return applyRouterHoldState("finance", reply);
    }
    if (tier === "multi") {
      ensureSpecializedLoop("multi");
      const { reply: onboardingReply, complete } = await runOnboardingStep("multi");
      if (onboardingReply) {
        trackOnboardingProgress("multi", complete);
        return onboardingReply;
      }
      const multiConfig = resolveAgentConfig(cfg ?? {}, "multi");
      const allowAgents = multiConfig?.subagents?.allowAgents ?? [];
      const allowSet = new Set(allowAgents.map((a) => a.trim().toLowerCase()).filter(Boolean));
      const allowAny = allowSet.has("*");
      const allAllowed =
        allowAny || (requestedAgents.length > 0 && requestedAgents.every((a) => allowSet.has(a)));
      const orchestrateAgents = allAllowed
        ? requestedAgents.length > 0
          ? requestedAgents
          : Array.from(allowSet).filter((a) => a !== "*")
        : undefined;
      if (!orchestrateAgents?.length && requestedAgents.length > 0) {
        console.log(
          `[runAgentFlow] multi requested agents ${requestedAgents.join(",")} not all in allowlist; falling back to escalate`,
        );
        return await runComplexReply({
          ...preparedReplyParamsWithRunId,
          provider: effectiveProvider,
          model: effectiveModel,
        });
      }
      console.log(
        `[runAgentFlow] multi path: invoking runMultiReply orchestrateAgents=${orchestrateAgents?.join(",") ?? "default"}`,
      );
      return await runMultiReply({
        ...preparedReplyParamsWithRunId,
        provider: effectiveProvider,
        model: effectiveModel,
        orchestrateAgents,
      });
    }

    // ─── STEP 2c: Complex path → Invoke Complex agent ────────────────────────
    console.log(
      `[runAgentFlow] complex path: invoking runComplexReply (agent=${params.runPreparedReplyParams.agentId})`,
    );
    return await runComplexReply({
      ...withCalendarDateHints(preparedReplyParamsWithRunId, cleanedBody),
      provider: effectiveProvider,
      model: effectiveModel,
    });
  } catch (err) {
    userInputStatus = "error";
    userInputError = err instanceof Error ? err.message : String(err);
    const activeAgentId =
      getAgentRunContext(runId)?.agentId ??
      (params.runPreparedReplyParams.agentId ?? "").trim().toLowerCase();
    if (userInputId && activeAgentId && activeAgentId !== "main") {
      endAgentLoop({
        runId,
        sessionKey,
        agentId: activeAgentId,
        status: "error",
        error: userInputError,
      });
    }
    throw err;
  } finally {
    if (userInputId) {
      endUserInput({
        runId,
        status: userInputStatus,
        error: userInputError,
      });
    }
  }
}
