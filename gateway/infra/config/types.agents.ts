import type { ChatType } from "../../entrypoints/channels/chat-type.js";
import type { AgentDefaultsConfig } from "./types.agent-defaults.js";
import type { HumanDelayConfig, IdentityConfig } from "./types.base.js";
import type { GroupChatConfig } from "./types.messages.js";
import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.sandbox.js";
import type { AgentToolsConfig, MemorySearchConfig } from "./types.tools.js";

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
    };

export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentModelConfig;
  /** Optional allowlist of skills for this agent (omit = all skills; empty = none). */
  skills?: string[];
  memorySearch?: MemorySearchConfig;
  /** Human-like delay between block replies for this agent. */
  humanDelay?: HumanDelayConfig;
  /** Optional per-agent heartbeat overrides. */
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  subagents?: {
    /** Allow spawning sub-agents under other agent ids. Use "*" to allow any. */
    allowAgents?: string[];
    /** Per-agent default model for spawned sub-agents (string or {primary,fallbacks}). */
    model?: string | { primary?: string; fallbacks?: string[] };
  };
  sandbox?: {
    mode?: "off" | "non-main" | "all";
    /** Agent workspace access inside the sandbox. */
    workspaceAccess?: "none" | "ro" | "rw";
    /**
     * Session tools visibility for sandboxed sessions.
     * - "spawned": only allow session tools to target sessions spawned from this session (default)
     * - "all": allow session tools to target any session
     */
    sessionToolsVisibility?: "spawned" | "all";
    /** Container/workspace scope for sandbox isolation. */
    scope?: "session" | "agent" | "shared";
    /** Legacy alias for scope ("session" when true, "shared" when false). */
    perSession?: boolean;
    workspaceRoot?: string;
    /** Docker-specific sandbox overrides for this agent. */
    docker?: SandboxDockerSettings;
    /** Optional sandboxed browser overrides for this agent. */
    browser?: SandboxBrowserSettings;
    /** Auto-prune overrides for this agent. */
    prune?: SandboxPruneSettings;
  };
  tools?: AgentToolsConfig;
  /** Pi runner allowlist: bootstrap, tools, skills, prompt mode. Omit = full behavior. */
  pi?: AgentPiConfig;
};

/** Short keys for bootstrap file filtering (map to AGENTS.md, SOUL.md, etc.). */
export type PiBootstrapFileKey =
  | "AGENTS"
  | "SOUL"
  | "TOOLS"
  | "IDENTITY"
  | "USER"
  | "HEARTBEAT"
  | "MEMORY";

export type AgentPiConfig = {
  preset?: "full" | "minimal" | "exec-only" | "messaging-only";
  bootstrapFiles?: PiBootstrapFileKey[];
  promptMode?: "full" | "minimal" | "none";
  session?: boolean;
  tools?: { profile?: string; allow?: string[]; deny?: string[] };
  skills?: boolean;
  bootstrapMaxChars?: number;
  /** Toggle system prompt sections for leaner local agent prompts. */
  promptSections?: {
    safety?: boolean;
    cliQuickRef?: boolean;
    reasoningFormat?: boolean;
  };
  /** Optional per-agent stream overrides for embedded runs. */
  stream?: {
    maxTokens?: number;
    temperature?: number;
  };
};

export type ResolvedPiConfig = {
  bootstrapFiles?: PiBootstrapFileKey[];
  promptMode: "full" | "minimal" | "none";
  session: boolean;
  toolsAllow?: string[];
  toolsDeny?: string[];
  skills: boolean;
  bootstrapMaxChars?: number;
  promptSections?: {
    safety?: boolean;
    cliQuickRef?: boolean;
    reasoningFormat?: boolean;
  };
  stream?: {
    maxTokens?: number;
    temperature?: number;
  };
};

export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
};

export type AgentBinding = {
  agentId: string;
  match: {
    channel: string;
    accountId?: string;
    peer?: { kind: ChatType; id: string };
    guildId?: string;
    teamId?: string;
    /** Discord role IDs used for role-based routing. */
    roles?: string[];
  };
};
