---
summary: "Multi-agent architecture: Every decision point is an agent with clear input, purpose, access, and output"
read_when:
  - Designing new agents or decision points
  - Understanding the multi-agent architecture
  - Adding new capabilities or features
title: "Multi-Agent Architecture Design"
---

# Multi-Agent Architecture Design

## Vision

Transform OpenClaw from a single monolithic agent into a **multi-agent system** where:

- Every decision point is an **agent** with clear boundaries
- Agents have explicit **input**, **purpose**, **access**, and **output**
- Models make decisions within strict boundaries (not pure algorithmic flows)
- Optimized for **local models**, **token efficiency**, and **security**
- Maintains **autonomy** while enforcing **strict constraints**

## What is a Pi Agent?

**Pi** (`@mariozechner/pi-coding-agent`) is the current LLM agent library that:

- Manages conversation history
- Handles tool calling loops
- Provides streaming responses
- Manages context pruning/compaction

In the new multi-agent architecture, Pi agents become **one type of agent** among many specialized agents.

---

## Agent Structure (Standard)

Every agent in the system follows this structure:

```typescript
interface Agent {
  // What the agent receives
  input: {
    userIdentifier: string; // email, phone, username, etc.
    message: string;
    context: Record<string, unknown>; // prior decisions, session state, etc.
  };

  // What the agent's role is
  purpose: string; // Clear, single-responsibility description

  // What the agent can access
  access: {
    data: string[]; // What data sources (e.g., "public user profile", "recent messages")
    documents: string[]; // What docs to include in context
    scripts: string[]; // What scripts it can run (if any)
    features: string[]; // What features it can use
    skills: string[]; // What skills it can invoke
    tools: string[]; // What tools it has access to
  };

  // What the agent produces
  output: {
    decision?: string; // Classification, routing decision, etc.
    response?: string; // Reply text (if applicable)
    metadata?: Record<string, unknown>; // Additional context for next agent
  };
}
```

---

## Current Architecture → Multi-Agent Architecture

### Today's Flow (Single Agent)

```
Message → Phase 1 (classifier) → Simple/Complex decision → ONE big agent handles everything
```

### Target Flow (Multi-Agent)

```
Message → Agent 1 (Intake) → Agent 2 (Router) → Agent 3a (Simple Responder) OR Agent 3b (Complex Orchestrator)
                                                                                      ↓
                                                Agent 4 (Tool Executor) → Agent 5 (Response Builder) → Agent 6 (Deliverer)
```

Each arrow represents a **clear handoff** with defined input/output contracts.

---

## Agent Catalog

### Agent 1: Intake Agent (Message Receiver)

**Model Tier:** 🟢 Small (3B-7B local) or pure function (no LLM needed)  
**Cost:** <$0.0001/request

**Input:**

- Raw message from channel (Telegram, Discord, Signal, etc.)
- Sender identifier (phone, email, username, user ID)
- Channel metadata (group, thread, reply-to, etc.)

**Purpose:**
"Validate and normalize incoming messages; extract user identity and message intent markers"

**Access:**

- Data: None (just the raw message)
- Documents: None
- Scripts: None
- Features: Message parsing, identity resolution
- Skills: None
- Tools: None

**Output:**

- Normalized message body (cleaned text)
- User identifier (canonical format)
- Message metadata (channel, thread, reply markers, attachments)
- Initial flags (e.g., `hasAttachment`, `isReply`, `mentionsBot`)

**File:** `gateway/server/server-methods/chat.ts` (partially), `gateway/agent/pipeline/dispatch.ts`

---

### Agent 2: Router Agent (Phase 1 Classifier)

**Model Tier:** 🟢 Small (7B local, e.g., Llama 3.2 7B, Mistral 7B)  
**Cost:** <$0.0001/request  
**Why this tier:** Classification is a bounded decision (stay/escalate) with minimal context

**Input:**

- User identifier (from Agent 1)
- Normalized message body (from Agent 1)
- Message metadata (from Agent 1)
- Surface-level user context (public profile, recent activity summary)

**Purpose:**
"Identify whether this is a simple inquiry that can be answered directly, or a complex request requiring tools, planning, or multi-step execution"

**Access:**

- Data: Surface-level public info on user (name, last seen, message count, owner status)
- Documents: Classification guidelines only
- Scripts: None
- Features: LLM-based classification
- Skills: None
- Tools: None (no tool execution, only classification)

**Output:**

- Decision: `"simple"` or `"complex"`
- Response: If `"simple"` and can answer immediately, include response text
- Confidence: 0.0-1.0 (how confident the router is)
- Reasoning: Brief explanation of decision (for debugging)

**Current File:** `gateway/agent/pipeline/reply/agent-runner/phases/routing/phase-1.ts`

**System Prompt:** `gateway/agent/agents/classifier/prompt.ts` → `CLASSIFIER_SYSTEM_PROMPT`

**Decision Boundaries:**

- **Stay (simple):** Greetings, chitchat, simple Q&A, permission lookups, basic commands
- **Escalate (complex):** Tool requests, multi-step plans, script execution, specialized tasks

---

### Agent 3a: Simple Responder Agent (Fast Path)

**Model Tier:** 🟢 Small (3B-7B local, e.g., Llama 3.2 3B, Phi-3 Mini)  
**Cost:** <$0.0001/request  
**Why this tier:** Conversational responses need minimal reasoning, no tools

**Input:**

- User identifier (from Agent 2)
- Message body (from Agent 1)
- Response hint (from Agent 2, if provided)

**Purpose:**
"Generate a conversational response to simple inquiries without tools or deep context"

**Access:**

- Data: User timezone, basic preferences
- Documents: None
- Scripts: None
- Features: Direct LLM completion
- Skills: None
- Tools: None

**Output:**

- Response text (final reply to user)
- Token usage

**Current File:** `gateway/runtime/pi-embedded-runner/run/attempt.ts` → `runSimpleTierFastPath`

**Performance:** ~200-500ms

---

### Agent 3b: Complex Orchestrator Agent (Complex Path Entry)

**Model Tier:** 🔴 Large (Claude Sonnet/Opus, GPT-4)  
**Cost:** $0.10-1.00/request  
**Why this tier:** Multi-step reasoning, tool orchestration, complex decision-making requires frontier models

**Input:**

- User identifier (from Agent 2)
- Message body (from Agent 1)
- Full user context (session history, workspace state, etc.)

**Purpose:**
"Orchestrate multi-step execution: determine what tools are needed, invoke them in correct order, synthesize results into a response"

**Access:**

- Data: Full session history, workspace files, memory database, user preferences
- Documents: BOOTSTRAP.md, context files, skills documentation
- Scripts: Can execute via Shell tool
- Features: Full agent session, streaming, context pruning
- Skills: All available workspace skills
- Tools: **All 20+ tools** (Shell, FileSystem, Memory, Message, Browser, Git, etc.)

**Output:**

- Response text (final reply to user)
- Tool execution results (metadata about what was done)
- Session state (updated history)
- Token usage

**Current File:** `gateway/runtime/pi-embedded-runner/run/attempt.ts` → `runEmbeddedAttempt` (complex path)

**Performance:** ~2000-5000ms

**Further decomposition needed:** See "Complex Orchestrator Decomposition" below.

---

## Complex Orchestrator Decomposition

The Complex Orchestrator (Agent 3b) is currently a monolithic 56-step process. It should be decomposed into **specialized sub-agents**:

### Sub-Agent 3b-1: Context Builder

**Model Tier:** 🟡 Medium (70B local/cloud)  
**Cost:** ~$0.01/request  
**Why this tier:** Needs to understand workspace structure and select relevant context, but no tool execution

**Purpose:** "Gather all necessary context for the main execution agent"

**Access:**

- Session history
- Workspace files (BOOTSTRAP.md, etc.)
- Skills metadata
- Memory database (read-only at this stage)

**Output:**

- System prompt components (skills section, memory section, workspace section, etc.)
- Context files to inject
- Tool availability list

**Current Steps:** Phase 1, 2, 3 from complex path (steps 1-14)

---

### Sub-Agent 3b-2: Session Manager

**Model Tier:** 🟡 Medium (70B local/cloud) or pure function  
**Cost:** ~$0.001/request (mostly non-LLM operations)  
**Why this tier:** History validation and pruning can be algorithmic, but may need LLM for semantic compression

**Purpose:** "Manage conversation history: load, validate, sanitize, prune"

**Access:**

- Session file (read/write with lock)
- Transcript policy (model-specific rules)

**Output:**

- Clean, validated message history
- Session metadata (compaction count, token usage, etc.)

**Current Steps:** Phase 4, 6 from complex path (steps 15-32)

---

### Sub-Agent 3b-3: Execution Agent (Main)

**Model Tier:** 🔴 Large (Claude Sonnet/Opus, GPT-4)  
**Cost:** $0.10-1.00/request  
**Why this tier:** Tool orchestration, multi-step planning, and complex reasoning require frontier models

**Purpose:** "Execute the user's request using available tools and streaming responses"

**Access:**

- All tools
- System prompt (from Context Builder)
- Session history (from Session Manager)
- Can delegate to other agents (future capability)

**Output:**

- Streaming response chunks
- Tool execution events
- Final response text

**Current Steps:** Phase 7, 8, 9 from complex path (steps 33-44)

**This is where the Pi agent library is used today.**

---

### Sub-Agent 3b-4: Response Processor

**Model Tier:** 🟢 Small (7B local) or pure function  
**Cost:** <$0.001/request  
**Why this tier:** Text extraction and token counting are mostly algorithmic; minimal LLM needed

**Purpose:** "Post-process agent output: extract text, check for special tokens, log usage"

**Access:**

- Raw agent output
- Messaging tool metadata

**Output:**

- Final cleaned response text
- Token usage stats
- Delivery instructions (e.g., "send via message_send", "silent", "reply to original")

**Current Steps:** Phase 10, 11 from complex path (steps 45-56)

---

## Agent Summary Table

| Agent                    | Model Tier          | Cost/Request | Access Level        | Can Delegate? | Usage % |
| ------------------------ | ------------------- | ------------ | ------------------- | ------------- | ------- |
| 1. Intake                | 🟢 Small (or none)  | <$0.0001     | None (parsing only) | No            | 100%    |
| 2. Router                | 🟢 Small (7B)       | <$0.0001     | Public data only    | No            | 100%    |
| 3a. Simple Responder     | 🟢 Small (3B)       | <$0.0001     | Basic context       | No            | ~70%    |
| 3b-1. Context Builder    | 🟡 Medium (70B)     | ~$0.01       | Read-only workspace | No            | ~10%    |
| 3b-2. Session Manager    | 🟡 Medium (or none) | ~$0.001      | Session file        | No            | ~10%    |
| 3b-3. Execution Agent    | 🔴 Large (GPT-4)    | $0.10-1.00   | All tools           | **Yes**       | ~10%    |
| 3b-4. Response Processor | 🟢 Small (or none)  | <$0.001      | Output only         | No            | ~10%    |

**Key insights:**

- **70% of requests** never leave small models (handled by Intake → Router → Simple Responder)
- **20% of requests** use medium models for context/session management
- **10% of requests** use large expensive models for actual tool execution
- Only **Execution Agent (3b-3)** can delegate to other agents (orchestration capability)

**Delegation example:**

```
User: "Research competitors and create a comparison report"
  ↓
Execution Agent (GPT-4) analyzes request, decides to delegate:
  → Spawns Research Agent (medium model) for web scraping
  → Spawns Analysis Agent (medium model) for comparison
  → Synthesizes results in Execution Agent (large model) for final report
```

This delegation pattern allows:

- Large model focuses on high-level orchestration
- Medium models handle specialized sub-tasks in parallel
- Cost optimization through appropriate tier assignment

---

## Model Hierarchy & Cost Structure

```
┌─────────────────────────────────────────────────────────────────────┐
│ LARGE MODELS (Claude Sonnet/Opus, GPT-4)                           │
│ Cost: $0.10-1.00/request                                            │
│ Usage: ~10% of requests                                             │
│                                                                     │
│ Agents: Execution Agent (3b-3), Tool Planner                       │
│ Access: All tools, full delegation, unrestricted                   │
│ Jobs: Multi-step execution, complex reasoning, tool orchestration  │
└─────────────────────────────────────────────────────────────────────┘
                              ↑ Escalate only when needed
┌─────────────────────────────────────────────────────────────────────┐
│ MEDIUM MODELS (70B local/cloud)                                    │
│ Cost: ~$0.01/request                                                │
│ Usage: ~20% of requests                                             │
│                                                                     │
│ Agents: Context Builder (3b-1), Session Manager (3b-2),            │
│         Response Processor (3b-4)                                   │
│ Access: Session history, read-only tools, limited delegation       │
│ Jobs: Context assembly, history management, response formatting    │
└─────────────────────────────────────────────────────────────────────┘
                              ↑ Escalate for complex requests
┌─────────────────────────────────────────────────────────────────────┐
│ SMALL MODELS (3B-7B local)                                          │
│ Cost: <$0.001/request                                               │
│ Usage: ~70% of requests (handled completely at this level)         │
│                                                                     │
│ Agents: Intake (1), Router (2), Simple Responder (3a)              │
│ Access: Public data only, no tools, no delegation                  │
│ Jobs: Message validation, classification, simple Q&A               │
└─────────────────────────────────────────────────────────────────────┘
```

**Example request flow:**

1. User: "hi" → Router (3B model, $0.0001) → "simple" → Simple Responder (3B, $0.0001) → Done
   - **Total cost: $0.0002**

2. User: "show me the weather" → Router (3B, $0.0001) → "complex" → Execution Agent (GPT-4, $0.50)
   - **Total cost: $0.5001**

3. User: "refactor this codebase and write tests" → Router (3B, $0.0001) → "complex" → Context Builder (70B, $0.01) → Execution Agent (Claude Opus, $1.00)
   - **Total cost: $1.0101**

**Cost savings vs monolithic approach:**

- **Monolithic (all requests use GPT-4):** $0.50 average per request
- **Multi-agent (tiered models):** $0.07 average per request (70% at $0.0002, 20% at $0.50, 10% at $1.00)
- **Savings: 86% cost reduction**

---

## Multi-Agent Benefits

### 1. Token Efficiency

- Each agent has a **minimal system prompt** for its specific purpose
- No need to load full tools/skills/context for simple tasks
- Agent 2 (Router) prompt: ~500 tokens
- Agent 3a (Simple) prompt: ~100 tokens
- Agent 3b (Complex) prompt: ~50,000 tokens
- **Result:** 100x token savings for simple requests

### 2. Local Model Compatibility

- Smaller agents (1, 2, 3a) can run on **small local models** (3B-7B params)
- Only complex execution (3b-3) needs larger models (70B+)
- **Result:** Most requests never hit expensive cloud APIs

### 3. Security & Boundaries

- Each agent has **explicit access controls**
- Agent 2 cannot execute tools (only classify)
- Agent 3a cannot access session history or tools
- Agent 3b sub-agents have scoped access
- **Result:** Principle of least privilege enforced at agent level

### 4. Autonomy with Constraints

- Agents make **LLM-based decisions** (not hardcoded rules)
- But decisions are **within strict boundaries** defined by access controls
- Example: Router agent _decides_ if complex, but _cannot_ execute tools
- **Result:** Models have agency within guardrails

### 5. Testability & Observability

- Each agent can be **tested in isolation**
- Clear input/output contracts make debugging easier
- Agent execution logs show **which agent made which decision**
- **Result:** Easier to identify bottlenecks and optimize

---

## Implementation Roadmap

### Phase 1: Formalize Current Agents ✅ (Mostly Done)

- [x] Agent 2 (Router) - Phase 1 classifier
- [x] Agent 3a (Simple Responder) - Simple tier fast path
- [x] Agent 3b (Complex Orchestrator) - Complex tier (monolithic)
- [ ] Document agent contracts (this doc)

### Phase 2: Decompose Complex Orchestrator

- [ ] Extract Context Builder (3b-1)
- [ ] Extract Session Manager (3b-2)
- [ ] Extract Response Processor (3b-4)
- [ ] Clarify Execution Agent (3b-3) boundaries

### Phase 3: Add Agent-Level Observability

- [ ] Agent execution traces (log which agent ran, when, with what input/output)
- [ ] Agent performance metrics (latency, token usage per agent)
- [ ] Agent decision auditing (why did Router choose complex?)

### Phase 4: Local Model Integration

- [ ] Run Router (Agent 2) on local 7B model
- [ ] Run Simple Responder (Agent 3a) on local 3B model
- [ ] Keep Complex Execution (Agent 3b-3) on cloud or local 70B+
- [ ] Add model routing based on agent requirements

### Phase 5: Add More Specialized Agents

- [ ] Agent 4: Tool Planner (decides _which_ tools, _in what order_)
- [ ] Agent 5: Memory Agent (handles all memory operations)
- [ ] Agent 6: Code Agent (specialized for code-related tasks)
- [ ] Agent 7: Research Agent (specialized for information gathering)

---

## Agent Communication Protocol

Agents communicate via a standard message format:

```typescript
interface AgentMessage {
  from: string; // Agent ID (e.g., "router", "simple-responder")
  to: string; // Target agent ID (e.g., "orchestrator")
  input: {
    userIdentifier: string;
    data: Record<string, unknown>;
  };
  output?: {
    decision?: string;
    response?: string;
    metadata?: Record<string, unknown>;
  };
  timestamp: number;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
  };
}
```

This enables:

- **Tracing:** Full execution path visible
- **Debugging:** See exactly what each agent received/produced
- **Optimization:** Identify slow agents
- **Auditing:** Understand decision chain

---

## Agent Design Principles

### 1. Single Responsibility

Each agent has **one clear purpose**. If an agent's purpose requires "and" or "or", it should probably be split.

❌ Bad: "Route messages **and** execute tools **and** format responses"  
✅ Good: "Route messages to appropriate execution tier"

### 2. Minimal Context

Each agent receives **only the context it needs** for its purpose.

❌ Bad: Router agent receives full session history (50k tokens)  
✅ Good: Router agent receives message + user summary (500 tokens)

### 3. Explicit Access Controls

Each agent declares **exactly what it can access**.

❌ Bad: Agent has access to "everything"  
✅ Good: Agent has access to ["user_profile", "recent_activity_summary"]

### 4. Bounded Decisions

Agents make decisions **within explicit boundaries**.

❌ Bad: Agent can decide "run any arbitrary code"  
✅ Good: Agent can decide "simple" or "complex" (and nothing else)

### 5. Clear Handoffs

Agent outputs must match the next agent's expected inputs.

❌ Bad: Router returns `{ result: "ok" }` → Responder expects `{ tier: "simple" }`  
✅ Good: Router returns `{ tier: "simple", confidence: 0.95 }` → Responder receives exactly that

### 6. Model-Capability Alignment

Each agent's model size/cost should match its access level and job complexity. Smaller, cheaper models handle constrained tasks; larger, more expensive models handle complex orchestration and delegation.

**Hierarchy:**

- **Small models (3B-7B, local, <$0.001/request):** Lower access level, constrained jobs
  - Examples: Intake Agent, Router Agent, Simple Responder
  - Access: Public data only, no tools, no delegation
  - Jobs: Classification, simple Q&A, validation

- **Medium models (70B, local or cloud, ~$0.01/request):** Moderate access, specialized tasks
  - Examples: Context Builder, Session Manager, Response Processor
  - Access: Session history, read-only tools, limited delegation
  - Jobs: Context assembly, history management, formatting

- **Large models (Claude Sonnet/Opus, GPT-4, $0.10-1.00/request):** High access, orchestration
  - Examples: Execution Agent (Agent 3b-3), Tool Planner
  - Access: All tools, full session, can delegate to other agents
  - Jobs: Tool execution, multi-step planning, complex reasoning

**Cost optimization:** 90% of requests handled by small models, 10% escalate to large models.

❌ Bad: Use GPT-4 for Router (wastes $0.50 on simple classification)  
✅ Good: Use local 7B for Router ($0.0001), escalate to GPT-4 only for complex execution

❌ Bad: Use 3B model for tool execution (insufficient capability, will fail)  
✅ Good: Use Claude Sonnet for tool execution (capable of multi-step reasoning)

❌ Bad: All agents use the same model (no cost optimization)  
✅ Good: Each agent uses the smallest model that can reliably handle its job

---

## Migration Strategy

### Current State

```
phase1Classify() → if ("stay") → runSimpleTierFastPath()
                → if ("escalate") → runEmbeddedAttempt() [monolithic 56 steps]
```

### Target State

```
IntakeAgent → RouterAgent → if ("simple") → SimpleResponderAgent
                         → if ("complex") → ContextBuilderAgent
                                          → SessionManagerAgent
                                          → ExecutionAgent
                                          → ResponseProcessorAgent
```

### Migration Steps

1. **Wrap existing functions as agents** (no logic changes yet)
   - Create `AgentRunner` class that wraps `phase1Classify` as `RouterAgent`
   - Track input/output in `AgentMessage` format
   - Add agent-level logging

2. **Extract sub-agents from complex path** (refactor internal logic)
   - Split `runEmbeddedAttempt` into 4 sub-agents
   - Each sub-agent becomes a separate function with clear input/output
   - Maintain backward compatibility

3. **Add agent registry** (infrastructure)
   - Create `AgentRegistry` to track all agents
   - Enable dynamic agent loading (for plugins)
   - Add agent health checks

4. **Add local model support** (new capability)
   - Configure which agent uses which model
   - Add fallback chains (local → cloud)
   - Track cost per agent

5. **Add agent observability** (monitoring)
   - Execution traces (full agent chain for each request)
   - Performance dashboards (latency, token usage per agent)
   - Decision auditing (why each agent made its choice)

---

## Questions to Answer

1. **Agent vs Function:** When does a "function" become an "agent"?
   - Rule: If it makes an LLM-based decision OR has its own system prompt → Agent
   - Otherwise → Helper function

2. **Agent Granularity:** How fine-grained should agents be?
   - Rule: If it has a distinct purpose and can be tested in isolation → Separate agent
   - If it's a pure implementation detail → Keep as sub-function

3. **Agent State:** Do agents maintain state between invocations?
   - Agent 2 (Router): Stateless (each classification is independent)
   - Agent 3b-2 (Session Manager): Stateful (manages session file)
   - Rule: Minimize stateful agents; prefer passing state via messages

4. **Agent Selection:** How do we route to the right agent?
   - Today: Hardcoded (phase1 → simple/complex)
   - Future: Agent registry + capability matching
   - Example: "I need an agent that can [execute Python, access memory, stream responses]"

---

## Next Steps

1. **Review this architecture** - Does it align with your vision?
2. **Refine agent boundaries** - Are these the right agents? Too many? Too few?
3. **Define agent contracts** - Formalize input/output schemas (TypeScript interfaces)
4. **Extract first sub-agent** - Start with Context Builder (easiest to extract)
5. **Add agent tracing** - Implement `AgentMessage` logging
6. **Test with local models** - Validate token savings and performance

---

## Related Docs

- [Tiered Routing Complete Flow](/reference/tiered-routing-complete-flow) - Current implementation (pre-multi-agent)
- [Message-to-Reply Flow](/reference/message-to-reply-flow) - Detailed code paths
- [Tiered Model Routing](/reference/tiered-model-routing) - Phase 1 design
