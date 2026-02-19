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
import { emitAgentEvent } from "../infra/agent-events.js";
import { logModelIo } from "../logging/model-io.js";
import { resolveModelRefFromString, parseModelRef } from "../models/model-selection.js";
import { resolveOpenClawAgentDir } from "../runtime/agent-paths.js";
import { resolveAgentConfig } from "../runtime/agent-scope.js";
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

/**
 * Run the full agent flow: Router → SimpleResponder (if simple) or Complex path (if complex).
 */
export async function runAgentFlow(
  params: RunAgentFlowParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const { cleanedBody, sessionKey, provider, model, cfg, defaultProvider, aliasIndex } = params;
  const routingCfg = cfg?.agents?.defaults?.routing;
  const enabled = Boolean(routingCfg?.enabled);
  const classifierModelRaw = (routingCfg?.classifierModel ?? "").trim();

  console.log(`[runAgentFlow] user input: ${cleanedBody.length} chars`);
  logModelIo(log.info.bind(log), "user input", cleanedBody, true);

  const directAgentId = (params.runPreparedReplyParams.agentId ?? "").trim().toLowerCase();
  if (!enabled && directAgentId && directAgentId !== "main") {
    console.log(
      `[runAgentFlow] routing disabled; bypassing classifier and using direct agent=${directAgentId}`,
    );
    if (directAgentId === "calendar") {
      return runCalendarReply({
        ...params.runPreparedReplyParams,
        provider,
        model,
      });
    }
    if (directAgentId === "reminders") {
      return runRemindersReply({
        ...params.runPreparedReplyParams,
        provider,
        model,
      });
    }
    if (directAgentId === "mail") {
      return runMailReply({
        ...params.runPreparedReplyParams,
        provider,
        model,
      });
    }
    if (directAgentId === "workouts") {
      return runWorkoutsReply({
        ...params.runPreparedReplyParams,
        provider,
        model,
      });
    }
    if (directAgentId === "finance") {
      return runFinanceReply({
        ...params.runPreparedReplyParams,
        provider,
        model,
      });
    }
    if (directAgentId === "multi") {
      return runMultiReply({
        ...params.runPreparedReplyParams,
        provider,
        model,
      });
    }
  }

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

  const routerAgent = new RouterAgent(modelResolver);
  const routerOutput = await executeAgent(
    routerAgent,
    {
      userIdentifier: params.userIdentifier ?? sessionKey,
      message: cleanedBody,
      context: { sessionKey },
    },
    { recordTrace: true },
  );

  const specializedTiers = [
    "calendar",
    "reminders",
    "mail",
    "workouts",
    "finance",
    "multi",
  ] as const;
  const tier =
    routerOutput.decision === "stay"
      ? "simple"
      : specializedTiers.includes(routerOutput.decision as (typeof specializedTiers)[number])
        ? (routerOutput.decision as (typeof specializedTiers)[number])
        : "complex";
  const runId = crypto.randomUUID();

  console.log(`[runAgentFlow] Router model call 1: decision=${routerOutput.decision} tier=${tier}`);

  // Resolve provider/model for simple tier (classifier model override)
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
  }

  emitAgentEvent({
    runId,
    stream: "routing",
    data: {
      decision: routerOutput.decision,
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
        message: cleanedBody,
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
      (simpleOutput.tokenUsage.input !== undefined || simpleOutput.tokenUsage.output !== undefined)
        ? ` input=${simpleOutput.tokenUsage.input ?? "?"} output=${simpleOutput.tokenUsage.output ?? "?"}`
        : "";
    console.log(
      `[runAgentFlow] SimpleResponder model call 2: ${effectiveProvider}/${effectiveModel} response=${outLen} chars${usageStr}`,
    );

    return {
      text: responseText,
    };
  }

  // ─── STEP 2b: Specialized agent paths ────────────────────────────────────
  if (tier === "calendar") {
    console.log("[runAgentFlow] calendar path: invoking runCalendarReply");
    return runCalendarReply({
      ...params.runPreparedReplyParams,
      provider: effectiveProvider,
      model: effectiveModel,
    });
  }
  if (tier === "reminders") {
    console.log("[runAgentFlow] reminders path: invoking runRemindersReply");
    return runRemindersReply({
      ...params.runPreparedReplyParams,
      provider: effectiveProvider,
      model: effectiveModel,
    });
  }
  if (tier === "mail") {
    console.log("[runAgentFlow] mail path: invoking runMailReply");
    return runMailReply({
      ...params.runPreparedReplyParams,
      provider: effectiveProvider,
      model: effectiveModel,
    });
  }
  if (tier === "workouts") {
    console.log("[runAgentFlow] workouts path: invoking runWorkoutsReply");
    return runWorkoutsReply({
      ...params.runPreparedReplyParams,
      provider: effectiveProvider,
      model: effectiveModel,
    });
  }
  if (tier === "finance") {
    console.log("[runAgentFlow] finance path: invoking runFinanceReply");
    return runFinanceReply({
      ...params.runPreparedReplyParams,
      provider: effectiveProvider,
      model: effectiveModel,
    });
  }
  if (tier === "multi") {
    const multiConfig = resolveAgentConfig(cfg ?? {}, "multi");
    const allowAgents = multiConfig?.subagents?.allowAgents ?? [];
    const allowSet = new Set(allowAgents.map((a) => a.trim().toLowerCase()).filter(Boolean));
    const allowAny = allowSet.has("*");
    const requestedAgents = (routerOutput.agents ?? []).map((a) => a.trim().toLowerCase());
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
      return runComplexReply({
        ...params.runPreparedReplyParams,
        provider: effectiveProvider,
        model: effectiveModel,
      });
    }
    console.log(
      `[runAgentFlow] multi path: invoking runMultiReply orchestrateAgents=${orchestrateAgents?.join(",") ?? "default"}`,
    );
    return runMultiReply({
      ...params.runPreparedReplyParams,
      provider: effectiveProvider,
      model: effectiveModel,
      orchestrateAgents,
    });
  }

  // ─── STEP 2c: Complex path → Invoke Complex agent ────────────────────────
  console.log(
    `[runAgentFlow] complex path: invoking runComplexReply (agent=${params.runPreparedReplyParams.agentId})`,
  );
  return runComplexReply({
    ...params.runPreparedReplyParams,
    provider: effectiveProvider,
    model: effectiveModel,
  });
}
