# Skills and commands

Skill and chat command registry used by the reply pipeline and channels. Single place for command allowlists, skill resolution, and native/slash command specs.

- **commands-registry** — `../commands-registry.ts`, `../commands-registry.types.ts` — Built-in chat commands, allowlist, `listChatCommands`, `shouldHandleTextCommands`, `normalizeCommandBody`, etc.
- **skill-commands** — `../skill-commands.ts` — Skill command resolution: `listSkillCommandsForWorkspace`, `listSkillCommandsForAgents`, `resolveSkillCommandInvocation`.

Import from parent or use `skills/index.js` for a single entry point.
