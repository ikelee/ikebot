import path from "node:path";
import type { OpenClawConfig } from "../infra/config/config.js";
import type {
  AgentPiConfig,
  PiBootstrapFileKey,
  ResolvedPiConfig,
} from "../infra/config/types.agents.js";
import { getAgentPiConfig } from "../agent/agents/pi-registry.js";
import { resolveStateDir } from "../infra/config/paths.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../infra/routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { expandToolGroups, TOOL_GROUPS } from "./tool-policy.js";

const FULL_BOOTSTRAP_FILES: PiBootstrapFileKey[] = [
  "AGENTS",
  "SOUL",
  "TOOLS",
  "IDENTITY",
  "USER",
  "HEARTBEAT",
  "MEMORY",
];

function getAllCoreTools(): string[] {
  return expandToolGroups(Object.keys(TOOL_GROUPS));
}
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

export { resolveAgentIdFromSessionKey } from "../infra/routing/session-key.js";

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

type ResolvedAgentConfig = {
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentEntry["model"];
  skills?: AgentEntry["skills"];
  memorySearch?: AgentEntry["memorySearch"];
  humanDelay?: AgentEntry["humanDelay"];
  heartbeat?: AgentEntry["heartbeat"];
  identity?: AgentEntry["identity"];
  groupChat?: AgentEntry["groupChat"];
  subagents?: AgentEntry["subagents"];
  sandbox?: AgentEntry["sandbox"];
  tools?: AgentEntry["tools"];
};

let defaultAgentWarned = false;

function listAgents(cfg: OpenClawConfig): AgentEntry[] {
  const list = cfg.agents?.list;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is AgentEntry => Boolean(entry && typeof entry === "object"));
}

export function listAgentIds(cfg: OpenClawConfig): string[] {
  const agents = listAgents(cfg);
  if (agents.length === 0) {
    return [DEFAULT_AGENT_ID];
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of agents) {
    const id = normalizeAgentId(entry?.id);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids.length > 0 ? ids : [DEFAULT_AGENT_ID];
}

export function resolveDefaultAgentId(cfg: OpenClawConfig): string {
  const agents = listAgents(cfg);
  if (agents.length === 0) {
    return DEFAULT_AGENT_ID;
  }
  const defaults = agents.filter((agent) => agent?.default);
  if (defaults.length > 1 && !defaultAgentWarned) {
    defaultAgentWarned = true;
    console.warn("Multiple agents marked default=true; using the first entry as default.");
  }
  const chosen = (defaults[0] ?? agents[0])?.id?.trim();
  return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}

export function resolveSessionAgentIds(params: { sessionKey?: string; config?: OpenClawConfig }): {
  defaultAgentId: string;
  sessionAgentId: string;
} {
  const defaultAgentId = resolveDefaultAgentId(params.config ?? {});
  const sessionKey = params.sessionKey?.trim();
  const normalizedSessionKey = sessionKey ? sessionKey.toLowerCase() : undefined;
  const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
  const sessionAgentId = parsed?.agentId ? normalizeAgentId(parsed.agentId) : defaultAgentId;
  return { defaultAgentId, sessionAgentId };
}

export function resolveSessionAgentId(params: {
  sessionKey?: string;
  config?: OpenClawConfig;
}): string {
  return resolveSessionAgentIds(params).sessionAgentId;
}

function resolveAgentEntry(cfg: OpenClawConfig, agentId: string): AgentEntry | undefined {
  const id = normalizeAgentId(agentId);
  return listAgents(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}

export function resolveAgentConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedAgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  const entry = resolveAgentEntry(cfg, id);
  if (!entry) {
    return undefined;
  }
  return {
    name: typeof entry.name === "string" ? entry.name : undefined,
    workspace: typeof entry.workspace === "string" ? entry.workspace : undefined,
    agentDir: typeof entry.agentDir === "string" ? entry.agentDir : undefined,
    model:
      typeof entry.model === "string" || (entry.model && typeof entry.model === "object")
        ? entry.model
        : undefined,
    skills: Array.isArray(entry.skills) ? entry.skills : undefined,
    memorySearch: entry.memorySearch,
    humanDelay: entry.humanDelay,
    heartbeat: entry.heartbeat,
    identity: entry.identity,
    groupChat: entry.groupChat,
    subagents: typeof entry.subagents === "object" && entry.subagents ? entry.subagents : undefined,
    sandbox: entry.sandbox,
    tools: entry.tools,
  };
}

export function resolveAgentSkillsFilter(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  const raw = resolveAgentConfig(cfg, agentId)?.skills;
  if (!raw) {
    return undefined;
  }
  const normalized = raw.map((entry) => String(entry).trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : [];
}

export function resolveAgentModelPrimary(cfg: OpenClawConfig, agentId: string): string | undefined {
  const raw = resolveAgentConfig(cfg, agentId)?.model;
  if (!raw) {
    return undefined;
  }
  if (typeof raw === "string") {
    return raw.trim() || undefined;
  }
  const primary = raw.primary?.trim();
  return primary || undefined;
}

export function resolveAgentModelFallbacksOverride(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  const raw = resolveAgentConfig(cfg, agentId)?.model;
  if (!raw || typeof raw === "string") {
    return undefined;
  }
  // Important: treat an explicitly provided empty array as an override to disable global fallbacks.
  if (!Object.hasOwn(raw, "fallbacks")) {
    return undefined;
  }
  return Array.isArray(raw.fallbacks) ? raw.fallbacks : undefined;
}

export function resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
  if (configured) {
    return resolveUserPath(configured);
  }
  const defaultAgentId = resolveDefaultAgentId(cfg);
  if (id === defaultAgentId) {
    const fallback = cfg.agents?.defaults?.workspace?.trim();
    if (fallback) {
      return resolveUserPath(fallback);
    }
    return resolveDefaultAgentWorkspaceDir(process.env);
  }
  const stateDir = resolveStateDir(process.env);
  return path.join(stateDir, `workspace-${id}`);
}

export function resolveAgentDir(cfg: OpenClawConfig, agentId: string) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
  if (configured) {
    return resolveUserPath(configured);
  }
  const root = resolveStateDir(process.env);
  return path.join(root, "agents", id, "agent");
}

const PI_PRESET_DEFAULTS: Record<
  NonNullable<AgentPiConfig["preset"]>,
  Pick<ResolvedPiConfig, "bootstrapFiles" | "promptMode" | "session" | "skills"> & {
    toolsAllow?: string[];
  }
> = {
  full: {
    bootstrapFiles: undefined,
    promptMode: "full",
    session: true,
    skills: true,
  },
  minimal: {
    bootstrapFiles: ["AGENTS", "TOOLS"] as PiBootstrapFileKey[],
    promptMode: "minimal",
    session: true,
    skills: false,
  },
  "exec-only": {
    bootstrapFiles: ["SOUL", "TOOLS"] as PiBootstrapFileKey[],
    promptMode: "minimal",
    session: true,
    skills: false,
    toolsAllow: ["exec"],
  },
  "messaging-only": {
    bootstrapFiles: ["SOUL", "TOOLS"] as PiBootstrapFileKey[],
    promptMode: "minimal",
    session: true,
    skills: false,
    toolsAllow: ["message", "sessions_list", "sessions_send"],
  },
};

/**
 * Resolve Pi runner config for an agent.
 * Agent-defined pi (from agent.ts) is the base; config agents.list[].pi overrides when present.
 */
export function resolvePiConfig(cfg: OpenClawConfig, agentId: string): ResolvedPiConfig {
  const agentPi = getAgentPiConfig(agentId);
  const entry = resolveAgentEntry(cfg, agentId);
  const configPi = entry?.pi;
  const pi = configPi ?? agentPi;
  const preset = pi?.preset ?? "full";
  const presetDefaults = PI_PRESET_DEFAULTS[preset];

  const bootstrapFiles = pi?.bootstrapFiles ?? presetDefaults.bootstrapFiles;
  const promptMode = pi?.promptMode ?? presetDefaults.promptMode;
  const session = pi?.session ?? presetDefaults.session;
  const skills = pi?.skills ?? presetDefaults.skills;

  let toolsAllow: string[] | undefined = presetDefaults.toolsAllow;
  let toolsDeny: string[] | undefined;
  if (pi?.tools) {
    if (pi.tools.allow && pi.tools.allow.length > 0) {
      toolsAllow = expandToolGroups(pi.tools.allow);
    }
    if (pi.tools.deny && pi.tools.deny.length > 0) {
      toolsDeny = expandToolGroups(pi.tools.deny);
    }
  }

  const bootstrapMaxChars = pi?.bootstrapMaxChars ?? cfg.agents?.defaults?.bootstrapMaxChars;

  return {
    bootstrapFiles,
    promptMode,
    session,
    toolsAllow,
    toolsDeny,
    skills,
    bootstrapMaxChars,
  };
}

/** Full resolved Pi config for display (includes bootstrapFiles and toolsAllow expanded for full preset). */
export function getResolvedPiConfigForDisplay(
  cfg: OpenClawConfig,
  agentId: string,
): {
  bootstrapFiles: string[];
  promptMode: string;
  session: boolean;
  toolsAllow: string[];
  toolsDeny?: string[];
  skills: boolean;
  bootstrapMaxChars?: number;
} {
  const resolved = resolvePiConfig(cfg, agentId);
  const bootstrapFiles =
    resolved.bootstrapFiles && resolved.bootstrapFiles.length > 0
      ? resolved.bootstrapFiles
      : FULL_BOOTSTRAP_FILES;
  const toolsAllow =
    resolved.toolsAllow && resolved.toolsAllow.length > 0 ? resolved.toolsAllow : getAllCoreTools();
  return {
    bootstrapFiles,
    promptMode: resolved.promptMode,
    session: resolved.session,
    toolsAllow,
    toolsDeny: resolved.toolsDeny,
    skills: resolved.skills,
    bootstrapMaxChars: resolved.bootstrapMaxChars,
  };
}
