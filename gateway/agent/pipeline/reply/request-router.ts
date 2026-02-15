/**
 * Tiered request router: runs Phase 1 (gate) then applies config.
 * Phase 1 decides stay (Phase 1 handles it) or escalate (hand off to Phase 2).
 * When routing is enabled and Phase 1 says stay, we override provider/model to the classifier model.
 * See docs/reference/tiered-model-routing.md and phases/routing/phase-1.ts.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import crypto from "node:crypto";
import type { OpenClawConfig } from "../../../infra/config/config.js";
import type { ModelAliasIndex } from "../../../models/model-selection.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { resolveModelRefFromString, parseModelRef } from "../../../models/model-selection.js";
import { resolveOpenClawAgentDir } from "../../../runtime/agent-paths.js";
import { resolveModel } from "../../../runtime/pi-embedded-runner/model.js";
import { phase1Classify } from "./phases/routing/index.js";

export type RequestRouterParams = {
  /** Normalized user message body (e.g. cleanedBody). */
  cleanedBody: string;
  sessionKey: string;
  /** Current provider/model from config/directives (before routing). */
  provider: string;
  model: string;
  cfg: OpenClawConfig;
  defaultProvider: string;
  aliasIndex: ModelAliasIndex;
};

export type RequestRouterResult =
  | { useDefault: true }
  | {
      useDefault: false;
      tier: "simple" | "complex";
      provider: string;
      model: string;
    };

/**
 * Route the request: Phase 1 classifies (stay | escalate); when routing is enabled
 * and classifier model is set, overrides provider/model for stay. Emits a routing
 * event for dashboard observability (tier: simple = stay, complex = escalate).
 */
export async function routeRequest(params: RequestRouterParams): Promise<RequestRouterResult> {
  const routeStartTime = Date.now();
  const { cleanedBody, sessionKey, provider, model, cfg, defaultProvider, aliasIndex } = params;
  const routingCfg = cfg?.agents?.defaults?.routing;
  const enabled = Boolean(routingCfg?.enabled);
  const classifierModelRaw = (routingCfg?.classifierModel ?? "").trim();

  console.log(`[router] route start: body="${cleanedBody.slice(0, 50)}..."`);

  // Resolve classifier model if configured
  let classifierModel: Model<Api> | undefined;

  if (enabled && classifierModelRaw) {
    const modelResolveStart = Date.now();
    try {
      const modelRef = parseModelRef(classifierModelRaw, defaultProvider);
      if (modelRef) {
        const agentDir = resolveOpenClawAgentDir();
        const resolved = resolveModel(modelRef.provider, modelRef.model, agentDir, cfg);

        if (!resolved.model) {
          throw new Error(
            resolved.error ?? `Model not found: ${modelRef.provider}/${modelRef.model}`,
          );
        }

        classifierModel = resolved.model;
      }
      console.log(`[router] model resolved in ${Date.now() - modelResolveStart}ms`);
    } catch (err) {
      console.error(`[router] Failed to create classifier model:`, err);
      // Re-throw so we know if routing is broken
      throw err;
    }
  }

  const classifyStart = Date.now();
  const phase1 = await phase1Classify({
    body: cleanedBody,
    config: cfg,
    model: classifierModel,
  });
  console.log(`[router] phase1 classification took ${Date.now() - classifyStart}ms`);
  const tier = phase1.decision === "stay" ? "simple" : "complex";
  const runId = crypto.randomUUID();

  const emit = (overridden: boolean, usedProvider: string, usedModel: string) => {
    emitAgentEvent({
      runId,
      stream: "routing",
      data: {
        decision: phase1.decision,
        tier,
        sessionKey,
        provider: usedProvider,
        model: usedModel,
        overridden,
        bodyPreview: cleanedBody.slice(0, 80),
      },
    });
  };

  if (!enabled || !classifierModelRaw) {
    emit(false, provider, model);
    return { useDefault: true };
  }

  if (phase1.decision === "escalate") {
    emit(false, provider, model);
    return { useDefault: true };
  }

  const resolved = resolveModelRefFromString({
    raw: classifierModelRaw,
    defaultProvider,
    aliasIndex,
  });
  if (!resolved?.ref) {
    emit(false, provider, model);
    return { useDefault: true };
  }

  emit(true, resolved.ref.provider, resolved.ref.model);
  const routeTotalMs = Date.now() - routeStartTime;
  console.log(`[router] route complete: tier=${tier} totalMs=${routeTotalMs}`);
  return {
    useDefault: false,
    tier: "simple",
    provider: resolved.ref.provider,
    model: resolved.ref.model,
  };
}
