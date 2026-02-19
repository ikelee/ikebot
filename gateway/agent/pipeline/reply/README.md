# Reply Pipeline - Complete Reorganization

**Last Updated**: February 15, 2026  
**Status**: ✅ Complete - Build passing, E2E tests passing

## Current Structure (No .ts files at root!)

```
reply/
├── README.md                           # This file
├── REORGANIZATION_SUMMARY.md          # Completion summary
│
├── agent-runner/                      # 🎯 Agent execution & orchestration
│   ├── core/                         # Main orchestrator + execution (agent-runner-*)
│   │   ├── agent-runner.ts           # Entry point
│   │   ├── agent-runner-*.ts         # Execution, helpers, memory, payloads, utils
│   │   └── *.test.ts                 # 19 test files
│   ├── session/                      # Session lifecycle (session*)
│   │   ├── session*.ts                # 5 source files
│   │   └── *.test.ts                 # 4 test files
│   ├── routing/                      # Request flow (router, route-reply, abort, etc.)
│   │   ├── request-router.ts         # Request classification
│   │   ├── route-reply.ts, abort.ts  # Reply routing, abort
│   │   ├── followup-runner.ts        # Followup execution
│   │   ├── memory-flush.ts           # Memory management
│   │   └── *.test.ts                 # 6 test files
│   ├── queue.ts, queue/              # Queue management + test
│   ├── exec.ts, exec/                # Execution directives
│   └── phases/                       # Multi-phase routing
│
├── commands/                          # 💬 Slash command handlers
│   ├── commands.ts                   # Command registry
│   ├── commands-*.ts                 # Individual handlers (20+ files)
│   ├── config-commands.ts            # Config commands
│   ├── debug-commands.ts             # Debug commands
│   └── *.test.ts                     # Command tests (6+ files)
│
├── directives/                        # 📋 Request directive handling
│   ├── directive-handling.ts         # Main entry point
│   ├── directive-handling-*.ts       # Specific handlers (11 files)
│   └── *.test.ts                     # Directive tests
│
├── reply-building/                    # 🏗️ Reply construction & dispatch
│   ├── get-reply.ts                  # Main entry point
│   ├── get-reply-*.ts                # Reply building logic (5 files)
│   ├── dispatch-from-config.ts       # Config-based dispatch
│   ├── normalize-reply.ts            # Reply normalization
│   ├── reply-*.ts                    # Reply utilities (10 files)
│   ├── provider-dispatcher.ts        # Provider dispatch
│   └── *.test.ts                     # Reply building tests
│
├── streaming/                         # 📡 Real-time streaming & typing
│   ├── block-reply-*.ts              # Block reply handling (3 files)
│   ├── typing*.ts                    # Typing indicators (3 files)
│   └── block-streaming.ts            # Streaming logic
│
├── utilities/                         # 🔧 Shared utility functions
│   ├── mentions.ts                   # Mention parsing
│   ├── model-selection.ts            # Model selection
│   ├── line-directives.ts            # Line directive parsing
│   ├── history.ts                    # History management
│   ├── inbound-*.ts                  # Inbound processing (4 files)
│   ├── bash-command.ts               # Bash execution
│   ├── body.ts                       # Body parsing
│   ├── groups.ts                     # Group management
│   ├── directives.ts                 # Directive types
│   ├── audio-tags.ts                 # Audio handling
│   ├── streaming-directives.ts       # Streaming directives
│   ├── subagents-utils.ts            # Subagent utilities
│   ├── stage-sandbox-media.ts        # Media staging
│   ├── response-prefix-template.ts   # Response templates
│   ├── config-value.ts               # Config utilities
│   ├── untrusted-context.ts          # Security utilities
│   ├── test-ctx.ts, test-helpers.ts  # Test utilities
│   └── *.test.ts                     # Utility tests
│
└── e2e/                               # 🧪 End-to-end integration tests
    └── tiered-routing.e2e.test.ts

```

## Key Changes from Original Organization

### Before

- **144 files** at root level
- **49 test files** mixed with implementation
- Flat structure, hard to navigate
- No logical grouping

### After

- **0 .ts files** at root level (only folders + docs)
- **Tests co-located** with their implementations
- **7 logical folders** with clear responsibilities
- **Hierarchical organization** easy to understand

## Folder Responsibilities

### `agent-runner/` - The Core Engine

**What it does**: Orchestrates agent execution, manages sessions, handles routing

**Key files**:

- `agent-runner.ts` - Main orchestrator
- Classification via `gateway/agent/run.ts` (RouterAgent)
- `routing/`, `phases/` - Multi-phase routing logic
- `session*.ts` - Session lifecycle
- `abort.ts` - Cancellation handling
- `memory-flush.ts` - Memory management
- `queue.ts`, `queue/` - Message queueing
- `exec.ts`, `exec/` - Execution directives

**Why here**: These are all core to how the agent runs and processes requests

### `commands/` - User Commands

**What it does**: Handles all `/` slash commands from users

**Examples**: `/info`, `/models`, `/status`, `/session`, `/compact`

**Why separate**: Commands are user-facing features, distinct from internal agent logic

### `directives/` - Request Processing

**What it does**: Parses and applies user directives (thinking levels, models, queues)

**Examples**: `@think:high`, `@model:claude`, `@queue:parallel`

**Why separate**: Directive handling is a distinct concern from reply building

### `reply-building/` - Message Construction

**What it does**: Builds the actual reply messages and dispatches them

**Key files**:

- `get-reply.ts` - Main entry point (THE entry point to reply pipeline)
- `dispatch-from-config.ts` - Routes to appropriate handler
- `reply-dispatcher.ts` - Sends replies to channels
- `reply-payloads.ts` - Builds message payloads

**Why separate**: Reply construction is distinct from agent execution

### `streaming/` - Real-time Updates

**What it does**: Handles block-by-block streaming and typing indicators

**Why separate**: Streaming is a specific feature, not core to message building

### `utilities/` - Shared Helpers

**What it does**: Common utilities used across multiple subsystems

**Examples**: parsing, formatting, validation, test helpers

**Why separate**: Prevents circular dependencies, makes reuse clear

### `e2e/` - Integration Tests

**What it does**: Full end-to-end tests that verify entire message flow

**Why separate**: E2E tests are different from unit tests (longer, need isolation)

## Import Conventions

From any subfolder to:

- **Gateway-level** (`infra/`, `models/`, `runtime/`): `../../../../`
- **Pipeline-level** (`thinking.ts`, `types.ts`, `templating.ts`): `../../`
- **Reply subfolders**: `../agent-runner/`, `../commands/`, `../utilities/`, etc.
- **Same folder**: `./`

## Entry Points

**Main Entry**: `reply-building/get-reply.ts` - Start here to understand the reply flow

**Key Flows**:

1. **Request → Reply**: `get-reply.ts` → `runAgentFlow` (run.ts) → `agent-runner.ts`
2. **Commands**: `commands.ts` → `commands-*.ts` handlers
3. **Streaming**: `streaming/block-reply-pipeline.ts` → `typing.ts`

## Testing

```bash
# All reply tests
pnpm test gateway/agent/pipeline/reply

# Specific folder
pnpm test gateway/agent/pipeline/reply/agent-runner
pnpm test gateway/agent/pipeline/reply/commands

# E2E only
pnpm test:e2e gateway/agent/e2e/reply
```

## Status: Complete ✅

**All tasks complete**:

- ✅ File organization complete
- ✅ Zero .ts files at root
- ✅ All folders logically grouped
- ✅ Tests co-located
- ✅ All imports fixed
- ✅ Build passing (6/6 targets)
- ✅ E2E tests passing (2/2 tests)

## Design Decisions

1. **routing/ and phases/ inside agent-runner/** - These are core routing features, not separate concerns
2. **exec/ and queue/ inside agent-runner/** - Execution and queueing are agent responsibilities
3. **session\* files in agent-runner/** - Sessions are managed by the agent runner
4. **Test files stay with code** - Makes it easy to find and update tests
5. **utilities/ for shared code** - Prevents circular dependencies

## Next Steps

1. ✅ Complete import fixes
2. ✅ Verify build succeeds
3. ✅ Run test suite
4. Review and iterate based on feedback
