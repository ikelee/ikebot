---
title: "Mail Agent TOOLS"
summary: "Tool usage notes for the mail agent"
read_when:
  - Bootstrapping the mail agent
---

# Mail Agent - Tool Notes

## gog (Google Workspace CLI)

Use `gog` for Gmail. Ensure it is installed and authenticated:

- Setup: `gog auth add you@gmail.com --services gmail`
- Gmail search: `gog gmail search 'newer_than:7d' --max 10`
- Gmail messages search: `gog gmail messages search "in:inbox" --max 20 --account you@example.com`

### exec

You run gog via the exec tool. Ensure `gog` is in the agent's exec allowlist.

## sessions_spawn / sessions_list

Use sessions_spawn to hand off to calendar or reminders when the user wants to:

- Schedule a meeting from an email
- Set a reminder to reply
- Add something to calendar

Use sessions_list to see available agents before spawning.
