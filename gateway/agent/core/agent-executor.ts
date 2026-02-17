/**
 * Agent executor: runs agents with tracing, error handling, and observability.
 */

import { randomUUID } from "node:crypto";
import type { Agent, AgentExecutionContext, AgentInput, AgentOutput, AgentTrace } from "./agent.js";
import { getGlobalAgentRegistry } from "./agent-registry.js";

export interface ExecuteAgentOptions {
  /** Parent agent ID if this is a delegated execution */
  parentAgentId?: string;
  /** Configuration to pass to the agent */
  config?: Record<string, unknown>;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Whether to record trace (default: true) */
  recordTrace?: boolean;
}

/**
 * Execute an agent with full tracing and error handling.
 */
export async function executeAgent(
  agent: Agent,
  input: AgentInput,
  options: ExecuteAgentOptions = {},
): Promise<AgentOutput> {
  const executionId = randomUUID();
  const startedAt = Date.now();

  const context: AgentExecutionContext = {
    executionId,
    startedAt,
    parentAgentId: options.parentAgentId,
    config: options.config,
    abortSignal: options.abortSignal,
  };

  let output: AgentOutput = {
    durationMs: 0,
  };
  let error: string | undefined;

  try {
    // Check if aborted before starting
    if (options.abortSignal?.aborted) {
      throw new Error("Agent execution aborted before start");
    }

    // Execute the agent
    output = await agent.execute(input, context);

    // Add duration if not already set
    if (!output.durationMs) {
      output.durationMs = Date.now() - startedAt;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    output = {
      response: undefined,
      metadata: {
        error: error,
        failed: true,
      },
      durationMs: Date.now() - startedAt,
    };
    // Re-throw to let caller handle
    throw err;
  } finally {
    // Record trace (even if failed)
    if (options.recordTrace !== false) {
      const trace: AgentTrace = {
        agentId: agent.config.id,
        agentName: agent.config.name,
        executionId,
        parentAgentId: options.parentAgentId,
        input,
        output,
        startedAt,
        completedAt: Date.now(),
        durationMs: output.durationMs ?? Date.now() - startedAt,
        modelTier: agent.config.model.tier,
        modelUsed: agent.config.model.modelId,
        error,
      };

      const registry = getGlobalAgentRegistry();
      registry.recordTrace(trace);
    }
  }

  return output;
}

/**
 * Execute an agent by ID (looks up in registry).
 */
export async function executeAgentById(
  agentId: string,
  input: AgentInput,
  options: ExecuteAgentOptions = {},
): Promise<AgentOutput> {
  const registry = getGlobalAgentRegistry();
  const agent = registry.get(agentId);

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  return executeAgent(agent, input, options);
}
