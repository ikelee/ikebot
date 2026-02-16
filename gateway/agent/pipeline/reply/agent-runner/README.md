# Agent Runner - Core Execution Engine

The `agent-runner/` directory contains the core agent execution orchestration logic. This is the heart of the reply pipeline, responsible for running agents, managing sessions, routing requests, and coordinating all aspects of agent execution.

## Overview

This folder orchestrates the entire agent execution lifecycle:

1. **Request Classification** - Determines if request is simple/complex
2. **Session Management** - Manages conversation state and memory
3. **Agent Execution** - Runs the AI model and coordinates tool calls
4. **Queue Management** - Handles queued/parallel requests
5. **Abort Handling** - Cancels in-flight requests
6. **Memory Management** - Flushes and compacts session memory

## Structure

```
agent-runner/
├── core/                            # Main orchestrator + execution pipeline
│   ├── agent-runner.ts             # Entry point – run agents here
│   ├── agent-runner-execution.ts   # Core execution logic
│   ├── agent-runner-helpers.ts     # Helper functions
│   ├── agent-runner-memory.ts      # Memory management
│   ├── agent-runner-payloads.ts    # Payload building
│   ├── agent-runner-utils.ts       # Utility functions
│   └── *.test.ts                   # 19 test files co-located
│
├── session/                         # Session lifecycle + tests
│   ├── session.ts                  # Main session logic
│   ├── session-updates.ts          # Session state updates
│   ├── session-reset-model.ts      # Session reset logic
│   ├── session-run-accounting.ts   # Usage tracking
│   ├── session-usage.ts            # Usage calculations
│   └── *.test.ts                   # 4 test files co-located
│
├── routing/                         # Request flow control + tests
│   ├── route-reply.ts              # Reply routing logic
│   ├── abort.ts                    # Request cancellation
│   ├── followup-runner.ts          # Followup execution
│   ├── memory-flush.ts             # Memory flush logic
│   └── *.test.ts                   # 6 test files co-located
│
├── queue.ts                         # Barrel – re-exports queue/*
├── queue/                           # Queue implementation + test
│   ├── cleanup.ts, directive.ts, drain.ts, enqueue.ts
│   ├── normalize.ts, settings.ts, state.ts, types.ts
│   └── queue.collect-routing.test.ts
│
├── exec.ts, exec/                   # Execution directives
│   └── directive.ts
│
├── phases/                          # Multi-phase routing
│   ├── README.md
│   └── routing/
│       ├── index.ts
│       └── phase-1.ts
│
├── IMPORT_GRAPH.md                  # Import analysis & strategy
└── README.md                        # This file
```

## Key Files

### Core Files

#### `core/agent-runner.ts` 🎯

**The main orchestrator.** This is the entry point for all agent execution.

**Responsibilities**:

- Coordinates entire agent run lifecycle
- Manages session initialization/updates
- Handles streaming and block replies
- Integrates abort, memory flush, and followup execution
- Dispatches final replies

**When to use**: Import from `../agent-runner/core/agent-runner.js` when you need to run an agent

#### `core/agent-runner-execution.ts`

**Core execution logic.** Handles the actual AI model invocation.

**Responsibilities**:

- Builds agent prompts and tool definitions
- Invokes AI models (Claude, GPT, etc.)
- Handles tool calls and responses
- Manages thinking levels
- Processes agent output

#### `agent-runner-helpers.ts`

**Helper functions** for agent execution.

**Includes**:

- Context preparation
- Tool definition building
- Response formatting
- Media handling

#### `agent-runner-memory.ts`

**Memory management** during execution.

**Responsibilities**:

- Determines when memory flush is needed
- Coordinates memory flush execution
- Updates session with memory changes

#### `agent-runner-payloads.ts`

**Payload construction** for agent runs.

**Builds**:

- Tool result payloads
- Agent response payloads
- Streaming payloads

#### `agent-runner-utils.ts`

**Utility functions** for agent runner.

**Includes**:

- Channel capability checks
- Provider validation
- Session utilities

### Session Management (8 files)

Sessions maintain conversation state and history.

#### `session.ts`

**Main session logic.**

**Responsibilities**:

- Session initialization
- Session updates
- Session resets
- Session validation

#### `session-updates.ts`

**Session state updates.**

**Handles**:

- Turn completion
- Message history updates
- Metadata updates
- Compaction tracking

#### `session-reset-model.ts`

**Model session resets.**

**Handles**:

- Clearing model-specific state
- Resetting conversation history
- Preserving user preferences

#### `session-run-accounting.ts`

**Usage tracking.**

**Tracks**:

- Token usage per run
- Cost per run
- Compaction counts

#### `session-usage.ts`

**Usage calculations.**

**Calculates**:

- Total tokens
- Total cost
- Usage summaries

### Routing & Classification

Classification (stay/escalate/calendar) lives in `gateway/agent/run.ts` via RouterAgent. See `gateway/agent/agents/classifier/`.

#### `route-reply.ts`

**Reply routing logic.**

**Routes requests to**:

- Simple tier (fast path)
- Complex tier (full agent)
- Error handling

### Execution Control

#### `abort.ts`

**Request cancellation.**

**Handles**:

- In-flight request cancellation
- Cleanup after abort
- Abort notifications

#### `followup-runner.ts`

**Followup execution.**

**Handles**:

- Automatic followups
- Tool-triggered followups
- Chained execution

#### `memory-flush.ts`

**Memory flush logic.**

**Triggers when**:

- Context limit approaching
- User requests flush
- Automatic compaction needed

**Does**:

- Saves conversation history
- Compacts context
- Updates session

### Queue Management

The `queue/` subfolder handles parallel and queued execution.

#### `queue/directive.ts`

**Queue directive handling.**

Parses directives like:

- `@queue:parallel` - Run in parallel
- `@queue:after:xyz` - Run after request xyz
- `@queue:replace:abc` - Replace request abc

#### `queue/enqueue.ts`

**Queue enqueuing logic.**

**Adds requests to queue** with:

- Priority
- Dependencies
- Constraints

#### `queue/drain.ts`

**Queue draining logic.**

**Processes queued requests** based on:

- Dependencies resolved
- Resource availability
- User limits

#### `queue/cleanup.ts`

**Queue cleanup.**

**Removes**:

- Completed requests
- Expired requests
- Cancelled requests

### Execution Directives

The `exec/` subfolder handles execution-related directives.

#### `exec/directive.ts`

**Execution directive handling.**

Handles directives that control execution:

- Command approvals
- Execution constraints
- Safety checks

### Multi-Phase Routing

The `phases/` subfolder contains multi-phase request routing logic.

See `phases/README.md` for details on the routing strategy.

## Usage Examples

### Running an Agent

```typescript
import { runReplyAgent } from "./agent-runner/core/agent-runner.js";

const result = await runReplyAgent({
  inboundCtx,
  cfg,
  providerHandshake,
  sessionStore,
  // ... other options
});
```

### Managing Sessions

```typescript
import { initSessionState, updateSessionAfterRun } from "./agent-runner/session/session.js";

// Initialize
const session = await initSessionState({ sessionKey, cfg });

// After run
await updateSessionAfterRun({
  session,
  result,
  usage,
});
```

### Handling Aborts

```typescript
import { abortRequest } from "./agent-runner/routing/abort.js";

await abortRequest({
  runId,
  sessionKey,
  reason: "user_cancelled",
});
```

## Testing

```bash
# All agent-runner tests
pnpm test gateway/agent/pipeline/reply/agent-runner

# Specific test file
pnpm test gateway/agent/pipeline/reply/agent-runner/agent-runner.test.ts

# Session tests
pnpm test gateway/agent/pipeline/reply/agent-runner/session
```

## Design Patterns

### Orchestration Pattern

`agent-runner.ts` coordinates multiple subsystems without implementing their logic directly. Each subsystem (session, memory, queue) is responsible for its own logic.

### Separation of Concerns

- **Classification** (`gateway/agent/run.ts` via RouterAgent) - Separate from execution
- **Execution** (`agent-runner-execution.ts`) - Separate from orchestration
- **Session** (`session*.ts`) - Separate from execution
- **Queue** (`queue/`) - Separate from core execution

### Co-located Tests

Tests are next to the files they test for easy discovery and maintenance.

## Import Conventions

From `agent-runner/` to:

- **Gateway-level** (`infra/`, `models/`, `runtime/`): `../../../../`
- **Pipeline-level** (`thinking.ts`, `types.ts`): `../../`
- **Reply subfolders**: `../utilities/`, `../streaming/`, `../reply-building/`
- **Agent-runner sibling files**: `./`
- **Agent-runner subfolders**: `./queue/`, `./exec/`, `./phases/`

## Key Concepts

### Simple vs. Complex Tier

Requests are classified into tiers for optimal execution:

- **Simple**: Fast responses, minimal processing, no tools
- **Complex**: Full agent capability, tool use, multi-step reasoning

### Session Lifecycle

1. **Init**: Create or load session
2. **Execute**: Run agent with session context
3. **Update**: Save turn results and usage
4. **Compact**: Flush memory if needed
5. **Reset**: Clear on user request or error

### Memory Management

Sessions accumulate history. When context limit approaches:

1. Trigger memory flush
2. Compact conversation history
3. Preserve important context
4. Continue execution

### Queue Coordination

Multiple requests can be queued with dependencies:

- **Parallel**: Run simultaneously
- **Sequential**: Wait for previous to complete
- **Replace**: Cancel previous, run this one

## FAQ

**Q: Why are session files not in a subfolder?**  
A: We tried organizing them into `core/` and `session/` subfolders, but it created too many import path issues and didn't add significant value. The flat structure with clear naming (`session-*.ts`) works well.

**Q: What's the difference between `routing/` and `phases/`?**  
A: `routing/` contains request flow control (request-router, route-reply, abort, followup-runner, memory-flush). `phases/` contains the multi-phase classification logic used by request-router.

**Q: Where is the main entry point?**  
A: `agent-runner.ts` is the main entry point for agent execution. But the overall reply pipeline starts in `../reply-building/get-reply.ts`.

**Q: How do I add a new session feature?**  
A: Add logic to the appropriate `session-*.ts` file or create a new one following the naming pattern.

## Related Documentation

- [Reply Pipeline README](../README.md) - Overview of entire reply system
- [Phases README](./phases/README.md) - Multi-phase routing details
- [Message Flow](../../../../docs/reference/message-to-reply-flow.md) - Full message lifecycle

## Status

✅ **Stable and tested**

- Build passing
- E2E tests passing
- Unit tests passing (most)
- Production-ready
