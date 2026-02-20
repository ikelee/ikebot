# Workouts Agent - Tool Notes

Use `read` and `write` in workspace.

Allowed files: `workouts.json`, `workout-notes.txt`, `workout-memo-*.md`, `history/`, `*.json`.

## Source of truth

`workouts.json` is canonical. Prefer v2 structure:

- `events`: canonical training log entries
- `views.personalBests`: derived summary from events
- `profile` / `program` / `constraints`: user setup and plan data

Do not rely on `workout_logs.txt`.

## Required patterns

- Always read before write.
- For lookup-style questions, prefer compact reads first:
  - `read(path: "workouts.json", jsonSummary: true, jsonSummaryKeys: ["personalBests","workouts"], jsonSummaryTail: 3)`
  - If needed, do a second read without `jsonSummary` for full details.
- Preserve existing keys in `workouts.json` (`profile`, `program`, `workouts`, `personalBests`, others).
- Prefer appending to `events` (v2 canonical). Legacy `workouts` may still exist for compatibility.
- When logging strength work, include enough metrics for PR derivation: exercise + weight + reps (+ sets when available).
- Never replace `workouts.json` with a partial object. Keep all existing top-level keys.
- For `write(path: "workouts.json")`, `content` must be raw JSON only (no prose, no markdown fences).

## Query behavior

- For PR/progress/history questions: read `workouts.json` first.
- Read `workout-notes.txt` only when restrictions/injuries are directly relevant and missing from `workouts.json.constraints`.
- Read `workout-memo-{id}.md` only for long-term preference/persona context, not PR/history lookups.
- Never claim data is missing unless a read confirms it.
- If profile onboarding fields are missing, collect:
  - program style
  - goals (1-3 priorities)
  - body weight (lb/kg)
  - equipment access
  - training days/week

## Round-trip limits

- For lookup questions (example: "What's my squat PR?", "summarize last 3 workouts"):
  - Target: 1 read + final answer.
  - Max: 2 reads before final answer.
- For write operations:
  - Target: read once, write once, final answer.
  - Max: 3 tool rounds.
