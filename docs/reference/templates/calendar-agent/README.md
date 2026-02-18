# Calendar Agent Template

When the classifier routes a schedule/calendar query to the calendar agent, it uses this template.

## Setup

1. **Create the agent directory:**

   ```bash
   mkdir -p ~/.openclaw/agents/calendar/agent
   cp docs/reference/templates/calendar-agent/SOUL.md ~/.openclaw/agents/calendar/agent/
   cp docs/reference/templates/calendar-agent/TOOLS.md ~/.openclaw/agents/calendar/agent/
   ```

2. **Install and authenticate gog:**

   ```bash
   # Install (macOS)
   brew install steipete/tap/gogcli

   # Authenticate
   gog auth credentials /path/to/client_secret.json
   gog auth add you@gmail.com --services calendar
   gog auth list
   ```

3. **Add the calendar agent to config** (`~/.openclaw/config.json` or `openclaw config set`):

   ```json
   {
     "agents": {
       "list": [
         { "id": "main", "default": true },
         {
           "id": "calendar",
           "skills": ["gog"],
           "tools": {
             "exec": {
               "security": "allowlist",
               "safeBins": ["gog"]
             }
           },
           "pi": {
             "preset": "exec-only",
             "bootstrapFiles": ["SOUL", "TOOLS"],
             "promptMode": "minimal",
             "tools": { "allow": ["exec"] },
             "skills": false
           }
         }
       ]
     }
   }
   ```

   The `pi` block makes the calendar agent lighter: SOUL+TOOLS only, exec tool only, no skills in prompt. This reduces prompt size so smaller models (e.g. Qwen) can handle it instead of requiring Opus.

4. **Enable routing** (if not already):
   ```json
   {
     "agents": {
       "defaults": {
         "routing": {
           "enabled": true,
           "classifierModel": "ollama/llama-3.2-3b"
         }
       }
     }
   }
   ```

## Flow

1. User: "What's on my calendar today?"
2. Classifier → `calendar`
3. Calendar agent runs with SOUL.md + TOOLS.md, uses gog via exec
4. Reply with events
