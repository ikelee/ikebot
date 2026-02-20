# Agent Onboarding Assumptions (Initial Pass)

This document captures the baseline onboarding assumptions used to scaffold agents before deeper product iteration.

## Workouts

- Canonical state file: `workouts.json` (schemaVersion 2 event-oriented structure).
- Supporting files:
  - `workout-notes.txt` (restrictions/injuries/freeform)
  - `workout-memo-{user}.md` (persona/preferences)
- Required onboarding fields:
  - `program`
  - `goals` (1-3 priorities)
  - `bodyWeight` (lb/kg)
  - `coachingStyle` (`supportive|assertive|aggressive`)
- Onboarding is intentionally one field at a time.

## Calendar

- Canonical state file: `calendar-settings.json`.
- Supporting files:
  - `calendar-notes.txt`
  - `calendar-memo-{user}.md`
- Required onboarding fields:
  - `calendarId` (usually account email)
  - `timezone` (IANA, e.g. `America/Los_Angeles`)
- Goal: safe defaults for query/scheduling behavior without requiring provider-specific setup details in this pass.

## Mail

- Canonical state file: `mail-settings.json`.
- Supporting files:
  - `mail-notes.txt`
  - `mail-memo-{user}.md`
- Required onboarding fields:
  - `accountEmail`
  - `summaryWindowDays`
- `includeFolders` defaults to `["inbox"]`.

## Reminders

- Canonical state file: `reminders.json`.
- Supporting files:
  - `reminders-notes.txt`
  - `reminders-memo-{user}.md`
- Required onboarding fields:
  - `timezone`
  - `defaultSnoozeMin`
- Reminder entries are stored in `reminders` array in the same canonical file.

## Shared Flow Assumptions

- Router remains model-based; no routing heuristics added.
- Once onboarding starts for an agent, the session is pinned to that agent until onboarding completes.
- Onboarding extraction uses the model (temperature 0) for flexible natural-language responses; no regex-only fallback parser for value extraction.
- Tests prioritize:
  - file initialization
  - step-by-step capture
  - completion behavior (no re-entry after completion)
