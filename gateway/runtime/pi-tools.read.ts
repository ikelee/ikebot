import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { detectMime } from "../media/mime.js";
import {
  asObjectArray,
  mergeJsonWithContract,
  parseJsonObject,
  parseJsonObjectLenient,
  stableStringify,
  type JsonObject,
} from "./json-memory.js";
import { assertSandboxPath, resolveSandboxPath } from "./sandbox-paths.js";
import { sanitizeToolResultImages } from "./tool-images.js";

// NOTE(steipete): Upstream read now does file-magic MIME detection; we keep the wrapper
// to normalize payloads and sanitize oversized images before they hit providers.
type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;
const log = createSubsystemLogger("agents/tools");
const JSON_SUMMARY_KEYS_LIMIT = 24;
const JSON_SUMMARY_TAIL_DEFAULT = 8;
const JSON_SUMMARY_TAIL_MAX = 64;
const WORKOUTS_JSON_FILE = "workouts.json";

type ToolExtensionContext = {
  root: string;
};

type ReadWriteToolExtension = {
  readonly name: string;
  extendRead?: (tool: AnyAgentTool, context: ToolExtensionContext) => AnyAgentTool;
  extendWrite?: (tool: AnyAgentTool, context: ToolExtensionContext) => AnyAgentTool;
};

function applyReadToolExtensions(
  base: AnyAgentTool,
  context: ToolExtensionContext,
  extensions: readonly ReadWriteToolExtension[],
): AnyAgentTool {
  return extensions.reduce((tool, extension) => {
    if (!extension.extendRead) {
      return tool;
    }
    return extension.extendRead(tool, context);
  }, base);
}

function applyWriteToolExtensions(
  base: AnyAgentTool,
  context: ToolExtensionContext,
  extensions: readonly ReadWriteToolExtension[],
): AnyAgentTool {
  return extensions.reduce((tool, extension) => {
    if (!extension.extendWrite) {
      return tool;
    }
    return extension.extendWrite(tool, context);
  }, base);
}

function looksLikeWorkoutWriteContent(content: string): boolean {
  return /\b(workout|workouts|personal best|pr|pb|reps?|sets?|bench|squat|deadlift|lb|lbs)\b/i.test(
    content,
  );
}

function defaultReadWriteExtensions(): readonly ReadWriteToolExtension[] {
  return [
    {
      name: "workouts-json",
      extendRead: (tool, context) => wrapWorkoutsJsonReadAliases(tool, context.root),
      extendWrite: (tool, context) => wrapWorkoutsJsonWriteGuard(tool, context.root),
    },
  ];
}

async function sniffMimeFromBase64(base64: string): Promise<string | undefined> {
  const trimmed = base64.trim();
  if (!trimmed) {
    return undefined;
  }

  const take = Math.min(256, trimmed.length);
  const sliceLen = take - (take % 4);
  if (sliceLen < 8) {
    return undefined;
  }

  try {
    const head = Buffer.from(trimmed.slice(0, sliceLen), "base64");
    return await detectMime({ buffer: head });
  } catch {
    return undefined;
  }
}

function rewriteReadImageHeader(text: string, mimeType: string): string {
  // pi-coding-agent uses: "Read image file [image/png]"
  if (text.startsWith("Read image file [") && text.endsWith("]")) {
    return `Read image file [${mimeType}]`;
  }
  return text;
}

async function normalizeReadImageResult(
  result: AgentToolResult<unknown>,
  filePath: string,
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];

  const image = content.find(
    (b): b is ImageContentBlock =>
      !!b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "image" &&
      typeof (b as { data?: unknown }).data === "string" &&
      typeof (b as { mimeType?: unknown }).mimeType === "string",
  );
  if (!image) {
    return result;
  }

  if (!image.data.trim()) {
    throw new Error(`read: image payload is empty (${filePath})`);
  }

  const sniffed = await sniffMimeFromBase64(image.data);
  if (!sniffed) {
    return result;
  }

  if (!sniffed.startsWith("image/")) {
    throw new Error(
      `read: file looks like ${sniffed} but was treated as ${image.mimeType} (${filePath})`,
    );
  }

  if (sniffed === image.mimeType) {
    return result;
  }

  const nextContent = content.map((block) => {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
      const b = block as ImageContentBlock & { mimeType: string };
      return { ...b, mimeType: sniffed } satisfies ImageContentBlock;
    }
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const b = block as TextContentBlock & { text: string };
      return {
        ...b,
        text: rewriteReadImageHeader(b.text, sniffed),
      } satisfies TextContentBlock;
    }
    return block;
  });

  return { ...result, content: nextContent };
}

type RequiredParamGroup = {
  keys: readonly string[];
  allowEmpty?: boolean;
  label?: string;
};

export const CLAUDE_PARAM_GROUPS = {
  read: [{ keys: ["path", "file_path"], label: "path (path or file_path)" }],
  write: [{ keys: ["path", "file_path"], label: "path (path or file_path)" }],
  edit: [
    { keys: ["path", "file_path"], label: "path (path or file_path)" },
    {
      keys: ["oldText", "old_string"],
      label: "oldText (oldText or old_string)",
    },
    {
      keys: ["newText", "new_string"],
      label: "newText (newText or new_string)",
    },
  ],
} as const;

// Normalize tool parameters from Claude Code conventions to pi-coding-agent conventions.
// Claude Code uses file_path/old_string/new_string while pi-coding-agent uses path/oldText/newText.
// This prevents models trained on Claude Code from getting stuck in tool-call loops.
export function normalizeToolParams(params: unknown): Record<string, unknown> | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  const normalized = { ...record };
  // file_path, filename → path (read, write, edit) – some models use alternate param names
  const pathAliases = ["file_path", "filename", "file"] as const;
  for (const alias of pathAliases) {
    if (
      alias in normalized &&
      typeof (normalized[alias] as string) === "string" &&
      !("path" in normalized)
    ) {
      normalized.path = normalized[alias];
      delete normalized[alias];
      break;
    }
  }
  // old_string → oldText (edit)
  if ("old_string" in normalized && !("oldText" in normalized)) {
    normalized.oldText = normalized.old_string;
    delete normalized.old_string;
  }
  // new_string → newText (edit)
  if ("new_string" in normalized && !("newText" in normalized)) {
    normalized.newText = normalized.new_string;
    delete normalized.new_string;
  }
  return normalized;
}

export function patchToolSchemaForClaudeCompatibility(tool: AnyAgentTool): AnyAgentTool {
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : undefined;

  if (!schema || !schema.properties || typeof schema.properties !== "object") {
    return tool;
  }

  const properties = { ...(schema.properties as Record<string, unknown>) };
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  let changed = false;

  const aliasPairs: Array<{ original: string; alias: string }> = [
    { original: "path", alias: "file_path" },
    { original: "oldText", alias: "old_string" },
    { original: "newText", alias: "new_string" },
  ];

  for (const { original, alias } of aliasPairs) {
    if (!(original in properties)) {
      continue;
    }
    if (!(alias in properties)) {
      properties[alias] = properties[original];
      changed = true;
    }
    const idx = required.indexOf(original);
    if (idx !== -1) {
      required.splice(idx, 1);
      changed = true;
    }
  }

  if (!changed) {
    return tool;
  }

  return {
    ...tool,
    parameters: {
      ...schema,
      properties,
      required,
    },
  };
}

export function assertRequiredParams(
  record: Record<string, unknown> | undefined,
  groups: readonly RequiredParamGroup[],
  toolName: string,
): void {
  if (!record || typeof record !== "object") {
    throw new Error(`Missing parameters for ${toolName}`);
  }

  for (const group of groups) {
    const satisfied = group.keys.some((key) => {
      if (!(key in record)) {
        return false;
      }
      const value = record[key];
      if (typeof value !== "string") {
        return false;
      }
      if (group.allowEmpty) {
        return true;
      }
      return value.trim().length > 0;
    });

    if (!satisfied) {
      const label = group.label ?? group.keys.join(" or ");
      throw new Error(`Missing required parameter: ${label}`);
    }
  }
}

// Generic wrapper to normalize parameters for any tool
export function wrapToolParamNormalization(
  tool: AnyAgentTool,
  requiredParamGroups?: readonly RequiredParamGroup[],
): AnyAgentTool {
  const patched = patchToolSchemaForClaudeCompatibility(tool);
  return {
    ...patched,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      const normalizedToolName = String(tool.name || "")
        .trim()
        .toLowerCase();
      if (
        normalizedToolName === "write" &&
        record &&
        typeof record.path !== "string" &&
        typeof record.content === "string"
      ) {
        if (looksLikeWorkoutWriteContent(record.content)) {
          record.path = WORKOUTS_JSON_FILE;
        }
      }
      if (requiredParamGroups?.length) {
        assertRequiredParams(record, requiredParamGroups, tool.name);
      }
      if (normalizedToolName === "write") {
        const pathValue = typeof record?.path === "string" ? record.path : "(missing)";
        const contentChars =
          typeof record?.content === "string" ? String(record.content.length) : "(missing)";
        log.info(
          `[tool-call] normalized tool=write path=${pathValue} contentChars=${contentChars}`,
        );
      }
      return tool.execute(toolCallId, normalized ?? params, signal, onUpdate);
    },
  };
}

function wrapSandboxPathGuard(tool: AnyAgentTool, root: string): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const normalized = normalizeToolParams(args);
      const record =
        normalized ??
        (args && typeof args === "object" ? (args as Record<string, unknown>) : undefined);
      const filePath = record?.path;
      if (typeof filePath === "string" && filePath.trim()) {
        await assertSandboxPath({ filePath, cwd: root, root });
      }
      return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
    },
  };
}

/**
 * Check if a path (relative to workspace root) matches any allowed pattern.
 * Patterns: exact file ("workouts.json"), directory prefix ("history/"), or glob ("*.json").
 */
export function isPathAllowed(relativePath: string, allowedPaths: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  if (!normalized) {
    return false;
  }
  for (const pattern of allowedPaths) {
    const p = pattern.replace(/\\/g, "/").trim();
    if (!p) {
      continue;
    }
    if (normalized === p) {
      return true;
    }
    if (p.endsWith("/") && (normalized === p.slice(0, -1) || normalized.startsWith(p))) {
      return true;
    }
    if (p.endsWith("/*") && normalized.startsWith(p.slice(0, -2))) {
      return true;
    }
    const re = p.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : `\\${c}`));
    if (new RegExp(`^${re}$`).test(normalized)) {
      return true;
    }
  }
  return false;
}

export function wrapAllowedPathsGuard(
  tool: AnyAgentTool,
  root: string,
  allowedPaths: string[],
): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const normalized = normalizeToolParams(args);
      const record =
        normalized ??
        (args && typeof args === "object" ? (args as Record<string, unknown>) : undefined);
      const filePath = record?.path;
      if (typeof filePath === "string" && filePath.trim()) {
        const { relative } = resolveSandboxPath({ filePath, cwd: root, root });
        if (!isPathAllowed(relative, allowedPaths)) {
          if (allowedPaths.length === 0) {
            throw new Error(
              "File access denied: no allowlisted paths configured in openclaw.json (tools.files.allowedPaths or agents.<id>.tools.files.allowedPaths).",
            );
          }
          throw new Error(
            `Path not allowed: ${filePath}. This agent may only access: ${allowedPaths.join(", ")}`,
          );
        }
      }
      return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
    },
  };
}

function applyAllowedPathsIfNeeded(
  tool: AnyAgentTool,
  root: string,
  allowedPaths?: string[],
): AnyAgentTool {
  if (!allowedPaths) {
    return tool;
  }
  return wrapAllowedPathsGuard(tool, root, allowedPaths);
}

function wrapWorkoutsJsonReadAliases(tool: AnyAgentTool, root: string): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const normalized = normalizeToolParams(args);
      const record =
        normalized ??
        (args && typeof args === "object" ? (args as Record<string, unknown>) : undefined);
      const filePath = typeof record?.path === "string" ? record.path.trim() : "";
      if (!filePath || !record) {
        return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
      }
      const resolved = resolveSandboxPath({ filePath, cwd: root, root });
      const baseName = path.basename(resolved.resolved).toLowerCase();
      if (baseName !== WORKOUTS_JSON_FILE) {
        return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
      }
      const mapped = { ...record };
      if (typeof mapped.summary === "boolean" && typeof mapped.jsonSummary !== "boolean") {
        mapped.jsonSummary = mapped.summary;
      }
      if (Array.isArray(mapped.summary_keys) && !Array.isArray(mapped.jsonSummaryKeys)) {
        mapped.jsonSummaryKeys = mapped.summary_keys;
      }
      if (typeof mapped.summary_tail === "number" && typeof mapped.jsonSummaryTail !== "number") {
        mapped.jsonSummaryTail = mapped.summary_tail;
      }
      return tool.execute(toolCallId, mapped, signal, onUpdate);
    },
  };
}

export function extendOpenClawReadTool(tool: AnyAgentTool, root: string): AnyAgentTool {
  return applyReadToolExtensions(tool, { root }, defaultReadWriteExtensions());
}

export function extendOpenClawWriteTool(tool: AnyAgentTool, root: string): AnyAgentTool {
  return applyWriteToolExtensions(tool, { root }, defaultReadWriteExtensions());
}

export function createSandboxedReadTool(root: string, allowedPaths?: string[]) {
  const base = createReadTool(root) as unknown as AnyAgentTool;
  const withReadExtensions = extendOpenClawReadTool(createOpenClawReadTool(base), root);
  const guarded = wrapSandboxPathGuard(withReadExtensions, root);
  return applyAllowedPathsIfNeeded(guarded, root, allowedPaths);
}

export function createSandboxedWriteTool(root: string, allowedPaths?: string[]) {
  const base = createWriteTool(root) as unknown as AnyAgentTool;
  const guarded = extendOpenClawWriteTool(
    wrapSandboxPathGuard(wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.write), root),
    root,
  );
  return applyAllowedPathsIfNeeded(guarded, root, allowedPaths);
}

export function wrapWorkoutsJsonWriteGuard(tool: AnyAgentTool, root: string): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const normalized = normalizeToolParams(args);
      const record =
        normalized ??
        (args && typeof args === "object" ? (args as Record<string, unknown>) : undefined);
      const content = typeof record?.content === "string" ? record.content : null;
      const explicitPath = typeof record?.path === "string" ? record.path.trim() : "";
      const filePath =
        explicitPath ||
        (content && looksLikeWorkoutWriteContent(content) ? WORKOUTS_JSON_FILE : "");

      if (!filePath || content == null) {
        return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
      }

      const resolved = resolveSandboxPath({ filePath, cwd: root, root });
      const baseName = path.basename(resolved.resolved).toLowerCase();
      if (baseName !== WORKOUTS_JSON_FILE) {
        return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
      }

      const mergedContent = await mergeWorkoutsJsonWrite({
        targetPath: resolved.resolved,
        proposedContent: content,
      });
      const mergedParsed = parseJsonObject(mergedContent);
      const hasStrengthViews = !!(
        mergedParsed &&
        mergedParsed.views &&
        typeof mergedParsed.views === "object" &&
        !Array.isArray(mergedParsed.views) &&
        (mergedParsed.views as Record<string, unknown>).personalBests &&
        typeof (mergedParsed.views as Record<string, unknown>).personalBests === "object" &&
        !Array.isArray((mergedParsed.views as Record<string, unknown>).personalBests) &&
        ((mergedParsed.views as Record<string, unknown>).personalBests as Record<string, unknown>)
          .strength &&
        typeof (
          (mergedParsed.views as Record<string, unknown>).personalBests as Record<string, unknown>
        ).strength === "object"
      );
      log.info(
        `[tool-call] workouts-write-guard path=${resolved.relative} inChars=${content.length} outChars=${mergedContent.length} hasStrengthViews=${hasStrengthViews}`,
      );
      const nextArgs = {
        ...(normalized ?? (args as Record<string, unknown>)),
        path: filePath,
        content: mergedContent,
      };
      return tool.execute(toolCallId, nextArgs, signal, onUpdate);
    },
  };
}

function toWorkoutEntry(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.exercises)) {
    return record;
  }
  const name = typeof record.exercise === "string" ? record.exercise.trim() : "";
  if (!name) {
    return null;
  }
  const sets =
    typeof record.sets === "number"
      ? record.sets
      : typeof record.sets === "string"
        ? Number.parseFloat(record.sets)
        : undefined;
  const reps =
    typeof record.reps === "number"
      ? String(record.reps)
      : typeof record.reps === "string"
        ? record.reps
        : undefined;
  const weight =
    typeof record.weight === "number"
      ? String(record.weight)
      : typeof record.weight === "string"
        ? record.weight
        : undefined;
  return {
    date: typeof record.date === "string" && record.date.trim() ? record.date.trim() : undefined,
    type: typeof record.type === "string" && record.type.trim() ? record.type.trim() : "strength",
    exercises: [
      {
        name,
        ...(sets != null ? { sets } : {}),
        ...(reps ? { reps } : {}),
        ...(weight ? { weight } : {}),
      },
    ],
  };
}

function inferWorkoutFromContent(raw: string): Record<string, unknown> | null {
  const normalized = raw
    .replaceAll('\\"', '"')
    .replaceAll("\\n", "\n")
    .replaceAll("\\t", "\t")
    .replaceAll("\\r", "\r");
  const jsonLike = normalized.match(
    /"exercise"\s*:\s*"([^"]+)"[\s\S]*?"sets"\s*:\s*(\d+)[\s\S]*?"reps"\s*:\s*"?(\d+)"?[\s\S]*?"weight"\s*:\s*"?(\d+)"?/i,
  );
  if (jsonLike) {
    const [, exercise, sets, reps, weight] = jsonLike;
    return {
      type: "strength",
      exercises: [
        {
          name: exercise.trim(),
          sets: Number.parseInt(sets, 10),
          reps,
          weight,
        },
      ],
    };
  }
  const exercisesJsonLike = normalized.match(
    /"name"\s*:\s*"([^"]+)"[\s\S]*?"sets"\s*:\s*(\d+)[\s\S]*?"reps"\s*:\s*"?(\d+)"?[\s\S]*?"weight"\s*:\s*"?(\d+)"?/i,
  );
  if (exercisesJsonLike) {
    const [, exercise, sets, reps, weight] = exercisesJsonLike;
    return {
      type: "strength",
      exercises: [
        {
          name: exercise.trim(),
          sets: Number.parseInt(sets, 10),
          reps,
          weight,
        },
      ],
    };
  }
  const natural = normalized.match(
    /([A-Za-z][A-Za-z ]{1,40})\s+(\d+)\s*x\s*(\d+)\s*(?:at\s*)?(\d+)\s*(?:lb|lbs)?/i,
  );
  if (natural) {
    const [, exercise, sets, reps, weight] = natural;
    return {
      type: "strength",
      exercises: [
        {
          name: exercise.trim(),
          sets: Number.parseInt(sets, 10),
          reps,
          weight,
        },
      ],
    };
  }
  return null;
}

function inferPersonalBestOverrideFromContent(
  raw: string,
): Record<string, { weight?: number; reps?: number; date?: string }> | null {
  const normalized = raw
    .replaceAll('\\"', '"')
    .replaceAll("\\n", "\n")
    .replaceAll("\\t", "\t")
    .replaceAll("\\r", "\r");
  const overrideHint = /\b(override|set|log)\b[\s\S]{0,60}\b(personal best|pr|pb)\b/i.test(
    normalized,
  );
  if (!overrideHint) {
    return null;
  }
  const match =
    normalized.match(
      /\b(?:personal best|pr|pb)\s+for\s+([A-Za-z][A-Za-z ]{1,40}?)\s+(?:to|as)\s*(\d+)\s*(?:lb|lbs)?\s*(?:for|x)\s*(\d+)\s*reps?/i,
    ) ??
    normalized.match(
      /\b([A-Za-z][A-Za-z ]{1,40}?)\s+(?:to|as)\s*(\d+)\s*(?:lb|lbs)?\s*(?:for|x)\s*(\d+)\s*reps?/i,
    );
  if (!match) {
    return null;
  }
  const [, exercise, weight, reps] = match;
  return {
    [exercise.trim()]: {
      weight: Number.parseInt(weight, 10),
      reps: Number.parseInt(reps, 10),
    },
  };
}

function normalizePbRecord(
  value: unknown,
): { weight?: number; reps?: number; date?: string } | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return { weight: value };
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return { weight: parsed };
    }
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const weight =
    typeof record.weight === "number"
      ? record.weight
      : typeof record.weight === "string"
        ? Number.parseFloat(record.weight)
        : undefined;
  const reps =
    typeof record.reps === "number"
      ? record.reps
      : typeof record.reps === "string"
        ? Number.parseFloat(record.reps)
        : undefined;
  const date =
    typeof record.date === "string" && record.date.trim() ? record.date.trim() : undefined;
  return {
    weight: Number.isFinite(weight) ? weight : undefined,
    reps: Number.isFinite(reps) ? reps : undefined,
    date,
  };
}

function normalizeExerciseKey(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function resolveCanonicalPbKey(name: string, existingKeys: string[]): string {
  const normalizedName = normalizeExerciseKey(name);
  for (const key of existingKeys) {
    if (normalizeExerciseKey(key) === normalizedName) {
      return key;
    }
  }
  const pretty = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!pretty) {
    return name;
  }
  return pretty
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function betterPb(
  a: { weight?: number; reps?: number; date?: string } | null,
  b: { weight?: number; reps?: number; date?: string } | null,
): { weight?: number; reps?: number; date?: string } | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  const aw = a.weight ?? -Infinity;
  const bw = b.weight ?? -Infinity;
  if (bw > aw) {
    return b;
  }
  if (aw > bw) {
    return a;
  }
  const ar = a.reps ?? -Infinity;
  const br = b.reps ?? -Infinity;
  if (br > ar) {
    return b;
  }
  return a;
}

function mergePersonalBests(
  existing: unknown,
  proposed: unknown,
): Record<string, { weight?: number; reps?: number; date?: string }> {
  const before =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const after =
    proposed && typeof proposed === "object" && !Array.isArray(proposed)
      ? (proposed as Record<string, unknown>)
      : {};

  const canonicalAfter: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(after)) {
    const canonical = resolveCanonicalPbKey(name, Object.keys(before));
    canonicalAfter[canonical] = value;
  }
  const names = new Set<string>([...Object.keys(before), ...Object.keys(canonicalAfter)]);
  const merged: Record<string, { weight?: number; reps?: number; date?: string }> = {};
  for (const name of names) {
    const winner = betterPb(
      normalizePbRecord(before[name]),
      normalizePbRecord(canonicalAfter[name]),
    );
    if (!winner) {
      continue;
    }
    merged[name] = winner;
  }
  return merged;
}

function mergePersonalBestsOverride(
  existing: unknown,
  override: unknown,
): Record<string, { weight?: number; reps?: number; date?: string }> {
  const merged = mergePersonalBests(existing, existing);
  const updates =
    override && typeof override === "object" && !Array.isArray(override)
      ? (override as Record<string, unknown>)
      : {};
  for (const [name, value] of Object.entries(updates)) {
    const normalized = normalizePbRecord(value);
    if (!normalized) {
      continue;
    }
    const canonical = resolveCanonicalPbKey(name, Object.keys(merged));
    merged[canonical] = normalized;
  }
  return merged;
}

function parseLooseNumber(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return parseLooseNumber(first);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const direct = Number.parseFloat(trimmed);
  if (Number.isFinite(direct)) {
    return direct;
  }
  const matched = trimmed.match(/-?\d+(?:\.\d+)?/);
  if (!matched) {
    return undefined;
  }
  const parsed = Number.parseFloat(matched[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toEventEntry(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.modality === "string" &&
    typeof record.exercise === "string" &&
    record.metrics &&
    typeof record.metrics === "object" &&
    !Array.isArray(record.metrics)
  ) {
    return record;
  }
  const workout = toWorkoutEntry(record);
  if (!workout) {
    return null;
  }
  const exercises = asObjectArray(workout.exercises);
  const first = exercises[0];
  if (!first || typeof first.name !== "string") {
    return null;
  }
  return {
    timestamp: typeof workout.date === "string" ? workout.date : undefined,
    modality: typeof workout.type === "string" ? workout.type : "strength",
    exercise: first.name,
    metrics: {
      sets: parseLooseNumber(first.sets),
      reps: parseLooseNumber(first.reps),
      weightLb: parseLooseNumber(first.weight),
    },
  };
}

function mergeEvents(
  existing: unknown,
  proposed: unknown,
  proposedRoot: Record<string, unknown>,
): Record<string, unknown>[] {
  const before = asObjectArray(existing).map((entry) => toEventEntry(entry) ?? entry);
  const afterBase = asObjectArray(proposed).map((entry) => toEventEntry(entry) ?? entry);
  const singular = toEventEntry(proposedRoot.event ?? proposedRoot.workout);
  const after = singular ? [...afterBase, singular] : afterBase;
  if (before.length === 0) {
    return after;
  }
  if (after.length === 0) {
    return before;
  }
  if (after.length >= before.length) {
    return after;
  }
  const seen = new Set(before.map((entry) => stableStringify(entry)));
  const merged = [...before];
  for (const entry of after) {
    const key = stableStringify(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

function inferEventFromContent(raw: string): Record<string, unknown> | null {
  const inferredWorkout = inferWorkoutFromContent(raw);
  if (inferredWorkout) {
    return toEventEntry(inferredWorkout);
  }
  const normalized = raw
    .replaceAll('\\"', '"')
    .replaceAll("\\n", "\n")
    .replaceAll("\\t", "\t")
    .replaceAll("\\r", "\r");
  const exerciseMatch = normalized.match(/"exercise"\s*:\s*"([^"]+)"/i);
  if (!exerciseMatch?.[1]) {
    return null;
  }
  const modalityMatch = normalized.match(/"modality"\s*:\s*"([^"]+)"/i);
  const timestampMatch = normalized.match(/"timestamp"\s*:\s*"([^"]+)"/i);
  const setsMatch = normalized.match(/"sets"\s*:\s*(?:\[\s*)?"?(\d+(?:\.\d+)?)"?/i);
  const repsMatch = normalized.match(/"reps"\s*:\s*(?:\[\s*)?"?(\d+(?:\.\d+)?)"?/i);
  const weightMatch = normalized.match(
    /"(?:weightLb|weight)"\s*:\s*(?:\[\s*)?"?(\d+(?:\.\d+)?)"?/i,
  );
  const event: Record<string, unknown> = {
    modality: modalityMatch?.[1]?.trim() || "strength",
    exercise: exerciseMatch[1].trim(),
    metrics: {
      ...(setsMatch?.[1] ? { sets: Number.parseFloat(setsMatch[1]) } : {}),
      ...(repsMatch?.[1] ? { reps: Number.parseFloat(repsMatch[1]) } : {}),
      ...(weightMatch?.[1] ? { weightLb: Number.parseFloat(weightMatch[1]) } : {}),
    },
  };
  if (timestampMatch?.[1]) {
    event.timestamp = timestampMatch[1].trim();
  }
  return event;
}

function inferPersonalBestsFromEvents(
  events: Record<string, unknown>[],
): Record<string, { weight?: number; reps?: number; date?: string }> {
  const inferred: Record<string, { weight?: number; reps?: number; date?: string }> = {};
  for (const event of events) {
    const modality = typeof event.modality === "string" ? event.modality.toLowerCase() : "strength";
    if (modality !== "strength" && modality !== "endurance") {
      continue;
    }
    const name = typeof event.exercise === "string" ? event.exercise.trim() : "";
    if (!name) {
      continue;
    }
    const metrics =
      event.metrics && typeof event.metrics === "object" && !Array.isArray(event.metrics)
        ? (event.metrics as Record<string, unknown>)
        : {};
    const weight = parseLooseNumber(metrics.weightLb ?? metrics.weight);
    if (weight == null) {
      continue;
    }
    const reps = parseLooseNumber(metrics.reps);
    const date =
      typeof event.timestamp === "string" && event.timestamp.trim()
        ? event.timestamp.trim()
        : undefined;
    const candidate = normalizePbRecord({
      weight,
      ...(reps != null ? { reps } : {}),
      ...(date ? { date } : {}),
    });
    if (!candidate) {
      continue;
    }
    inferred[name] = betterPb(inferred[name] ?? null, candidate) ?? candidate;
  }
  return inferred;
}

function applyViewsPersonalBestsStrength(
  doc: Record<string, unknown>,
  personalBests: Record<string, { weight?: number; reps?: number; date?: string }>,
): void {
  const views =
    doc.views && typeof doc.views === "object" && !Array.isArray(doc.views)
      ? (doc.views as Record<string, unknown>)
      : {};
  const pbViews =
    views.personalBests &&
    typeof views.personalBests === "object" &&
    !Array.isArray(views.personalBests)
      ? (views.personalBests as Record<string, unknown>)
      : {};
  pbViews.strength = personalBests;
  views.personalBests = pbViews;
  doc.views = views;
}

function finalizeWorkoutsV2Document(doc: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...doc };
  const events = mergeEvents([], normalized.events, normalized);
  const combinedEvents = mergeEvents([], events, normalized);
  const existingStrength =
    normalized.views &&
    typeof normalized.views === "object" &&
    !Array.isArray(normalized.views) &&
    (normalized.views as Record<string, unknown>).personalBests &&
    typeof (normalized.views as Record<string, unknown>).personalBests === "object" &&
    !Array.isArray((normalized.views as Record<string, unknown>).personalBests) &&
    ((normalized.views as Record<string, unknown>).personalBests as Record<string, unknown>)
      .strength &&
    typeof ((normalized.views as Record<string, unknown>).personalBests as Record<string, unknown>)
      .strength === "object"
      ? (((normalized.views as Record<string, unknown>).personalBests as Record<string, unknown>)
          .strength as Record<string, unknown>)
      : {};
  const mergedPb = mergePersonalBests(
    existingStrength,
    inferPersonalBestsFromEvents(combinedEvents),
  );
  normalized.schemaVersion = 2;
  normalized.events = combinedEvents;
  applyViewsPersonalBestsStrength(normalized, mergedPb);
  delete normalized.personalBests;
  delete normalized.workouts;
  return normalized;
}

function enrichWorkoutsDocumentFromWorkouts(doc: Record<string, unknown>): Record<string, unknown> {
  return finalizeWorkoutsV2Document(doc);
}

async function mergeWorkoutsJsonWrite(params: {
  targetPath: string;
  proposedContent: string;
}): Promise<string> {
  let existingText = "";
  try {
    existingText = await fs.readFile(params.targetPath, "utf8");
  } catch {
    const proposed = parseJsonObjectLenient(params.proposedContent);
    if (proposed) {
      return JSON.stringify(enrichWorkoutsDocumentFromWorkouts(proposed), null, 2);
    }
    const inferredEvent = inferEventFromContent(params.proposedContent);
    const inferredPbOverride = inferPersonalBestOverrideFromContent(params.proposedContent);
    const bootstrap: Record<string, unknown> = {};
    if (inferredEvent) {
      bootstrap.events = [inferredEvent];
    }
    if (inferredPbOverride) {
      const mergedPb = mergePersonalBestsOverride({}, inferredPbOverride);
      applyViewsPersonalBestsStrength(bootstrap, mergedPb);
    }
    if (Object.keys(bootstrap).length > 0) {
      return JSON.stringify(finalizeWorkoutsV2Document(bootstrap), null, 2);
    }
    throw new Error("write(workouts.json): content must be a valid JSON object");
  }
  const existing = parseJsonObject(existingText);
  if (!existing) {
    const proposed = parseJsonObjectLenient(params.proposedContent);
    if (proposed) {
      return JSON.stringify(enrichWorkoutsDocumentFromWorkouts(proposed), null, 2);
    }
    throw new Error("write(workouts.json): content must be a valid JSON object");
  }

  const proposed = parseJsonObjectLenient(params.proposedContent);
  if (!proposed) {
    const inferredEvent = inferEventFromContent(params.proposedContent);
    const inferredPbOverride = inferPersonalBestOverrideFromContent(params.proposedContent);
    const merged: JsonObject = { ...existing };
    const events = asObjectArray(existing.events).map((entry) => toEventEntry(entry) ?? entry);
    if (inferredEvent) {
      const key = stableStringify(inferredEvent);
      const seen = new Set(events.map((entry) => stableStringify(entry)));
      if (!seen.has(key)) {
        events.push(inferredEvent);
      }
      merged.events = events;
    }
    if (inferredPbOverride) {
      const existingStrength =
        merged.views &&
        typeof merged.views === "object" &&
        !Array.isArray(merged.views) &&
        (merged.views as Record<string, unknown>).personalBests &&
        typeof (merged.views as Record<string, unknown>).personalBests === "object" &&
        !Array.isArray((merged.views as Record<string, unknown>).personalBests) &&
        ((merged.views as Record<string, unknown>).personalBests as Record<string, unknown>)
          .strength &&
        typeof ((merged.views as Record<string, unknown>).personalBests as Record<string, unknown>)
          .strength === "object"
          ? (((merged.views as Record<string, unknown>).personalBests as Record<string, unknown>)
              .strength as Record<string, unknown>)
          : {};
      const mergedPb = mergePersonalBestsOverride(existingStrength, inferredPbOverride);
      applyViewsPersonalBestsStrength(merged, mergedPb);
    }
    if (inferredEvent || inferredPbOverride) {
      return JSON.stringify(finalizeWorkoutsV2Document(merged), null, 2);
    }
    throw new Error(
      "write(workouts.json): content must include valid JSON or recognizable workout data",
    );
  }

  const merged = mergeJsonWithContract(existing, proposed, {
    appendObjectArrayKeys: ["events"],
    mergeObjectKeys: ["views"],
  });
  const mergedEvents = mergeEvents(existing.events, proposed.events, proposed);
  const beforeEvents = asObjectArray(existing.events);
  if (mergedEvents.length <= beforeEvents.length) {
    const inferredEvent = inferEventFromContent(params.proposedContent);
    if (inferredEvent) {
      const seen = new Set(mergedEvents.map((entry) => stableStringify(entry)));
      const key = stableStringify(inferredEvent);
      if (!seen.has(key)) {
        mergedEvents.push(inferredEvent);
      }
    }
  }
  merged.events = mergedEvents;
  const existingStrength =
    merged.views &&
    typeof merged.views === "object" &&
    !Array.isArray(merged.views) &&
    (merged.views as Record<string, unknown>).personalBests &&
    typeof (merged.views as Record<string, unknown>).personalBests === "object" &&
    !Array.isArray((merged.views as Record<string, unknown>).personalBests) &&
    ((merged.views as Record<string, unknown>).personalBests as Record<string, unknown>).strength &&
    typeof ((merged.views as Record<string, unknown>).personalBests as Record<string, unknown>)
      .strength === "object"
      ? (((merged.views as Record<string, unknown>).personalBests as Record<string, unknown>)
          .strength as Record<string, unknown>)
      : {};
  let mergedPb = mergePersonalBests(existingStrength, inferPersonalBestsFromEvents(mergedEvents));
  const inferredPbOverride = inferPersonalBestOverrideFromContent(params.proposedContent);
  if (inferredPbOverride) {
    mergedPb = mergePersonalBestsOverride(mergedPb, inferredPbOverride);
  }
  applyViewsPersonalBestsStrength(merged, mergedPb);
  return JSON.stringify(finalizeWorkoutsV2Document(merged), null, 2);
}

export function createSandboxedEditTool(root: string, allowedPaths?: string[]) {
  const base = createEditTool(root) as unknown as AnyAgentTool;
  const guarded = wrapSandboxPathGuard(
    wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.edit),
    root,
  );
  return applyAllowedPathsIfNeeded(guarded, root, allowedPaths);
}

export function createOpenClawReadTool(base: AnyAgentTool): AnyAgentTool {
  const patchedBase = patchToolSchemaForClaudeCompatibility(base);
  const patchedSchema =
    patchedBase.parameters && typeof patchedBase.parameters === "object"
      ? (patchedBase.parameters as Record<string, unknown>)
      : undefined;
  const patched =
    patchedSchema && patchedSchema.properties && typeof patchedSchema.properties === "object"
      ? ({
          ...patchedBase,
          parameters: {
            ...patchedSchema,
            properties: {
              ...(patchedSchema.properties as Record<string, unknown>),
              jsonSummary: {
                type: "boolean",
                description:
                  "If true and the target is a JSON file, return a compact structured summary instead of full JSON.",
              },
              jsonSummaryKeys: {
                type: "array",
                items: { type: "string" },
                description:
                  'Optional top-level keys to include in jsonSummary output. Example: ["events","views"].',
              },
              jsonSummaryTail: {
                type: "number",
                description:
                  "Optional tail size for arrays in jsonSummary output (default 8, max 64).",
              },
            },
          },
        } satisfies AnyAgentTool)
      : patchedBase;
  return {
    ...patched,
    execute: async (toolCallId, params, signal) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      assertRequiredParams(record, CLAUDE_PARAM_GROUPS.read, base.name);
      const normalizedPath = typeof record?.path === "string" ? String(record.path) : "(missing)";
      log.info(`[tool-call] normalized tool=read path=${normalizedPath}`);
      const result = await base.execute(toolCallId, normalized ?? params, signal);
      const filePath = typeof record?.path === "string" ? String(record.path) : "<unknown>";
      const normalizedResult = await normalizeReadImageResult(result, filePath);
      const summaryResult = maybeSummarizeJsonResult(normalizedResult, filePath, record);
      return sanitizeToolResultImages(summaryResult, `read:${filePath}`);
    },
  };
}

function toCompactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      count: value.length,
      tail: value.slice(-JSON_SUMMARY_TAIL_DEFAULT),
    };
  }
  if (value && typeof value === "object") {
    return {
      keys: Object.keys(value as Record<string, unknown>).slice(0, JSON_SUMMARY_KEYS_LIMIT),
    };
  }
  return value;
}

function summarizeJsonText(text: string, options: Record<string, unknown>): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const source = parsed as Record<string, unknown>;
  const requestedKeys = Array.isArray(options.jsonSummaryKeys)
    ? options.jsonSummaryKeys.filter((entry): entry is string => typeof entry === "string")
    : [];
  const tailRaw = Number(options.jsonSummaryTail);
  const tail = Number.isFinite(tailRaw)
    ? Math.max(1, Math.min(JSON_SUMMARY_TAIL_MAX, Math.floor(tailRaw)))
    : JSON_SUMMARY_TAIL_DEFAULT;
  const keys = requestedKeys.length > 0 ? requestedKeys : Object.keys(source);

  const summary: Record<string, unknown> = {
    _summary: true,
    _keys: Object.keys(source),
    _hint:
      "Summary view. Use read(path:..., jsonSummary:false) for full content, or pass jsonSummaryKeys/jsonSummaryTail to shape context.",
  };
  if (keys.includes("views")) {
    summary._lookupRule =
      "For PR lookup: use views.personalBests.strength. If exercise is missing, answer that it is not recorded and stop.";
  }
  if (keys.includes("events")) {
    summary._workoutRule =
      "Use events.tail for recent summaries. Avoid extra reads unless user asked for details not present here.";
  }

  for (const key of keys) {
    if (!(key in source)) {
      continue;
    }
    const value = source[key];
    if (key === "events" && Array.isArray(value)) {
      summary[key] = {
        count: value.length,
        tail: value.slice(-tail),
      };
      continue;
    }
    if (key === "views" && value && typeof value === "object") {
      summary[key] = value;
      continue;
    }
    summary[key] = toCompactJsonValue(value);
  }

  return JSON.stringify(summary, null, 2);
}

function maybeSummarizeJsonResult(
  result: AgentToolResult<unknown>,
  filePath: string,
  options: Record<string, unknown> | undefined,
): AgentToolResult<unknown> {
  if (!options || options.jsonSummary !== true) {
    return result;
  }
  if (!filePath.toLowerCase().endsWith(".json")) {
    return result;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  if (content.length === 0) {
    return result;
  }
  const next = content.map((block) => {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") {
      return block;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string" || !text.trim()) {
      return block;
    }
    const summarized = summarizeJsonText(text, options);
    if (!summarized) {
      return block;
    }
    return {
      ...(block as TextContentBlock),
      text: summarized,
    } satisfies TextContentBlock;
  });
  return { ...result, content: next };
}
