export type JsonObject = Record<string, unknown>;

export type JsonMemoryContract = {
  /** Array keys whose object entries should be appended uniquely instead of replaced. */
  appendObjectArrayKeys?: string[];
  /** Object keys whose properties should be shallow-merged instead of replaced. */
  mergeObjectKeys?: string[];
};

export function parseJsonObject(text: string): JsonObject | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

export function parseJsonObjectLenient(text: string): JsonObject | null {
  const direct = parseJsonObject(text);
  if (direct) {
    return direct;
  }

  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const parsed = parseJsonObject(fenced[1]);
    if (parsed) {
      return parsed;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = trimmed.slice(firstBrace, lastBrace + 1);
    const parsed = parseJsonObject(sliced);
    if (parsed) {
      return parsed;
    }
    const unescaped = sliced
      .replaceAll('\\"', '"')
      .replaceAll("\\n", "\n")
      .replaceAll("\\t", "\t")
      .replaceAll("\\r", "\r")
      .replaceAll("\\/", "/");
    const parsedUnescaped = parseJsonObject(unescaped);
    if (parsedUnescaped) {
      return parsedUnescaped;
    }
  }

  return null;
}

export function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function asObjectArray(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is JsonObject => !!entry && typeof entry === "object" && !Array.isArray(entry),
  );
}

export function mergeUniqueObjectArrays(existing: unknown, proposed: unknown): JsonObject[] {
  const before = asObjectArray(existing);
  const after = asObjectArray(proposed);
  if (before.length === 0) {
    return after;
  }
  if (after.length === 0) {
    return before;
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

function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function mergeJsonWithContract(
  existing: JsonObject,
  proposed: JsonObject,
  contract: JsonMemoryContract,
): JsonObject {
  const merged: JsonObject = { ...existing, ...proposed };
  for (const key of contract.appendObjectArrayKeys ?? []) {
    merged[key] = mergeUniqueObjectArrays(existing[key], proposed[key]);
  }
  for (const key of contract.mergeObjectKeys ?? []) {
    merged[key] = {
      ...asJsonObject(existing[key]),
      ...asJsonObject(proposed[key]),
    };
  }
  return merged;
}
