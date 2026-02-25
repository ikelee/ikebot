import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../infra/config/config.js";
import { resolveStateDir } from "../../infra/config/paths.js";
import { resolveAgentWorkspaceDir } from "../../runtime/agent-scope.js";
import { resolveUserPath } from "../../utils.js";

type GmailHookMessage = {
  id?: string;
  messageId?: string;
  threadId?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  body?: string;
  labels?: string[];
};

type MailAttachment = {
  fileName: string;
  mime?: string;
  filePath?: string;
  textPath?: string;
  analysisStatus?: "ok" | "skipped" | "error";
  analysisError?: string;
};

type MailRecord = {
  id: string;
  dedupeKey: string;
  sourceId: string;
  sourcePath: string;
  folderHint: string;
  messageId?: string;
  threadId?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
  hasAttachment: boolean;
  attachmentCount: number;
  attachments: MailAttachment[];
  labels: string[];
  bodyText: string;
  importance: "important" | "not_important";
  importanceReasons: string[];
};

type IngestSummary = {
  outDir: string;
  ingested: number;
  duplicates: number;
  important: number;
  notImportant: number;
  failed: number;
};

type Checkpoint = {
  updatedAt: string;
  processedSourceIds: string[];
  processedCount: number;
  skippedDuplicateCount: number;
  importantCount: number;
  notImportantCount: number;
  failedCount: number;
};

type QwenDecision = {
  importance: "important" | "not_important";
  confidence: number;
  reasons: string[];
};

const dedupeCache = new Map<string, Set<string>>();

const IMPORTANT_SUBJECT = [
  /invoice/i,
  /receipt/i,
  /payment/i,
  /statement/i,
  /tax/i,
  /booking/i,
  /reservation/i,
  /confirmed/i,
  /confirmation/i,
  /flight/i,
  /itinerary/i,
  /order/i,
  /contract/i,
  /security alert/i,
  /verification code/i,
  /password reset/i,
  /due/i,
  /e-?transfer/i,
  /interac/i,
  /delivery/i,
  /shipped/i,
  /recruiter/i,
  /interview/i,
  /application/i,
  /job/i,
  /offer/i,
  /realtor/i,
  /real estate/i,
  /closing/i,
  /lawyer/i,
  /attorney/i,
  /legal/i,
  /docusign/i,
];
const IMPORTANT_FROM = [
  /billing/i,
  /support/i,
  /bank/i,
  /airline/i,
  /booking/i,
  /reservations?/i,
  /confirm/i,
  /receipts?/i,
  /recruiter/i,
  /talent/i,
  /careers?/i,
  /realtor/i,
  /realestate/i,
  /law/i,
  /legal/i,
  /attorney/i,
  /interac/i,
  /etransfer/i,
  /docusign/i,
  /courier/i,
  /shipping/i,
];
const PROMO_SUBJECT = [/newsletter/i, /digest/i, /coupon/i, /sale/i, /deal/i, /promo/i];
const PROMO_FROM = [/noreply/i, /news/i, /offers?/i, /marketing/i];
const LOW_VALUE_CI_SUBJECT = [/\[.+\/.+\].*run (failed|cancelled|canceled|started)/i, /\bci\b/i];
const LOW_VALUE_SOCIAL_SUBJECT = [/\btop post:\b/i, /\bneighbors?\b/i, /\bnextdoor\b/i];
const LEGAL_CLAIM_SIGNALS = [
  /\bclaim\b/i,
  /\badditional steps required\b/i,
  /\bclass action\b/i,
  /\bsettlement\b/i,
  /\bvenmo\b/i,
  /\bpaypal\b/i,
];

function nowIso(): string {
  return new Date().toISOString();
}

function sha1(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function decodeRfc2047Words(input: string): string {
  return input.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, _charset, enc, text) => {
    try {
      if (String(enc).toLowerCase() === "b") {
        return Buffer.from(String(text), "base64").toString("utf8");
      }
      const qp = String(text)
        .replace(/_/g, " ")
        .replace(/=([A-Fa-f0-9]{2})/g, (_m2: string, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        );
      return Buffer.from(qp, "binary").toString("utf8");
    } catch {
      return String(text);
    }
  });
}

function appendJsonl(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeQmdDoc(qmdDir: string, record: MailRecord): void {
  if (record.importance !== "important") {
    return;
  }
  const folder = path.join(qmdDir, "emails", "important");
  fs.mkdirSync(folder, { recursive: true });
  const outPath = path.join(folder, `${record.id}.md`);
  const frontmatter = [
    "---",
    `message_id: ${JSON.stringify(record.messageId ?? "")}`,
    `dedupe_key: ${JSON.stringify(record.dedupeKey)}`,
    `date: ${JSON.stringify(record.date ?? "")}`,
    `from: ${JSON.stringify(record.from ?? "")}`,
    `to: ${JSON.stringify(record.to ?? "")}`,
    `subject: ${JSON.stringify(record.subject ?? "")}`,
    `folder: ${JSON.stringify(record.folderHint)}`,
    `importance: ${JSON.stringify(record.importance)}`,
    `importance_reasons: ${JSON.stringify(record.importanceReasons)}`,
    `has_attachment: ${record.hasAttachment ? "true" : "false"}`,
    `attachment_count: ${record.attachmentCount}`,
    `attachments: ${JSON.stringify(
      record.attachments.map((att) => ({
        fileName: att.fileName,
        mime: att.mime,
        analysisStatus: att.analysisStatus,
      })),
    )}`,
    "---",
    "",
  ].join("\n");
  const body = record.bodyText.trim().length > 0 ? record.bodyText : "(no text extracted)";
  fs.writeFileSync(outPath, `${frontmatter}${body}\n`, "utf8");
}

function messageDedupeKey(msg: GmailHookMessage, bodyText: string): string {
  const messageId = (msg.messageId ?? msg.id ?? "").trim();
  if (messageId) {
    return `mid:${messageId.toLowerCase()}`;
  }
  const from = (msg.from ?? "").trim();
  const to = (msg.to ?? "").trim();
  const subject = (msg.subject ?? "").trim();
  const date = (msg.date ?? "").trim();
  return `hash:${sha1(`${from}|${to}|${subject}|${date}|${bodyText.slice(0, 1000)}`)}`;
}

function classifyImportance(msg: GmailHookMessage, bodyText: string) {
  const strongReasons: string[] = [];
  const weakReasons: string[] = [];
  const subject = decodeRfc2047Words(msg.subject ?? "");
  const from = msg.from ?? "";
  const hasLegalClaimSignal =
    LEGAL_CLAIM_SIGNALS.some((rx) => rx.test(subject)) ||
    LEGAL_CLAIM_SIGNALS.some((rx) => rx.test(bodyText));
  for (const rx of IMPORTANT_SUBJECT) {
    if (rx.test(subject)) {
      strongReasons.push(`subject:${rx.source}`);
      break;
    }
  }
  for (const rx of IMPORTANT_FROM) {
    if (rx.test(from)) {
      strongReasons.push(`from:${rx.source}`);
      break;
    }
  }
  if (
    /\b(receipt|invoice|ticket|tracking|flight|amount|due|e-?transfer|interac|recruiter|interview|job|realtor|tax|legal|lawyer|attorney|docusign|confirmation|reservation)\b/i.test(
      bodyText,
    )
  ) {
    weakReasons.push("entity_hint");
  }
  if (hasLegalClaimSignal) {
    weakReasons.push("legal_claim_signal");
  }
  const promoSignals =
    Number(PROMO_SUBJECT.some((rx) => rx.test(subject))) +
    Number(PROMO_FROM.some((rx) => rx.test(from)));
  if (strongReasons.length > 0) {
    return {
      importance: "important" as const,
      reasons: ["bucket:for_sure_important", ...strongReasons, ...weakReasons],
    };
  }
  if (
    !msg.labels?.includes("Important") &&
    LOW_VALUE_CI_SUBJECT.some((rx) => rx.test(subject)) &&
    !hasLegalClaimSignal
  ) {
    return {
      importance: "not_important" as const,
      reasons: ["bucket:for_sure_not_important", "ci_notification_noise"],
    };
  }
  if (
    (LOW_VALUE_SOCIAL_SUBJECT.some((rx) => rx.test(subject)) || /nextdoor/i.test(from)) &&
    !hasLegalClaimSignal
  ) {
    return {
      importance: "not_important" as const,
      reasons: ["bucket:for_sure_not_important", "social_digest_noise"],
    };
  }
  if (promoSignals >= 2 && weakReasons.length === 0 && !hasLegalClaimSignal) {
    return {
      importance: "not_important" as const,
      reasons: ["bucket:for_sure_not_important", "promo_combined_signals"],
    };
  }
  if (weakReasons.length > 0) {
    return { importance: "important" as const, reasons: ["bucket:maybe", ...weakReasons] };
  }
  return {
    importance: "important" as const,
    reasons: ["bucket:maybe", "default_keep_conservative"],
  };
}

function parseQwenDecision(raw: string): QwenDecision | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const obj = parsed as { importance?: unknown; confidence?: unknown; reasons?: unknown };
  if (obj.importance !== "important" && obj.importance !== "not_important") {
    return undefined;
  }
  const confidence =
    typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? Math.max(0, Math.min(1, obj.confidence))
      : 0;
  const reasons = Array.isArray(obj.reasons)
    ? obj.reasons.filter((v): v is string => typeof v === "string").slice(0, 6)
    : [];
  return { importance: obj.importance, confidence, reasons };
}

async function maybeClassifyWithQwen(params: {
  model: string;
  url: string;
  timeoutMs: number;
  minConfidence: number;
  record: MailRecord;
}): Promise<QwenDecision | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetch(params.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: params.model,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        messages: [
          {
            role: "system",
            content:
              'Classify email importance for personal retrieval. Return strict JSON only: {"importance":"important|not_important","confidence":0..1}',
          },
          {
            role: "user",
            content: `From: ${params.record.from ?? ""}\nSubject: ${params.record.subject ?? ""}\nBody: ${params.record.bodyText.slice(0, 500)}`,
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as {
      message?: { content?: string };
      response?: string;
    };
    const decision = parseQwenDecision(payload.message?.content ?? payload.response ?? "");
    if (!decision || decision.confidence < params.minConfidence) {
      return undefined;
    }
    return decision;
  } finally {
    clearTimeout(timeout);
  }
}

export async function ingestGmailHookPayload(params: {
  cfg: OpenClawConfig;
  payload: Record<string, unknown>;
}): Promise<IngestSummary> {
  const configuredStoreDir = params.cfg.hooks?.gmail?.storeDir?.trim();
  const workspace =
    (configuredStoreDir ? resolveUserPath(configuredStoreDir) : undefined) ??
    resolveAgentWorkspaceDir(params.cfg, "mail") ??
    path.join(resolveStateDir(process.env), "mail-store");
  fs.mkdirSync(workspace, { recursive: true });

  const recordsFile = path.join(workspace, "mail-records.jsonl");
  const eventsFile = path.join(workspace, "mail-events.jsonl");
  const indexFile = path.join(workspace, "mail-index.json");
  const checkpointFile = path.join(workspace, "mail-checkpoint.json");
  const dedupeFile = path.join(workspace, "mail-dedupe-keys.txt");
  const qmdDir = path.join(workspace, "qmd");

  const seen = dedupeCache.get(workspace) ?? new Set<string>();
  if (!dedupeCache.has(workspace) && fs.existsSync(dedupeFile)) {
    for (const line of fs.readFileSync(dedupeFile, "utf8").split(/\r?\n/)) {
      const key = line.trim();
      if (key) {
        seen.add(key);
      }
    }
    dedupeCache.set(workspace, seen);
  }
  if (!dedupeCache.has(workspace)) {
    dedupeCache.set(workspace, seen);
  }

  const checkpoint: Checkpoint = fs.existsSync(checkpointFile)
    ? (JSON.parse(fs.readFileSync(checkpointFile, "utf8")) as Checkpoint)
    : {
        updatedAt: nowIso(),
        processedSourceIds: [],
        processedCount: 0,
        skippedDuplicateCount: 0,
        importantCount: 0,
        notImportantCount: 0,
        failedCount: 0,
      };

  const messages = Array.isArray(params.payload.messages)
    ? (params.payload.messages as unknown[])
    : [];
  let ingested = 0;
  let duplicates = 0;
  let important = 0;
  let notImportant = 0;
  let failed = 0;

  const qwenModel = params.cfg.hooks?.gmail?.model?.startsWith("ollama/")
    ? params.cfg.hooks.gmail.model.slice("ollama/".length)
    : undefined;
  const qwenTimeoutMs = Math.max(10_000, params.cfg.hooks?.gmail?.qwenTimeoutMs ?? 120_000);

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    try {
      const msg = raw as GmailHookMessage;
      const bodyText = `${msg.snippet ?? ""}\n${msg.body ?? ""}`.trim();
      const dedupeKey = messageDedupeKey(msg, bodyText);
      if (seen.has(dedupeKey)) {
        duplicates += 1;
        continue;
      }
      const heuristic = classifyImportance(msg, bodyText);
      const record: MailRecord = {
        id: sha1(dedupeKey),
        dedupeKey,
        sourceId: "gmail-hook",
        sourcePath: "hook:/gmail",
        folderHint: "gmail-hook",
        messageId: msg.messageId ?? msg.id,
        threadId: msg.threadId,
        from: msg.from,
        to: msg.to,
        cc: msg.cc,
        subject: msg.subject,
        date: msg.date,
        hasAttachment: false,
        attachmentCount: 0,
        attachments: [],
        labels: Array.isArray(msg.labels)
          ? msg.labels.filter((v): v is string => typeof v === "string")
          : [],
        bodyText: bodyText.slice(0, heuristic.importance === "important" ? 4000 : 280),
        importance: heuristic.importance,
        importanceReasons: heuristic.reasons,
      };
      if (qwenModel && record.importanceReasons.includes("bucket:maybe")) {
        const decision = await maybeClassifyWithQwen({
          model: qwenModel,
          url: "http://127.0.0.1:11434/api/chat",
          timeoutMs: qwenTimeoutMs,
          minConfidence: 0.55,
          record,
        });
        if (decision) {
          record.importance = decision.importance;
          record.importanceReasons = [
            `qwen:${decision.importance}`,
            `qwen_confidence:${decision.confidence.toFixed(2)}`,
            ...decision.reasons.map((r) => `qwen_reason:${r}`),
            ...record.importanceReasons,
          ].slice(0, 10);
        }
      }
      appendJsonl(recordsFile, record);
      writeQmdDoc(qmdDir, record);
      appendJsonl(eventsFile, {
        ts: nowIso(),
        type: "ingested",
        source: "gmail-hook",
        recordId: record.id,
        dedupeKey: record.dedupeKey,
        messageId: record.messageId,
        importance: record.importance,
        importanceReasons: record.importanceReasons,
      });
      fs.appendFileSync(dedupeFile, `${dedupeKey}\n`, "utf8");
      seen.add(dedupeKey);
      ingested += 1;
      if (record.importance === "important") {
        important += 1;
      } else {
        notImportant += 1;
      }
    } catch {
      failed += 1;
    }
  }

  const nextCheckpoint: Checkpoint = {
    updatedAt: nowIso(),
    processedSourceIds: checkpoint.processedSourceIds,
    processedCount: checkpoint.processedCount + ingested,
    skippedDuplicateCount: checkpoint.skippedDuplicateCount + duplicates,
    importantCount: checkpoint.importantCount + important,
    notImportantCount: checkpoint.notImportantCount + notImportant,
    failedCount: checkpoint.failedCount + failed,
  };
  writeJson(checkpointFile, nextCheckpoint);
  writeJson(indexFile, {
    version: 2,
    updatedAt: nowIso(),
    format: "jsonl",
    recordsFile,
    dedupeFile,
    eventsFile,
    checkpointFile,
    counts: {
      processed: nextCheckpoint.processedCount,
      important: nextCheckpoint.importantCount,
      notImportant: nextCheckpoint.notImportantCount,
      duplicates: nextCheckpoint.skippedDuplicateCount,
      failed: nextCheckpoint.failedCount,
    },
  });

  return {
    outDir: workspace,
    ingested,
    duplicates,
    important,
    notImportant,
    failed,
  };
}
