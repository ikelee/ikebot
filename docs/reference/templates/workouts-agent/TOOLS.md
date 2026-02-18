---
title: "Workouts Agent TOOLS"
summary: "Tool usage notes for the workouts agent"
read_when:
  - Bootstrapping the workouts agent
---

# Workouts Agent - Tool Notes

## read / write

Use read/write to maintain files in the workspace. Allowed paths: `workouts.json`, `workout-notes.txt`, `workout-memo-*.md`, `history/`, `*.json`.

**read(path)** – Pass the file path, e.g. `read(path: "workouts.json")`. Always read before writing.

### File roles

| File                 | Purpose                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workouts.json        | Stats: workout history, PRs, program (current day, cycle, day templates). Keep for ongoing statistics. Do not send full history to the model—summarize recent entries or query specific exercises. |
| workout-notes.txt    | Free-form notes: injuries, restrictions, limitations. Plain text.                                                                                                                                  |
| workout-memo-{id}.md | Per-user memo. `{id}` = sanitized session/user identifier. Store goals, preferences, patterns, program. Update this when the user shares preferences. Do not modify SOUL or TOOLS.                 |

### workouts.json (loose schema)

Structure is flexible. Common shape:

```json
{
  "profile": { "goals": [], "focus": "weights", "program": "5/3/1" },
  "personalBests": { "Bench Press": { "weight": 225, "reps": 5, "date": "2026-02-10" } },
  "program": {
    "name": "5/3/1",
    "cycleLength": 4,
    "currentDay": 2,
    "currentCycle": 1,
    "days": [
      {
        "dayNumber": 1,
        "exercises": [{ "name": "Bench Press", "sets": 3, "minReps": 5, "pushReps": 8 }]
      }
    ]
  },
  "workouts": [
    {
      "date": "2026-02-12",
      "type": "strength",
      "exercises": [{ "name": "Bench Press", "sets": 3, "reps": "10", "weight": "135" }]
    }
  ]
}
```

Extra keys are fine. When reading for context, prefer recent workouts (last 2–4 weeks) or targeted lookups.

### Logging a workout

**CRITICAL: Always read workouts.json first. Never write without reading.** The file must preserve `profile`, `personalBests`, `program`, and the `workouts` array. Append to `workouts`; never replace the whole file with a single workout object.

1. Parse what they did (exercise name, sets, reps, weight if given)
2. **Read** workouts.json (use `read` with path `workouts.json`)
3. Append the new entry to the `workouts` array
4. Optionally update `personalBests` if it's a PR
5. **Write** back the full JSON (all keys preserved)

### Progressive overload ("what weight should I hit for X today?")

1. Read workouts.json (or recent entries for that exercise)
2. Find the most recent entry for that exercise
3. Check workout-notes.txt for restrictions
4. If they hit the top of their rep range, suggest +2.5–5 lb
5. If they did not complete all reps, suggest same weight
6. If no history, suggest a conservative starting weight

### Weekly progress

1. Read workouts.json
2. Filter to current week (or last 7 days)
3. Summarize by type and volume

### Memo updates

When the user says "my goal is X" or "I follow program Y" or "I prefer cardio":

1. Resolve the memo filename from the session/user identifier: `workout-memo-{sanitized-id}.md`
2. Read the memo (or create if missing)
3. Append or update the relevant section
4. Write back
