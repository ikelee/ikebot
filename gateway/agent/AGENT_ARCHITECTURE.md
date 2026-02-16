# Agent Architecture

This directory contains the multi-agent architecture implementation for OpenClaw.

## Overview

Every decision point in OpenClaw is an **agent** with clear boundaries:

- **Input:** What the agent receives
- **Purpose:** Single responsibility
- **Access:** What data/tools/skills the agent can use
- **Output:** What the agent produces
- **Model:** Which model tier to use

## Directory Structure

```
gateway/agent/
├── core/                    # Core agent infrastructure
│   ├── agent.ts            # Base Agent class and interfaces
│   ├── agent-registry.ts   # Agent registry for tracking and stats
│   ├── agent-executor.ts   # Execute agents with tracing
│   └── index.ts            # Core exports
├── agents/                  # Concrete agent implementations (each: agent.ts + prompt.ts)
│   ├── classifier/         # Agent 2: Router (Phase 1 classifier)
│   │   ├── agent.ts        # RouterAgent
│   │   ├── prompt.ts       # CLASSIFIER_SYSTEM_PROMPT
│   │   └── agent.test.ts
│   ├── simple-responder/   # Agent 3a: Simple Responder
│   │   ├── agent.ts        # SimpleResponderAgent
│   │   └── prompt.ts       # buildSimpleResponderPrompt
│   └── ...
└── AGENT_ARCHITECTURE.md   # This file
```

## Agent Hierarchy

### Model Tiers

```
🔴 LARGE MODELS (Claude/GPT-4, $0.10-1.00/request)
   ↓ Only 10% of requests
   - All tools
   - Can delegate to other agents
   - Complex reasoning, orchestration

🟡 MEDIUM MODELS (70B local/cloud, ~$0.01/request)
   ↓ Only 20% of requests
   - Read-only tools
   - Limited delegation
   - Context assembly, history management

🟢 SMALL MODELS (3B-7B local, <$0.001/request)
   ↓ 70% of requests handled here
   - No tools
   - No delegation
   - Classification, simple Q&A
```

## Creating a New Agent

### 1. Extend the Agent Base Class

```typescript
import {
  Agent,
  type AgentConfig,
  type AgentExecutionContext,
  type AgentInput,
  type AgentOutput,
} from "../core/agent.js";

export class MyAgent extends Agent {
  constructor() {
    const config: AgentConfig = {
      id: "my-agent",
      name: "My Agent",
      purpose: "Clear single responsibility description",
      access: {
        data: ["user_profile"], // What data can be accessed
        documents: [], // What docs can be read
        scripts: [], // What scripts can be run
        features: ["some_feature"], // What features can be used
        skills: [], // What skills can be invoked
        tools: [], // What tools are available
        canDelegate: false, // Can delegate to other agents?
      },
      model: {
        tier: "small", // "small" | "medium" | "large"
        provider: "local", // "local" | "anthropic" | "openai"
        modelId: "llama-3.2-3b",
        maxTokens: 2048,
        temperature: 0.7,
      },
    };
    super(config);
  }

  async execute(input: AgentInput, context: AgentExecutionContext): Promise<AgentOutput> {
    await this.validateInput(input);

    // Your agent logic here

    return {
      response: "Agent response",
      tokenUsage: {
        input: 100,
        output: 50,
      },
      durationMs: Date.now() - context.startedAt,
    };
  }
}
```

### 2. Register the Agent

```typescript
import { getGlobalAgentRegistry } from "./core/agent-registry.js";
import { MyAgent } from "./agents/my-agent.js";

const registry = getGlobalAgentRegistry();
const agent = new MyAgent();
registry.register(agent);
```

### 3. Execute the Agent

```typescript
import { executeAgent } from "./core/agent-executor.js";

const output = await executeAgent(agent, {
  userIdentifier: "user123",
  message: "Hello",
  context: {
    /* optional context */
  },
});

console.log(output.response);
```

## Current Agents

### Agent 3a: Simple Responder

- **File:** `agents/simple-responder/agent.ts`
- **Model Tier:** 🟢 Small (3B-7B local)
- **Cost:** <$0.0001/request
- **Purpose:** Generate conversational responses to simple inquiries
- **Access:** User timezone, basic preferences only - no tools
- **Usage:** ~70% of all requests

**Example:**

```typescript
const agent = new SimpleResponderAgent();
const output = await executeAgent(agent, {
  userIdentifier: "user@example.com",
  message: "hi",
  context: {
    userTimezone: "America/New_York",
  },
});
// Output: { response: "Hello! How can I help you?", ... }
```

## Agent Execution Tracing

Every agent execution is automatically traced for observability:

```typescript
// Get traces for a specific agent
const traces = registry.getTraces("simple-responder", 100);

// Get execution chain (parent → child agents)
const chain = registry.getExecutionChain(executionId);

// Get agent statistics
const stats = registry.getStats("simple-responder");
console.log(stats);
// {
//   totalExecutions: 1000,
//   avgDurationMs: 250,
//   avgInputTokens: 100,
//   avgOutputTokens: 50,
//   errorRate: 0.01,
// }
```

## Agent Communication

Agents can communicate via a standard message format:

```typescript
interface AgentMessage {
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
```

## Design Principles

### 1. Single Responsibility

Each agent has **one clear purpose**. If description requires "and" or "or", split it.

❌ Bad: "Route messages and execute tools and format responses"  
✅ Good: "Route messages to appropriate execution tier"

### 2. Minimal Context

Each agent receives **only the context it needs**.

❌ Bad: Router agent receives full 50K token session history  
✅ Good: Router agent receives message + 500 token user summary

### 3. Explicit Access Controls

Each agent declares **exactly what it can access**.

❌ Bad: Agent has access to "everything"  
✅ Good: Agent has access to `["user_profile", "recent_activity"]`

### 4. Bounded Decisions

Agents make decisions **within explicit boundaries**.

❌ Bad: Agent can decide "run any arbitrary code"  
✅ Good: Agent can decide "simple" or "complex" (nothing else)

### 5. Clear Handoffs

Agent outputs must match next agent's expected inputs.

❌ Bad: Router returns `{ result: "ok" }` → Responder expects `{ tier: "simple" }`  
✅ Good: Router returns `{ tier: "simple", confidence: 0.95 }`

### 6. Model-Capability Alignment

Each agent's model size/cost matches its access level and job complexity.

- 🟢 Small models: Lower access, constrained jobs, no delegation
- 🟡 Medium models: Moderate access, specialized tasks, limited delegation
- 🔴 Large models: High access, orchestration, **can delegate**

## Testing Agents

```typescript
import { describe, it, expect } from "vitest";
import { MyAgent } from "./my-agent.js";

describe("MyAgent", () => {
  it("should execute successfully", async () => {
    const agent = new MyAgent();
    const output = await agent.execute(
      {
        userIdentifier: "test-user",
        message: "test message",
      },
      {
        executionId: "test-123",
        startedAt: Date.now(),
      },
    );

    expect(output.response).toBeDefined();
    expect(output.tokenUsage).toBeDefined();
  });
});
```

## Next Steps

### Planned Agents

1. **Router Agent (Agent 2)** - Phase 1 classifier
2. **Context Builder (Agent 3b-1)** - Gather context for execution
3. **Session Manager (Agent 3b-2)** - Manage conversation history
4. **Execution Agent (Agent 3b-3)** - Tool orchestration
5. **Response Processor (Agent 3b-4)** - Post-process output
6. **Calendar Agent** - Simple calendar management
7. **Memory Agent** - Handle all memory operations
8. **Code Agent** - Specialized for code tasks
9. **Research Agent** - Information gathering

### Integration

- [ ] Refactor Phase 1 classifier to use RouterAgent
- [ ] Decompose complex path into sub-agents
- [ ] Add local model support
- [ ] Implement agent delegation
- [ ] Add agent performance dashboards

## Related Documentation

- [Multi-Agent Design](/docs/architecture/multi-agent-design.md) - Overall architecture
- [Message-to-Reply Flow](/docs/reference/message-to-reply-flow.md) - Current implementation
- [Tiered Routing](/docs/reference/tiered-routing-complete-flow.md) - Flow details
