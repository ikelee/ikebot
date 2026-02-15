# Entrypoints

Ways the agent is invoked: channels (Telegram, Discord, Signal, Slack, Line, Web, iMessage, WhatsApp) and shared channel layer; optionally CLI/entry.

Channel adapters and CLI currently live at gateway root (`gateway/telegram/`, `gateway/entry/`, etc.); they can be moved under this folder in a later refactor.
