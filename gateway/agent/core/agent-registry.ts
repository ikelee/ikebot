/**
 * Agent registry: tracks all available agents and their capabilities.
 */

import type { Agent, AgentConfig, AgentTrace } from "./agent.js";

export class AgentRegistry {
  private agents: Map<string, Agent> = new Map();
  private traces: AgentTrace[] = [];
  private maxTraces = 1000; // Keep last 1000 traces in memory

  /**
   * Register an agent in the system.
   */
  register(agent: Agent): void {
    if (this.agents.has(agent.config.id)) {
      throw new Error(`Agent ${agent.config.id} is already registered`);
    }
    this.agents.set(agent.config.id, agent);
  }

  /**
   * Unregister an agent.
   */
  unregister(agentId: string): void {
    this.agents.delete(agentId);
  }

  /**
   * Get an agent by ID.
   */
  get(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all registered agents.
   */
  getAll(): Agent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Find agents by capability (e.g., "can execute Shell tool").
   */
  findByCapability(capability: {
    tool?: string;
    skill?: string;
    feature?: string;
    canDelegate?: boolean;
  }): Agent[] {
    return this.getAll().filter((agent) => {
      if (capability.tool && !agent.config.access.tools.includes(capability.tool)) {
        return false;
      }
      if (capability.skill && !agent.config.access.skills.includes(capability.skill)) {
        return false;
      }
      if (capability.feature && !agent.config.access.features.includes(capability.feature)) {
        return false;
      }
      if (
        capability.canDelegate !== undefined &&
        agent.config.access.canDelegate !== capability.canDelegate
      ) {
        return false;
      }
      return true;
    });
  }

  /**
   * Record an agent execution trace.
   */
  recordTrace(trace: AgentTrace): void {
    this.traces.push(trace);
    if (this.traces.length > this.maxTraces) {
      this.traces.shift(); // Remove oldest trace
    }
  }

  /**
   * Get execution traces for an agent.
   */
  getTraces(agentId?: string, limit = 100): AgentTrace[] {
    let filtered = this.traces;
    if (agentId) {
      filtered = this.traces.filter((t) => t.agentId === agentId);
    }
    return filtered.slice(-limit);
  }

  /**
   * Get agent execution chain (parent → child traces).
   */
  getExecutionChain(executionId: string): AgentTrace[] {
    const chain: AgentTrace[] = [];
    const traceMap = new Map(this.traces.map((t) => [t.executionId, t]));

    let current = this.traces.find((t) => t.executionId === executionId);
    while (current) {
      chain.unshift(current);
      if (current.parentAgentId) {
        // Find parent trace
        current = Array.from(traceMap.values()).find(
          (t) => t.agentId === current?.parentAgentId && t.completedAt < (current?.startedAt ?? 0),
        );
      } else {
        break;
      }
    }

    return chain;
  }

  /**
   * Get agent statistics.
   */
  getStats(agentId: string): {
    totalExecutions: number;
    avgDurationMs: number;
    avgInputTokens: number;
    avgOutputTokens: number;
    errorRate: number;
  } {
    const traces = this.getTraces(agentId, this.maxTraces);
    if (traces.length === 0) {
      return {
        totalExecutions: 0,
        avgDurationMs: 0,
        avgInputTokens: 0,
        avgOutputTokens: 0,
        errorRate: 0,
      };
    }

    const totalDuration = traces.reduce((sum, t) => sum + t.durationMs, 0);
    const totalInputTokens = traces.reduce((sum, t) => sum + (t.output.tokenUsage?.input ?? 0), 0);
    const totalOutputTokens = traces.reduce(
      (sum, t) => sum + (t.output.tokenUsage?.output ?? 0),
      0,
    );
    const errorCount = traces.filter((t) => t.error).length;

    return {
      totalExecutions: traces.length,
      avgDurationMs: totalDuration / traces.length,
      avgInputTokens: totalInputTokens / traces.length,
      avgOutputTokens: totalOutputTokens / traces.length,
      errorRate: errorCount / traces.length,
    };
  }

  /**
   * List all agents with their configs.
   */
  listAgents(): Array<{ id: string; name: string; purpose: string; tier: string }> {
    return this.getAll().map((agent) => ({
      id: agent.config.id,
      name: agent.config.name,
      purpose: agent.config.purpose,
      tier: agent.config.model.tier,
    }));
  }
}

// Global registry instance
let globalRegistry: AgentRegistry | undefined;

export function getGlobalAgentRegistry(): AgentRegistry {
  if (!globalRegistry) {
    globalRegistry = new AgentRegistry();
  }
  return globalRegistry;
}

export function setGlobalAgentRegistry(registry: AgentRegistry): void {
  globalRegistry = registry;
}
