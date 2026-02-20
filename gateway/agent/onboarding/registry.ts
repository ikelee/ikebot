import type { AgentOnboardingHandler } from "./types.js";
import { CALENDAR_ONBOARDING_HANDLER } from "../agents/calendar/onboarding.js";
import { FINANCE_ONBOARDING_HANDLER } from "../agents/finance/onboarding.js";
import { MAIL_ONBOARDING_HANDLER } from "../agents/mail/onboarding.js";
import { MULTI_ONBOARDING_HANDLER } from "../agents/multi/onboarding.js";
import { REMINDERS_ONBOARDING_HANDLER } from "../agents/reminders/onboarding.js";
import { WORKOUTS_ONBOARDING_HANDLER } from "../agents/workouts/onboarding.js";

const HANDLERS = new Map<string, AgentOnboardingHandler>(
  [
    CALENDAR_ONBOARDING_HANDLER,
    REMINDERS_ONBOARDING_HANDLER,
    MAIL_ONBOARDING_HANDLER,
    WORKOUTS_ONBOARDING_HANDLER,
    FINANCE_ONBOARDING_HANDLER,
    MULTI_ONBOARDING_HANDLER,
  ].map((handler) => [handler.agentId, handler]),
);

export function getOnboardingHandler(agentId: string): AgentOnboardingHandler | undefined {
  return HANDLERS.get(agentId.trim().toLowerCase());
}
