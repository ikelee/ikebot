/**
 * Agent Flow Orchestration
 *
 * This is the single entry point for all agent invocation. The flow is:
 * 1. Invoke Router Agent (Phase 1 classifier)
 * 2. If simple → Invoke SimpleResponderAgent, return reply
 * 3. If complex → Invoke complex path (runPreparedReply → runReplyAgent → runEmbeddedAttempt)
 *
 * All agent orchestration lives here for easy flow tracing.
 */

import crypto from "node:crypto";
import type { OpenClawConfig } from "../infra/config/config.js";
import type { ModelAliasIndex } from "../models/model-selection.js";
import type { ReplyPayload } from "./pipeline/types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { logModelIo } from "../logging/model-io.js";
import { resolveModelRefFromString, parseModelRef } from "../models/model-selection.js";
import { resolveOpenClawAgentDir } from "../runtime/agent-paths.js";
import { log } from "../runtime/pi-embedded-runner/logger.js";
import { resolveModel } from "../runtime/pi-embedded-runner/model.js";
import { RouterAgent, type RouterAgentModelResolver } from "./agents/router.js";
import { SimpleResponderAgent } from "./agents/simple-responder.js";
import { executeAgent } from "./core/agent-executor.js";
import { runPreparedReply } from "./pipeline/reply/reply-building/get-reply-run.js";

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
  /** Full params for runPreparedReply when we take complex path */
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

  const tier = routerOutput.decision === "stay" ? "simple" : "complex";
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

  // ─── STEP 2b: Complex path → Invoke runPreparedReply (full agent) ────────
  console.log(`[runAgentFlow] complex path: invoking runPreparedReply`);
  return runPreparedReply({
    ...params.runPreparedReplyParams,
    provider: effectiveProvider,
    model: effectiveModel,
    replyTier: "complex",
  });
}
