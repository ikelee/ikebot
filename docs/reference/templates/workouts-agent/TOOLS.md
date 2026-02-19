# Workouts Agent - Tool Notes

Use `read` and `write` in workspace.

Allowed files: `workouts.json`, `workout-notes.txt`, `workout-memo-*.md`, `history/`, `*.json`.

## Source of truth

`workouts.json` is canonical for workout data and `personalBests`. Do not rely on `workout_logs.txt`.

## Required patterns

- Always read before write.
- Preserve existing keys in `workouts.json` (`profile`, `program`, `workouts`, `personalBests`, others).
- When logging a workout: append to `workouts`; update `personalBests` when PR is exceeded.

## Query behavior

- For PR/progress/history questions: read `workouts.json` first.
- Read `workout-notes.txt` when restrictions matter.
- Never claim data is missing unless a read confirms it.
