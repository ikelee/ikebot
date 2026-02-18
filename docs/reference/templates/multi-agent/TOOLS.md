---
title: "Multi Agent TOOLS"
summary: "Tool usage notes for the multi agent"
read_when:
  - Bootstrapping the multi agent
---

# Multi Agent - Tool Notes

## sessions_spawn

Use sessions_spawn to hand off to the agents specified in the orchestrate instruction. You may only spawn under agentIds that are both (a) in the orchestrate list for this request, and (b) in your subagents allowlist (calendar, workouts, finance, reminders).

### Spawning for cross-domain queries

When the user asks "what do I need to hit tomorrow at the gym?" or "I have 30 minutes at 8pm tomorrow, what workout fits?":

1. **Spawn calendar** with a task like: "List my calendar events for tomorrow. Include time blocks and free gaps."
   - `sessions_spawn({ task: "...", agentId: "calendar", label: "calendar" })`

2. **Spawn workouts** (if in orchestrate list) with a task like: "Based on my workout history, what should I hit for [body part] tomorrow? Consider progressive overload."
   - `sessions_spawn({ task: "...", agentId: "workouts", label: "workouts" })`

3. **Spawn finance** (if in orchestrate list) for budget/spending queries.
4. **Spawn reminders** (if in orchestrate list) for reminder creation.

5. Subagents run in the background. When they finish, they announce their findings to the chat. The user will see their replies.

6. Give a brief intro: "Checking your calendar and workout history. You'll see their replies below."

### Parameters

- `task` (required): Clear instruction for the subagent
- `agentId`: "calendar" or "workouts"
- `label`: Short label (e.g. "calendar", "workouts") for identification

### Limitation

Subagents announce when done. You do not receive their output in your tool result. The user sees the subagent replies in the chat. For synthesis, the user may need to ask a follow-up once both have replied, or you can suggest they check the replies and ask you to summarize.

## sessions_list, session_status

Use to check on spawned subagents if the user asks "are they done?" or "what's the status?".

## sessions_send

Use to send a follow-up message to a running subagent if needed (e.g. to refine the task).
