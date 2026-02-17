/**
 * Core agent abstraction for multi-agent architecture.
 *
 * Every agent follows this structure:
 * - Input: What the agent receives
 * - Purpose: Single responsibility description
 * - Access: What data/tools/skills the agent can use
 * - Output: What the agent produces
 * - Model: Which model tier to use
 */

export type ModelTier = "small" | "medium" | "large";

export interface AgentInput {
  /** User identifier (email, phone, username, etc.) */
  userIdentifier: string;
  /** The message or prompt to process */
  message: string;
  /** Additional context from prior agents or system */
  context?: Record<string, unknown>;
}

export interface AgentOutput {
  /** Classification or routing decision */
  decision?: string;
  /** Response text (if applicable) */
  response?: string;
  /** Additional metadata for next agent */
  metadata?: Record<string, unknown>;
  /** Token usage for this agent */
  tokenUsage?: {
    input: number;
    output: number;
  };
  /** Execution time in milliseconds */
  durationMs?: number;
}

export interface AgentAccess {
  /** What data sources this agent can read */
  data: string[];
  /** What documents this agent can access */
  documents: string[];
  /** What scripts this agent can execute */
  scripts: string[];
  /** What features this agent can use */
  features: string[];
  /** What skills this agent can invoke */
  skills: string[];
  /** What tools this agent has access to */
  tools: string[];
  /** Can this agent delegate to other agents? */
  canDelegate: boolean;
}

export interface AgentConfig {
  /** Unique agent identifier */
  id: string;
  /** Human-readable agent name */
  name: string;
  /** Single responsibility description */
  purpose: string;
  /** What the agent can access */
  access: AgentAccess;
  /** Model tier and provider configuration */
  model: {
    tier: ModelTier;
    provider?: string; // e.g., "anthropic", "openai", "local"
    modelId?: string; // e.g., "claude-3-5-sonnet-20241022", "gpt-4o-mini"
    maxTokens?: number;
    temperature?: number;
  };
  /** System prompt template (optional, can be built dynamically) */
  systemPromptTemplate?: string;
}

export interface AgentExecutionContext {
  /** Unique execution ID for tracing */
  executionId: string;
  /** Timestamp when execution started */
  startedAt: number;
  /** Parent agent ID (if this was delegated) */
  parentAgentId?: string;
  /** Configuration for the current environment */
  config?: Record<string, unknown>;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/**
 * Base Agent class that all agents extend.
 */
export abstract class Agent {
  constructor(public readonly config: AgentConfig) {}

  /**
   * Main execution method - must be implemented by each agent.
   */
  abstract execute(input: AgentInput, context: AgentExecutionContext): Promise<AgentOutput>;

  /**
   * Validate that the input meets this agent's requirements.
   * Override this to add custom validation.
   */
  protected async validateInput(input: AgentInput): Promise<void> {
    if (!input.userIdentifier) {
      throw new Error(`Agent ${this.config.id}: userIdentifier is required`);
    }
    if (!input.message) {
      throw new Error(`Agent ${this.config.id}: message is required`);
    }
  }

  /**
   * Check if this agent has access to a specific resource.
   */
  protected hasAccess(resourceType: keyof AgentAccess, resourceName: string): boolean {
    const accessList = this.config.access[resourceType];
    if (Array.isArray(accessList)) {
      return accessList.includes(resourceName) || accessList.includes("*");
    }
    if (resourceType === "canDelegate") {
      return this.config.access.canDelegate;
    }
    return false;
  }

  /**
   * Build system prompt for this agent.
   * Override this to customize prompt construction.
   */
  protected buildSystemPrompt(input: AgentInput): string {
    if (this.config.systemPromptTemplate) {
      return this.config.systemPromptTemplate;
    }

    // Default minimal prompt
    return `You are ${this.config.name}.

Purpose: ${this.config.purpose}

Respond directly and helpfully.`;
  }

  /**
   * Get model configuration for this agent.
   */
  protected getModelConfig(): Required<AgentConfig["model"]> {
    const defaults = {
      provider: "local",
      modelId: this.getDefaultModelForTier(this.config.model.tier),
      maxTokens: 2048,
      temperature: 0.7,
    };

    return {
      ...defaults,
      ...this.config.model,
    } as Required<AgentConfig["model"]>;
  }

  /**
   * Get default model ID for a given tier.
   */
  private getDefaultModelForTier(tier: ModelTier): string {
    switch (tier) {
      case "small":
        return "llama-3.2-3b";
      case "medium":
        return "llama-3.1-70b";
      case "large":
        return "claude-3-5-sonnet-20241022";
    }
  }
}

/**
 * Agent execution trace for observability.
 */
export interface AgentTrace {
  agentId: string;
  agentName: string;
  executionId: string;
  parentAgentId?: string;
  input: AgentInput;
  output: AgentOutput;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  modelTier: ModelTier;
  modelUsed?: string;
  error?: string;
}

/**
 * Agent message format for inter-agent communication.
 */
export interface AgentMessage {
  from: string; // Agent ID
  to: string; // Target agent ID
  input: AgentInput;
  output?: AgentOutput;
  timestamp: number;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
  };
}
