import { completeSimple, type Api, type Model } from "@mariozechner/pi-ai";
import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig } from "../../../infra/config/config.js";
import { isLogFullModelIoEnabled, logVerbose, shouldLogVerbose } from "../../../globals.js";
import { logModelIo } from "../../../logging/model-io.js";
import { resolveOpenClawAgentDir } from "../../../runtime/agent-paths.js";
import { resolveModel } from "../../../runtime/pi-embedded-runner/model.js";
import { checkVerboseSentinelExists } from "../../../verbose-sentinel.js";
import {
  buildCompleteSimpleOptions,
  extractCompletionText,
  resolveCompleteSimpleApiKey,
} from "../llm-auth.js";

const execFileAsync = promisify(execFile);

const FINANCE_IMAGE_BATCH_RE = /\[media attached:\s*\d+\s*files?\]/i;
const FINANCE_PROCESS_SPENDINGS_RE = /\bprocess\b[\s\S]{0,80}\bspending(?:s)?\b/i;
const MEDIA_ITEM_RE =
  /\[media attached\s+\d+\/\d+:\s*([^\]\n]+?\.(?:png|jpe?g|webp|heic|heif|bmp|tiff?))\s*\([^)]+\)\s*(?:\|[^\]]*)?\]/gi;

type SpendingItem = {
  date?: string;
  amount?: number;
  merchant?: string;
  description?: string;
  source?: string;
  spender?: string;
  ownership?: "mine" | "not_mine" | "unknown";
  transactionType?: "expense" | "non_expense";
  category?: string;
  confidence?: number;
  sourceRef?: string;
};

function logFinanceStep(message: string): void {
  logVerbose(`[finance-intake] ${message}`);
}

function shouldLogFinanceDebug(): boolean {
  return shouldLogVerbose() || isLogFullModelIoEnabled() || checkVerboseSentinelExists();
}

const DATE_LINE_RE =
  /^\s*(?:Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)\s+\d{1,2}(?:,\s*\d{4})?\s*$/i;
const UI_NOISE_RE =
  /(?:home membership offers account|home rewards pay\/move help profile|available points|pending points|activity since|see details|learn more|pay it|plan it)$/i;
const AMOUNT_TOKEN_RE = /-?\$?\s*\d{1,4}(?:,\d{3})*\.\d{2}/g;
const OWNER_NAME_MINE_RE = /\b(?:ike|ike\s+l|eek\s+seung\s+lee|eek\s+lee|eek\s+l)\b/i;
const OWNER_NAME_NOT_MINE_RE = /\bhosuk\b/i;
const NON_EXPENSE_RE =
  /\b(?:payroll|salary|direct\s*deposit|deposit|payment\s+received|refund|reversal|cashback|interest|venmo|zelle|wire|ach|transfer|autopay|thank you)\b/i;
const MONTH_DAY_RE =
  /^\s*(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(\d{1,2})(?:,\s*(\d{4}))?\s*$/i;
const MM_DD_RE = /^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\s*$/;

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

function parseJsonArray(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const direct = JSON.parse(trimmed);
    return Array.isArray(direct) ? direct : [];
  } catch {
    // ignore
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      const parsed = JSON.parse(fence[1].trim());
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // ignore
    }
  }
  const bracketStart = trimmed.indexOf("[");
  const bracketEnd = trimmed.lastIndexOf("]");
  if (bracketStart >= 0 && bracketEnd > bracketStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(bracketStart, bracketEnd + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // ignore
    }
  }
  return [];
}

function normalizeSpendingItems(input: unknown[], sourceRef: string): SpendingItem[] {
  const out: SpendingItem[] = [];
  for (const row of input) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const r = row as Record<string, unknown>;
    const amountRaw = r.amount;
    const amount =
      typeof amountRaw === "number"
        ? amountRaw
        : typeof amountRaw === "string"
          ? Number(amountRaw.replace(/[^0-9.-]/g, ""))
          : undefined;
    if (!Number.isFinite(amount) || !amount || amount <= 0) {
      continue;
    }
    const item: SpendingItem = {
      date: normalizeDateValue(typeof r.date === "string" ? r.date : undefined),
      amount,
      merchant: typeof r.merchant === "string" ? r.merchant : undefined,
      description: typeof r.description === "string" ? r.description : undefined,
      source: normalizeSourceValue(typeof r.source === "string" ? r.source : undefined),
      spender: typeof r.spender === "string" ? r.spender : undefined,
      ownership:
        r.ownership === "not_mine"
          ? "not_mine"
          : r.ownership === "mine" || r.ownership === "unknown"
            ? "mine"
            : "mine",
      transactionType:
        r.transactionType === "non_expense"
          ? "non_expense"
          : inferTransactionTypeFromText(
              `${typeof r.description === "string" ? r.description : ""} ${typeof r.merchant === "string" ? r.merchant : ""} ${typeof r.source === "string" ? r.source : ""}`,
            ),
      category: typeof r.category === "string" ? r.category : "other",
      confidence: typeof r.confidence === "number" ? r.confidence : undefined,
      sourceRef,
    };
    out.push(item);
  }
  return out;
}

function normalizeDateValue(value: string | undefined): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw || /^not\s+specified$/i.test(raw)) {
    return undefined;
  }
  const monthDay = raw.match(MONTH_DAY_RE);
  if (monthDay) {
    const monthKey = (monthDay[1] ?? "").toLowerCase();
    const month = MONTH_INDEX[monthKey];
    const day = Number(monthDay[2]);
    const explicitYear = monthDay[3] ? Number(monthDay[3]) : undefined;
    if (Number.isFinite(month) && Number.isFinite(day)) {
      const year =
        explicitYear && Number.isFinite(explicitYear) ? explicitYear : new Date().getFullYear();
      return toIsoDate(year, month, day);
    }
  }
  const mmdd = raw.match(MM_DD_RE);
  if (mmdd) {
    const month = Number(mmdd[1]) - 1;
    const day = Number(mmdd[2]);
    const explicitYearRaw = mmdd[3];
    let year = new Date().getFullYear();
    if (explicitYearRaw) {
      const parsedYear = Number(explicitYearRaw);
      year = explicitYearRaw.length === 2 ? 2000 + parsedYear : parsedYear;
    }
    return toIsoDate(year, month, day);
  }
  const isoLike = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoLike) {
    return raw;
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return raw;
}

function toIsoDate(year: number, monthIndex: number, day: number): string {
  const utc = new Date(Date.UTC(year, monthIndex, day));
  return utc.toISOString().slice(0, 10);
}

function normalizeSourceValue(value: string | undefined): string {
  const raw = `${value ?? ""}`.trim();
  const t = raw.toLowerCase();
  if (!t) {
    return "unknown";
  }
  if (/(american express|amex|amex gold|blue cash|amex platinum)/.test(t)) {
    return "amex";
  }
  if (/(chase|jpmorgan)/.test(t) && /(debit|checking|total checking)/.test(t)) {
    return "chase_debit";
  }
  if (/(chase|jpmorgan)/.test(t) && /(credit|sapphire|freedom|slate|united)/.test(t)) {
    return "chase_credit";
  }
  if (/(capital one|capitalone|venture|quicksilver|savor)/.test(t)) {
    return "capital_one";
  }
  if (/(citibank|citi)/.test(t)) {
    return "citi";
  }
  if (/(bank of america|bofa)/.test(t)) {
    return "bank_of_america";
  }
  if (/wells fargo/.test(t)) {
    return "wells_fargo";
  }
  if (/discover/.test(t)) {
    return "discover";
  }
  if (/(apple card|apple cash)/.test(t)) {
    return "apple_card";
  }
  if (/(transaction list|ocr_deterministic|unknown|eek lee|hosuk lee|ike)/.test(t)) {
    return "unknown";
  }
  return "unknown";
}

function normalizeMerchant(value: string | undefined): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").replace(/[<>]/g, " ").trim();
}

function sanitizeOcrLine(line: string): string {
  return line
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanOcrText(rawOcr: string): string {
  if (!rawOcr.trim()) {
    return "";
  }
  const cleanedLines = rawOcr
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(sanitizeOcrLine)
    .filter((line) => {
      if (!line) {
        return false;
      }
      if (line.length <= 1) {
        return false;
      }
      if (UI_NOISE_RE.test(line)) {
        return false;
      }
      return true;
    });
  return cleanedLines.join("\n");
}

function inferCategoryFromText(text: string): SpendingItem["category"] {
  const t = text.toLowerCase();
  if (/(doordash|ubereats|coffee|cafe|restaurant|club|palace|neta|crust)/.test(t)) {
    return "dining";
  }
  if (/(market|grocery|trader|osaka|jagalchi)/.test(t)) {
    return "groceries";
  }
  if (/(airlines|hotel|lodging)/.test(t)) {
    return "travel";
  }
  if (/(warriors|ticket|movie|concert|entertainment)/.test(t)) {
    return "entertainment";
  }
  if (/(netflix|hulu|spotify|apple\.com\/bill)/.test(t)) {
    return "entertainment";
  }
  if (/(comcast|xfinity|utility|pg&e|electric|water|internet)/.test(t)) {
    return "utilities";
  }
  if (/(target|amazon|merchandise|artesanias|shopping)/.test(t)) {
    return "shopping";
  }
  return "other";
}

function inferTransactionTypeFromText(text: string): SpendingItem["transactionType"] {
  if (NON_EXPENSE_RE.test(text)) {
    return "non_expense";
  }
  return "expense";
}

function inferOwnershipAndSpender(text: string): Pick<SpendingItem, "ownership" | "spender"> {
  if (OWNER_NAME_NOT_MINE_RE.test(text)) {
    return { ownership: "not_mine", spender: "Hosuk Lee" };
  }
  if (OWNER_NAME_MINE_RE.test(text)) {
    return { ownership: "mine", spender: "Ike" };
  }
  return { ownership: "unknown", spender: undefined };
}

function parseAmountToken(token: string): number | undefined {
  const numeric = token.replace(/[$,\s]/g, "");
  const parsed = Number(numeric);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

export function extractDeterministicSpendingsFromOcr(params: {
  ocrText: string;
  sourceRef: string;
}): SpendingItem[] {
  const lines = cleanOcrText(params.ocrText).split("\n").filter(Boolean);
  const items: SpendingItem[] = [];
  let currentDate: string | undefined;
  let currentSource = normalizeSourceValue(params.ocrText);
  for (const line of lines) {
    const lineSource = normalizeSourceValue(line);
    if (lineSource !== "unknown") {
      currentSource = lineSource;
    }
    const lineOwnership = inferOwnershipAndSpender(line);
    if (lineOwnership.ownership !== "unknown") {
      const previous = items.at(-1);
      if (previous && previous.ownership === "unknown") {
        previous.ownership = lineOwnership.ownership;
        previous.spender = lineOwnership.spender;
      }
    }
    if (DATE_LINE_RE.test(line)) {
      currentDate = normalizeDateValue(line);
      continue;
    }
    const amountMatches = Array.from(line.matchAll(AMOUNT_TOKEN_RE)).map((m) => m[0] ?? "");
    if (!amountMatches.length) {
      continue;
    }
    if (amountMatches.length > 2) {
      continue;
    }
    const amountToken = amountMatches[amountMatches.length - 1];
    const amount = parseAmountToken(amountToken);
    if (!amount || amount <= 0) {
      continue;
    }
    const merchant = normalizeMerchant(
      line
        .replace(/^OCR-[A-Z]+:\s*/i, " ")
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
        .replace(/\b\d{1,2}\/\d{1,2}\b/g, " ")
        .replace(/\bcardholder\b.*$/i, " ")
        .replace(AMOUNT_TOKEN_RE, " ")
        .replace(/\b(?:pending|pay it|plan it|dining|lodging|merchandise)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    if (merchant.length < 3 || !/[a-z]/i.test(merchant)) {
      continue;
    }
    items.push({
      date: currentDate,
      amount,
      merchant,
      description: line,
      source: currentSource,
      spender: lineOwnership.spender,
      ownership: lineOwnership.ownership,
      transactionType: inferTransactionTypeFromText(line),
      category: inferCategoryFromText(line),
      confidence: 0.62,
      sourceRef: params.sourceRef,
    });
  }
  return defaultOwnershipToMine(dedupeSpendings(items));
}

function ownershipPriority(value: SpendingItem["ownership"]): number {
  if (value === "not_mine") {
    return 3;
  }
  if (value === "mine") {
    return 2;
  }
  if (value === "unknown") {
    return 1;
  }
  return 0;
}

function sourcePriority(value: string | undefined): number {
  const source = normalizeSourceValue(value);
  if (source === "unknown") {
    return 0;
  }
  if (
    source === "amex" ||
    source === "chase_debit" ||
    source === "chase_credit" ||
    source === "capital_one" ||
    source === "citi" ||
    source === "bank_of_america" ||
    source === "wells_fargo" ||
    source === "discover" ||
    source === "apple_card"
  ) {
    return 2;
  }
  return 1;
}

function dedupeSpendings(items: SpendingItem[]): SpendingItem[] {
  const byKey = new Map<string, SpendingItem>();
  for (const item of items) {
    const merchant = normalizeMerchant(item.merchant).toLowerCase();
    const cents = Math.round((item.amount ?? 0) * 100);
    const sourceRef = `${item.sourceRef ?? "unknown-source"}`.trim();
    if (!merchant || cents <= 0) {
      continue;
    }
    const key = `${sourceRef}|${merchant}|${cents}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, item);
      continue;
    }
    byKey.set(key, mergeSpendingPair(prev, item));
  }
  return Array.from(byKey.values());
}

function defaultOwnershipToMine(items: SpendingItem[]): SpendingItem[] {
  return items.map((item) => ({
    ...item,
    ownership: item.ownership === "not_mine" ? "not_mine" : "mine",
  }));
}

function mergeSpendingPair(prev: SpendingItem, item: SpendingItem): SpendingItem {
  const date = normalizeDateValue(item.date);
  const prevHasDate = Boolean(normalizeDateValue(prev.date));
  const nextHasDate = Boolean(date);
  const prevScore = (prev.confidence ?? 0) + (prevHasDate ? 0.2 : 0);
  const nextScore = (item.confidence ?? 0) + (nextHasDate ? 0.2 : 0);
  const merged: SpendingItem = { ...prev };
  if (nextScore > prevScore) {
    merged.date = item.date ?? merged.date;
    merged.merchant = item.merchant ?? merged.merchant;
    merged.description = item.description ?? merged.description;
    merged.source = item.source ?? merged.source;
    merged.category =
      item.category && item.category !== "other"
        ? item.category
        : (merged.category ?? item.category);
    merged.confidence = item.confidence ?? merged.confidence;
  } else {
    merged.date = merged.date ?? item.date;
    merged.merchant = merged.merchant ?? item.merchant;
    merged.description = merged.description ?? item.description;
    merged.source = merged.source ?? item.source;
    merged.category =
      merged.category && merged.category !== "other"
        ? merged.category
        : (item.category ?? merged.category);
    merged.confidence = Math.max(merged.confidence ?? 0, item.confidence ?? 0);
  }
  const prevOwnershipPriority = ownershipPriority(prev.ownership);
  const nextOwnershipPriority = ownershipPriority(item.ownership);
  if (nextOwnershipPriority > prevOwnershipPriority) {
    merged.ownership = item.ownership;
    merged.spender = item.spender ?? merged.spender;
  } else if (nextOwnershipPriority === prevOwnershipPriority && nextScore > prevScore) {
    merged.ownership = item.ownership ?? merged.ownership;
    merged.spender = item.spender ?? merged.spender;
  }
  const prevSourcePriority = sourcePriority(prev.source);
  const nextSourcePriority = sourcePriority(item.source);
  if (nextSourcePriority > prevSourcePriority) {
    merged.source = normalizeSourceValue(item.source);
  } else if (nextSourcePriority < prevSourcePriority) {
    merged.source = normalizeSourceValue(prev.source);
  } else if (nextScore > prevScore) {
    merged.source = normalizeSourceValue(item.source ?? prev.source);
  } else {
    merged.source = normalizeSourceValue(prev.source ?? item.source);
  }
  const prevType =
    prev.transactionType ??
    inferTransactionTypeFromText(`${prev.description ?? ""} ${prev.merchant ?? ""}`);
  const nextType =
    item.transactionType ??
    inferTransactionTypeFromText(`${item.description ?? ""} ${item.merchant ?? ""}`);
  merged.transactionType =
    prevType === "non_expense" || nextType === "non_expense" ? "non_expense" : "expense";
  return merged;
}

function dedupeSpendingsAcrossBatch(items: SpendingItem[]): SpendingItem[] {
  const byKey = new Map<string, SpendingItem>();
  for (const item of items) {
    const merchant = normalizeMerchant(item.merchant).toLowerCase();
    const date = normalizeDateValue(item.date) ?? "unknown-date";
    const cents = Math.round((item.amount ?? 0) * 100);
    if (!merchant || cents <= 0) {
      continue;
    }
    const key = `${date}|${merchant}|${cents}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, item);
      continue;
    }
    byKey.set(key, mergeSpendingPair(prev, item));
  }
  return Array.from(byKey.values());
}

function resolveWeeklyWindow(now: Date): { start: Date; end: Date; label: string } {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const day = (end.getDay() + 6) % 7;
  end.setDate(end.getDate() - day);
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  const label = `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)} (Mon-Mon)`;
  return { start, end, label };
}

function isInWindow(dateIso: string | undefined, window: { start: Date; end: Date }): boolean {
  if (!dateIso) {
    return false;
  }
  const parsed = Date.parse(dateIso);
  if (Number.isNaN(parsed)) {
    return false;
  }
  const t = new Date(parsed);
  return t >= window.start && t < window.end;
}

function formatSpendingsConfirmation(items: SpendingItem[]): string {
  if (!items.length) {
    return "I processed all images but couldn't extract spendings. Please resend clearer screenshots.";
  }
  const window = resolveWeeklyWindow(new Date());
  const expenseRows = items.filter((i) => {
    const dateIso = normalizeDateValue(i.date);
    const kind =
      i.transactionType ??
      inferTransactionTypeFromText(`${i.description ?? ""} ${i.merchant ?? ""}`);
    return kind === "expense" && isInWindow(dateIso, window);
  });
  const mine = expenseRows.filter((i) => i.ownership !== "not_mine");
  const notMine = expenseRows.filter((i) => i.ownership === "not_mine");
  const byCategory = new Map<string, SpendingItem[]>();
  for (const item of mine) {
    const key = (item.category || "other").toLowerCase();
    const rows = byCategory.get(key) ?? [];
    rows.push(item);
    byCategory.set(key, rows);
  }
  const catKeys = Array.from(byCategory.keys()).toSorted();
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  const lines: string[] = [];
  lines.push("Processed spendings from your screenshots. Please confirm/correct these items:");
  lines.push(`Window: ${window.label}`);
  lines.push("");
  for (const key of catKeys) {
    const rows = byCategory.get(key) ?? [];
    const subtotal = rows.reduce((sum, r) => sum + (r.amount ?? 0), 0);
    lines.push(`Category: ${key} (${fmt(subtotal)})`);
    for (const r of rows) {
      const date = r.date ?? "unknown-date";
      const merchant = r.merchant ?? r.description ?? "unknown merchant";
      lines.push(
        `- ${date} | ${merchant} | ${fmt(r.amount ?? 0)} | source=${normalizeSourceValue(r.source)}`,
      );
    }
    lines.push("");
  }
  if (notMine.length) {
    const subtotal = notMine.reduce((sum, r) => sum + (r.amount ?? 0), 0);
    lines.push(`Not mine (${fmt(subtotal)})`);
    for (const r of notMine) {
      const date = r.date ?? "unknown-date";
      const merchant = r.merchant ?? r.description ?? "unknown merchant";
      lines.push(
        `- ${date} | ${merchant} | ${fmt(r.amount ?? 0)} | source=${normalizeSourceValue(r.source)} | spender=${r.spender ?? "unknown"}`,
      );
    }
    lines.push("");
  }
  const gross = mine.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  lines.push(`Weekly gross total: ${fmt(gross)}`);
  const nonExpenseSaved = items.filter((i) => i.transactionType === "non_expense").length;
  if (nonExpenseSaved) {
    lines.push(
      `Saved ${nonExpenseSaved} non-expense transaction(s) to ledger history (excluded from weekly spend).`,
    );
  }
  lines.push("Reply with corrections and any split reminders to create.");
  return lines.join("\n");
}

async function runTesseract(imagePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tesseract", [imagePath, "stdout", "--psm", "6"], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return `${stdout ?? ""}`.trim();
  } catch {
    try {
      const { stdout } = await execFileAsync("tesseract", [imagePath, "stdout", "--psm", "4"], {
        maxBuffer: 10 * 1024 * 1024,
      });
      return `${stdout ?? ""}`.trim();
    } catch {
      return "";
    }
  }
}

async function extractSpendingsForImage(params: {
  ocrText: string;
  provider: string;
  modelId: string;
  cfg: OpenClawConfig;
}): Promise<{ raw: string; parsed: unknown[] }> {
  if (!params.ocrText.trim()) {
    return { raw: "", parsed: [] };
  }
  const agentDir = resolveOpenClawAgentDir();
  const resolved = resolveModel(params.provider, params.modelId, agentDir, params.cfg);
  if (!resolved.model) {
    return { raw: "", parsed: [] };
  }
  const model = resolved.model;
  const apiKey = await resolveCompleteSimpleApiKey({ model, cfg: params.cfg, agentDir });
  const systemPrompt = [
    "Extract spending transactions from OCR text.",
    "Return JSON array only.",
    "Each item should include: date, amount, merchant, description, source, spender, ownership, category, confidence.",
    "Set source to one of: amex, chase_debit, chase_credit, capital_one, citi, bank_of_america, wells_fargo, discover, apple_card, unknown.",
    "Use ownership=not_mine when spender is clearly not Ike or Eek Seung Lee.",
    "Use categories like: dining, groceries, music_hobby, travel, entertainment, transport, shopping, utilities, health, random, other.",
  ].join(" ");
  const response = await completeSimple(
    model,
    {
      systemPrompt,
      messages: [{ role: "user", content: params.ocrText, timestamp: Date.now() }],
    },
    buildCompleteSimpleOptions({
      model,
      apiKey,
      maxTokens: 2200,
      temperature: 0.1,
      reasoning: "minimal",
    }),
  );
  const raw = extractCompletionText(response);
  return { raw, parsed: parseJsonArray(raw) };
}

async function appendStagingRows(workspaceDir: string, items: SpendingItem[]): Promise<void> {
  const historyDir = path.join(workspaceDir, "history");
  await mkdir(historyDir, { recursive: true });
  const candidatePath = path.join(historyDir, "staging_candidates.jsonl");
  const batchPath = path.join(historyDir, "staging_batches.jsonl");
  if (items.length) {
    const rows = items.map((i) => JSON.stringify(i)).join("\n") + "\n";
    await appendFile(candidatePath, rows, "utf8");
  }
  const batch = {
    type: "batch",
    processedAt: new Date().toISOString(),
    candidateCount: items.length,
  };
  await appendFile(batchPath, `${JSON.stringify(batch)}\n`, "utf8");
}

function extractMediaPaths(cleanedBody: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = MEDIA_ITEM_RE.exec(cleanedBody)) !== null) {
    const p = (m[1] ?? "").trim();
    if (!p || seen.has(p)) {
      continue;
    }
    seen.add(p);
    out.push(p);
  }
  return out;
}

function normalizeMediaPaths(mediaPaths: string[] | undefined): string[] {
  if (!mediaPaths?.length) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const mediaPath of mediaPaths) {
    const normalized = `${mediaPath ?? ""}`.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function shouldRunFinanceIntakeWorkflow(
  cleanedBody: string,
  mediaPaths?: string[],
): boolean {
  const hasProcessIntent = FINANCE_PROCESS_SPENDINGS_RE.test(cleanedBody);
  if (!hasProcessIntent) {
    return false;
  }
  return normalizeMediaPaths(mediaPaths).length > 0 || FINANCE_IMAGE_BATCH_RE.test(cleanedBody);
}

export async function runFinanceIntakeWorkflow(params: {
  cleanedBody: string;
  mediaPaths?: string[];
  provider: string;
  model: string;
  cfg: OpenClawConfig;
  workspaceDir: string;
}): Promise<string | undefined> {
  if (!shouldRunFinanceIntakeWorkflow(params.cleanedBody, params.mediaPaths)) {
    return undefined;
  }
  const imagePaths = normalizeMediaPaths(params.mediaPaths);
  if (!imagePaths.length) {
    imagePaths.push(...extractMediaPaths(params.cleanedBody));
  }
  if (!imagePaths.length) {
    return undefined;
  }
  console.log(`[finance-intake] processing ${imagePaths.length} image(s)`);

  const allItems: SpendingItem[] = [];
  for (const imagePath of imagePaths) {
    console.log(`[finance-intake] OCR image: ${imagePath}`);
    logFinanceStep(`step=ocr_start source=${path.basename(imagePath)}`);
    const ocrTextRaw = await runTesseract(imagePath);
    if (shouldLogFinanceDebug()) {
      logModelIo(
        console.log,
        `[finance-intake] OCR raw source=${path.basename(imagePath)}`,
        ocrTextRaw,
        true,
      );
    }
    const ocrText = cleanOcrText(ocrTextRaw);
    console.log(`[finance-intake] OCR chars=${ocrText.length} source=${path.basename(imagePath)}`);
    if (shouldLogFinanceDebug()) {
      logModelIo(
        console.log,
        `[finance-intake] OCR cleaned source=${path.basename(imagePath)}`,
        ocrText,
        true,
      );
    }
    const sourceRef = path.basename(imagePath);
    const deterministic = extractDeterministicSpendingsFromOcr({ ocrText, sourceRef });
    if (shouldLogFinanceDebug()) {
      logModelIo(
        console.log,
        `[finance-intake] deterministic parsed source=${sourceRef}`,
        JSON.stringify(deterministic, null, 2),
        true,
      );
    }
    const extracted = await extractSpendingsForImage({
      ocrText,
      provider: params.provider,
      modelId: params.model,
      cfg: params.cfg,
    });
    if (shouldLogFinanceDebug()) {
      logModelIo(console.log, `[finance-intake] llm raw source=${sourceRef}`, extracted.raw, true);
    }
    const llmItems = normalizeSpendingItems(extracted.parsed, sourceRef);
    if (shouldLogFinanceDebug()) {
      logModelIo(
        console.log,
        `[finance-intake] llm normalized source=${sourceRef}`,
        JSON.stringify(llmItems, null, 2),
        true,
      );
    }
    const merged = defaultOwnershipToMine(dedupeSpendings([...deterministic, ...llmItems]));
    if (shouldLogFinanceDebug()) {
      logModelIo(
        console.log,
        `[finance-intake] merged source=${sourceRef}`,
        JSON.stringify(merged, null, 2),
        true,
      );
    }
    console.log(
      `[finance-intake] image merge source=${sourceRef} deterministic=${deterministic.length} llm=${llmItems.length} merged=${merged.length}`,
    );
    logFinanceStep(
      `step=image_complete source=${sourceRef} deterministic=${deterministic.length} llm=${llmItems.length} merged=${merged.length}`,
    );
    allItems.push(...merged);
  }

  const dedupedBatch = dedupeSpendingsAcrossBatch(defaultOwnershipToMine(allItems));
  await appendStagingRows(params.workspaceDir, dedupedBatch);
  console.log(`[finance-intake] extracted ${dedupedBatch.length} spending candidate(s)`);
  return formatSpendingsConfirmation(dedupedBatch);
}
