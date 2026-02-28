import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  analyzeAttachmentFile,
  detectAnalyzerCapabilities,
  type AnalyzerCapabilities,
} from "./attachment-analysis-lib.ts";
import {
  appendJsonl,
  classifyImportance,
  ensureDir,
  expandHome,
  extractMessageAttachments,
  extractPlainBody,
  messageDedupeKey,
  nowIso,
  parseArgs,
  parseHeaders,
  readJsonIfExists,
  resolveCsvPaths,
  safeFileName,
  sha1,
  type MailAttachment,
  type MailRecord,
  type MailSource,
  writeJson,
} from "./shared.ts";

type DiscoverFile = {
  sources: MailSource[];
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

type IndexFile = {
  version: 2;
  updatedAt: string;
  format: "jsonl";
  recordsFile: string;
  dedupeFile: string;
  eventsFile: string;
  checkpointFile: string;
  counts: {
    processed: number;
    important: number;
    notImportant: number;
    duplicates: number;
    failed: number;
  };
};

type QwenConfig = {
  enabled: boolean;
  url: string;
  model: string;
  timeoutMs: number;
  minConfidence: number;
  maxBodyChars: number;
};

type QwenDecision = {
  importance: "important" | "not_important";
  confidence: number;
  reasons: string[];
  spamLikely: boolean;
};

const RISKY_DROP_PATTERN =
  /docusign|booking|reservation|confirm|confirmation|recruiter|interview|job|application|offer|talent|career|realtor|real estate|e-?transfer|interac|tax|legal|lawyer|attorney|receipt|invoice|delivery|shipped/i;
const QWEN_SYSTEM_PROMPT =
  'Classify email importance for personal retrieval. Compare sender+subject against body and flag spoof/phishing mismatches. Return strict JSON only: {"importance":"important|not_important","confidence":0..1,"spamLikely":true|false,"reasons":["short_reason_codes"]}';

function usage(): never {
  console.error(
    [
      "Usage:",
      "  bun scripts/mail/backfill-run.ts --sources <sources.json>",
      "  [--roots <csv>] [--out-dir <dir>] [--events <file>] [--index <file>] [--checkpoint <file>]",
      "  [--records <file>] [--dedupe-keys <file>]",
      "  [--qmd-dir <dir>] [--attachments-dir <dir>] [--attachment-text-dir <dir>] [--max-attachment-bytes <n>] [--max-messages <n>]",
      "  [--body-max-important <n>] [--body-max-not-important <n>]",
      "  [--qwen-model <name>] [--qwen-url <http://127.0.0.1:11434/api/chat>] [--qwen-timeout-ms <n>]",
      "  [--qwen-min-confidence <0..1>] [--qwen-max-body-chars <n>]",
    ].join("\n"),
  );
  process.exit(1);
}

function splitMboxMessages(
  filePath: string,
  onMessage: (raw: string) => Promise<void> | void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let lines: string[] = [];
    let seenFirstSeparator = false;

    const flush = async (): Promise<void> => {
      if (lines.length === 0) {
        return;
      }
      const raw = lines.join("\n");
      lines = [];
      if (raw.trim().length === 0) {
        return;
      }
      await onMessage(raw);
    };

    rl.on("line", (line) => {
      if (line.startsWith("From ")) {
        if (seenFirstSeparator) {
          rl.pause();
          flush()
            .then(() => {
              seenFirstSeparator = true;
              rl.resume();
            })
            .catch((err) => reject(err));
          return;
        }
        seenFirstSeparator = true;
        return;
      }
      lines.push(line);
    });

    rl.on("close", () => {
      flush().then(resolve).catch(reject);
    });
    rl.on("error", reject);
    stream.on("error", reject);
  });
}

async function processMaildir(
  sourcePath: string,
  onMessage: (raw: string, filePath: string) => Promise<void>,
): Promise<void> {
  for (const sub of ["cur", "new"]) {
    const dir = path.join(sourcePath, sub);
    if (!fs.existsSync(dir)) {
      continue;
    }
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const full = path.join(dir, file);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) {
        continue;
      }
      const raw = fs.readFileSync(full, "utf8");
      await onMessage(raw, full);
    }
  }
}

function writeQmdDoc(qmdDir: string, record: MailRecord): void {
  if (record.importance !== "important") {
    return;
  }
  const folder = path.join(qmdDir, "emails", record.importance);
  ensureDir(folder);

  const fileName = `${safeFileName(record.id)}.md`;
  const outPath = path.join(folder, fileName);
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

function buildRecordBase(
  rawMessage: string,
  source: MailSource,
  rawPath: string,
  bodyMaxImportant: number,
  bodyMaxNotImportant: number,
): Omit<MailRecord, "attachments"> {
  const headers = parseHeaders(rawMessage);
  const bodyText = extractPlainBody(rawMessage);
  const extractedAttachments = extractMessageAttachments(rawMessage);
  const importance = classifyImportance({
    subject: headers["subject"],
    from: headers["from"],
    bodyText,
    hasAttachment: extractedAttachments.length > 0,
    headers,
  });

  const dedupeKey = messageDedupeKey(headers, bodyText);
  const labels = (headers["x-gmail-labels"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const folderHint = path.basename(path.dirname(rawPath));
  const bodyForStore =
    importance.importance === "important"
      ? bodyText.slice(0, bodyMaxImportant)
      : bodyText.slice(0, bodyMaxNotImportant);

  return {
    id: sha1(dedupeKey),
    dedupeKey,
    sourceId: source.id,
    sourcePath: rawPath,
    folderHint,
    messageId: headers["message-id"],
    threadId: headers["thread-id"] ?? headers.references,
    from: headers.from,
    to: headers.to,
    cc: headers.cc,
    subject: headers.subject,
    date: headers.date,
    hasAttachment: extractedAttachments.length > 0,
    attachmentCount: extractedAttachments.length,
    labels,
    bodyText: bodyForStore,
    importance: importance.importance,
    importanceReasons: importance.reasons,
  };
}

function materializeAndAnalyzeAttachments(params: {
  rawMessage: string;
  recordId: string;
  attachmentsRoot: string;
  attachmentTextDir: string;
  maxAttachmentBytes: number;
  caps: AnalyzerCapabilities;
  eventsFile: string;
  skippedReviewFile: string;
  errorReviewFile: string;
}): MailAttachment[] {
  const {
    rawMessage,
    recordId,
    attachmentsRoot,
    attachmentTextDir,
    maxAttachmentBytes,
    caps,
    eventsFile,
    skippedReviewFile,
    errorReviewFile,
  } = params;
  const extracted = extractMessageAttachments(rawMessage);
  if (extracted.length === 0) {
    return [];
  }

  const messageDir = path.join(attachmentsRoot, safeFileName(recordId));
  ensureDir(messageDir);

  const out: MailAttachment[] = [];

  for (let i = 0; i < extracted.length; i += 1) {
    const att = extracted[i];
    const extGuess = guessExtFromMime(att.mime);
    const baseName = att.filename ? safeFileName(att.filename) : `attachment-${i + 1}${extGuess}`;
    const fileName = baseName.includes(".") ? baseName : `${baseName}${extGuess}`;
    const filePath = path.join(messageDir, fileName);

    fs.writeFileSync(filePath, att.data);

    let analysis: ReturnType<typeof analyzeAttachmentFile> | undefined;
    try {
      analysis = analyzeAttachmentFile({
        filePath,
        inDir: attachmentsRoot,
        textDir: attachmentTextDir,
        maxBytes: maxAttachmentBytes,
        caps,
      });

      appendJsonl(eventsFile, {
        ts: nowIso(),
        type: "attachment_analyzed",
        recordId,
        filePath,
        status: analysis.status,
        parser: analysis.parser,
        textPath: analysis.textPath,
        error: analysis.error,
      });
      if (analysis.status === "skipped") {
        appendJsonl(skippedReviewFile, {
          ts: nowIso(),
          recordId,
          filePath,
          parser: analysis.parser,
          reason: analysis.error ?? "skipped",
          sourcePath: analysis.sourcePath,
        });
      } else if (analysis.status === "error") {
        appendJsonl(errorReviewFile, {
          ts: nowIso(),
          recordId,
          filePath,
          parser: analysis.parser,
          error: analysis.error ?? "error",
          sourcePath: analysis.sourcePath,
        });
      }
    } catch (err) {
      appendJsonl(eventsFile, {
        ts: nowIso(),
        type: "attachment_analyze_error",
        recordId,
        filePath,
        error: String(err),
      });
      appendJsonl(errorReviewFile, {
        ts: nowIso(),
        recordId,
        filePath,
        parser: "none",
        error: String(err),
      });
      analysis = {
        id: sha1(filePath),
        sourcePath: filePath,
        relativePath: path.relative(attachmentsRoot, filePath),
        sizeBytes: att.data.byteLength,
        ext: path.extname(filePath),
        parser: "none",
        status: "error",
        error: String(err),
      };
    }

    out.push({
      fileName,
      mime: att.mime,
      filePath,
      textPath: analysis.textPath,
      analysisStatus: analysis.status,
      analysisError: analysis.error,
    });
  }

  return out;
}

function guessExtFromMime(mime?: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("pdf")) {
    return ".pdf";
  }
  if (m.includes("jpeg") || m.includes("jpg")) {
    return ".jpg";
  }
  if (m.includes("png")) {
    return ".png";
  }
  if (m.includes("gif")) {
    return ".gif";
  }
  if (m.includes("heic")) {
    return ".heic";
  }
  if (m.includes("wordprocessingml") || m.includes("msword")) {
    return ".docx";
  }
  if (m.includes("spreadsheetml") || m.includes("excel")) {
    return ".xlsx";
  }
  if (m.includes("presentationml") || m.includes("powerpoint")) {
    return ".pptx";
  }
  if (m.includes("json")) {
    return ".json";
  }
  if (m.includes("xml")) {
    return ".xml";
  }
  if (m.includes("csv")) {
    return ".csv";
  }
  return ".bin";
}

function trimForPrompt(input: string | undefined, maxChars: number): string {
  const text = (input ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

function qwenPromptForRecord(
  record: Omit<MailRecord, "attachments">,
  maxBodyChars: number,
): string {
  return [
    "Classify this email.",
    `From: ${record.from ?? ""}`,
    `To: ${record.to ?? ""}`,
    `Subject: ${record.subject ?? ""}`,
    `HasAttachment: ${record.hasAttachment ? "true" : "false"}`,
    `Body: ${trimForPrompt(record.bodyText, maxBodyChars)}`,
    "",
    'Important: If subject/sender does not match body intent (for example fake login alerts), set spamLikely=true and include reasons like "subject_body_mismatch", "sender_content_mismatch", or "phishing_signal".',
    'Respond with JSON: {"importance":"important|not_important","confidence":0..1,"spamLikely":true|false,"reasons":["..."]}',
  ].join("\n");
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
  const obj = parsed as {
    importance?: unknown;
    confidence?: unknown;
    reasons?: unknown;
    spamLikely?: unknown;
  };
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
  const spamLikely = obj.spamLikely === true;
  return {
    importance: obj.importance,
    confidence,
    reasons,
    spamLikely,
  };
}

async function classifyWithQwen(
  record: Omit<MailRecord, "attachments">,
  cfg: QwenConfig,
): Promise<QwenDecision> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        format: "json",
        options: {
          temperature: 0,
        },
        messages: [
          { role: "system", content: QWEN_SYSTEM_PROMPT },
          { role: "user", content: qwenPromptForRecord(record, cfg.maxBodyChars) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`qwen_http_${response.status}`);
    }
    const payload = (await response.json()) as {
      message?: { content?: string };
      response?: string;
    };
    const rawContent = payload.message?.content ?? payload.response ?? "";
    const decision = parseQwenDecision(rawContent);
    if (!decision) {
      throw new Error("qwen_invalid_json");
    }
    return decision;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    usage();
  }

  const outDir = path.resolve(
    expandHome(typeof args["out-dir"] === "string" ? args["out-dir"] : "./tmp/mail-backfill"),
  );
  ensureDir(outDir);

  const eventsFile = path.resolve(
    expandHome(
      typeof args.events === "string" ? args.events : path.join(outDir, "mail-events.jsonl"),
    ),
  );
  const indexFile = path.resolve(
    expandHome(typeof args.index === "string" ? args.index : path.join(outDir, "mail-index.json")),
  );
  const recordsFile = path.resolve(
    expandHome(
      typeof args.records === "string" ? args.records : path.join(outDir, "mail-records.jsonl"),
    ),
  );
  const dedupeFile = path.resolve(
    expandHome(
      typeof args["dedupe-keys"] === "string"
        ? args["dedupe-keys"]
        : path.join(outDir, "mail-dedupe-keys.txt"),
    ),
  );
  const checkpointFile = path.resolve(
    expandHome(
      typeof args.checkpoint === "string"
        ? args.checkpoint
        : path.join(outDir, "mail-checkpoint.json"),
    ),
  );
  const qmdDir = path.resolve(
    expandHome(typeof args["qmd-dir"] === "string" ? args["qmd-dir"] : path.join(outDir, "qmd")),
  );
  const attachmentsRoot = path.resolve(
    expandHome(
      typeof args["attachments-dir"] === "string"
        ? args["attachments-dir"]
        : path.join(outDir, "attachments", "raw"),
    ),
  );
  const attachmentTextDir = path.resolve(
    expandHome(
      typeof args["attachment-text-dir"] === "string"
        ? args["attachment-text-dir"]
        : path.join(outDir, "attachments", "text"),
    ),
  );
  const reviewDir = path.join(outDir, "review");
  const skippedReviewFile = path.join(reviewDir, "attachment-skipped.jsonl");
  const errorReviewFile = path.join(reviewDir, "attachment-errors.jsonl");
  const riskyDropReviewFile = path.join(reviewDir, "risky-dropped.jsonl");
  const qwenDecisionReviewFile = path.join(reviewDir, "qwen-decisions.jsonl");
  const qwenErrorReviewFile = path.join(reviewDir, "qwen-errors.jsonl");

  ensureDir(path.dirname(eventsFile));
  ensureDir(path.dirname(indexFile));
  ensureDir(path.dirname(recordsFile));
  ensureDir(path.dirname(dedupeFile));
  ensureDir(path.dirname(checkpointFile));
  ensureDir(qmdDir);
  ensureDir(attachmentsRoot);
  ensureDir(attachmentTextDir);
  ensureDir(reviewDir);
  fs.closeSync(fs.openSync(skippedReviewFile, "a"));
  fs.closeSync(fs.openSync(errorReviewFile, "a"));
  fs.closeSync(fs.openSync(riskyDropReviewFile, "a"));
  fs.closeSync(fs.openSync(qwenDecisionReviewFile, "a"));
  fs.closeSync(fs.openSync(qwenErrorReviewFile, "a"));
  fs.closeSync(fs.openSync(recordsFile, "a"));
  fs.closeSync(fs.openSync(dedupeFile, "a"));

  const maxMessages =
    typeof args["max-messages"] === "string"
      ? Number(args["max-messages"])
      : Number.POSITIVE_INFINITY;
  if (
    maxMessages !== Number.POSITIVE_INFINITY &&
    (!Number.isFinite(maxMessages) || maxMessages < 1)
  ) {
    throw new Error("--max-messages must be a positive number");
  }

  const maxAttachmentBytes =
    typeof args["max-attachment-bytes"] === "string"
      ? Number(args["max-attachment-bytes"])
      : 25 * 1024 * 1024;
  if (!Number.isFinite(maxAttachmentBytes) || maxAttachmentBytes < 1) {
    throw new Error("--max-attachment-bytes must be a positive number");
  }
  const bodyMaxImportant =
    typeof args["body-max-important"] === "string" ? Number(args["body-max-important"]) : 4000;
  const bodyMaxNotImportant =
    typeof args["body-max-not-important"] === "string"
      ? Number(args["body-max-not-important"])
      : 280;
  if (!Number.isFinite(bodyMaxImportant) || bodyMaxImportant < 100) {
    throw new Error("--body-max-important must be >= 100");
  }
  if (!Number.isFinite(bodyMaxNotImportant) || bodyMaxNotImportant < 0) {
    throw new Error("--body-max-not-important must be >= 0");
  }
  const qwenModel = typeof args["qwen-model"] === "string" ? args["qwen-model"].trim() : "";
  const qwenUrl =
    typeof args["qwen-url"] === "string" ? args["qwen-url"] : "http://127.0.0.1:11434/api/chat";
  const qwenTimeoutMs =
    typeof args["qwen-timeout-ms"] === "string" ? Number(args["qwen-timeout-ms"]) : 45000;
  const qwenMinConfidence =
    typeof args["qwen-min-confidence"] === "string" ? Number(args["qwen-min-confidence"]) : 0.55;
  const qwenMaxBodyChars =
    typeof args["qwen-max-body-chars"] === "string" ? Number(args["qwen-max-body-chars"]) : 500;
  if (qwenModel.length > 0 && (!Number.isFinite(qwenTimeoutMs) || qwenTimeoutMs < 500)) {
    throw new Error("--qwen-timeout-ms must be >= 500");
  }
  if (
    qwenModel.length > 0 &&
    (!Number.isFinite(qwenMinConfidence) || qwenMinConfidence < 0 || qwenMinConfidence > 1)
  ) {
    throw new Error("--qwen-min-confidence must be between 0 and 1");
  }
  if (qwenModel.length > 0 && (!Number.isFinite(qwenMaxBodyChars) || qwenMaxBodyChars < 100)) {
    throw new Error("--qwen-max-body-chars must be >= 100");
  }
  const qwenCfg: QwenConfig = {
    enabled: qwenModel.length > 0,
    url: qwenUrl,
    model: qwenModel,
    timeoutMs: qwenTimeoutMs,
    minConfidence: qwenMinConfidence,
    maxBodyChars: qwenMaxBodyChars,
  };

  let sources: MailSource[] = [];
  if (typeof args.sources === "string") {
    const discover = readJsonIfExists<DiscoverFile>(path.resolve(expandHome(args.sources)));
    if (!discover?.sources || discover.sources.length === 0) {
      throw new Error(`No sources found in ${args.sources}`);
    }
    sources = discover.sources;
  } else if (typeof args.roots === "string") {
    const roots = resolveCsvPaths(args.roots);
    for (const root of roots) {
      if (!fs.existsSync(root)) {
        continue;
      }
      const entries = fs.readdirSync(root);
      for (const entry of entries) {
        const full = path.join(root, entry);
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (
          st.isDirectory() &&
          (fs.existsSync(path.join(full, "cur")) || fs.existsSync(path.join(full, "new")))
        ) {
          sources.push({
            id: sha1(`maildir:${full}`),
            kind: "maildir",
            path: full,
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
          });
          continue;
        }
        if (st.isFile() && entry.toLowerCase().endsWith(".eml")) {
          sources.push({
            id: sha1(`eml:${full}`),
            kind: "eml",
            path: full,
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
          });
        }
      }
    }
  } else {
    usage();
  }

  const checkpoint = readJsonIfExists<Checkpoint>(checkpointFile) ?? {
    updatedAt: nowIso(),
    processedSourceIds: [],
    processedCount: 0,
    skippedDuplicateCount: 0,
    importantCount: 0,
    notImportantCount: 0,
    failedCount: 0,
  };

  const seen = new Set<string>();
  if (fs.existsSync(dedupeFile)) {
    const dedupeRaw = fs.readFileSync(dedupeFile, "utf8");
    for (const line of dedupeRaw.split(/\r?\n/)) {
      const key = line.trim();
      if (key.length > 0) {
        seen.add(key);
      }
    }
  }
  const processedSourceIds = new Set<string>(checkpoint.processedSourceIds);

  let processedCount = checkpoint.processedCount;
  let skippedDuplicateCount = checkpoint.skippedDuplicateCount;
  let importantCount = checkpoint.importantCount;
  let notImportantCount = checkpoint.notImportantCount;
  let failedCount = checkpoint.failedCount;

  const caps = detectAnalyzerCapabilities();

  for (const source of sources) {
    if (processedSourceIds.has(source.id)) {
      continue;
    }

    const handleMessage = async (rawMessage: string, rawPath: string): Promise<void> => {
      if (processedCount >= maxMessages) {
        return;
      }
      try {
        const base = buildRecordBase(
          rawMessage,
          source,
          rawPath,
          bodyMaxImportant,
          bodyMaxNotImportant,
        );

        if (seen.has(base.dedupeKey)) {
          skippedDuplicateCount += 1;
          return;
        }

        if (
          qwenCfg.enabled &&
          base.importance === "important" &&
          base.importanceReasons.includes("bucket:maybe")
        ) {
          try {
            const decision = await classifyWithQwen(base, qwenCfg);
            appendJsonl(qwenDecisionReviewFile, {
              ts: nowIso(),
              recordId: base.id,
              sourceId: source.id,
              sourcePath: rawPath,
              heuristicImportance: base.importance,
              heuristicReasons: base.importanceReasons,
              qwenDecision: decision,
            });
            if (decision.confidence >= qwenCfg.minConfidence) {
              const reasonSignals = decision.reasons.map((reason) => reason.toLowerCase());
              const spamReasonSignal = reasonSignals.some(
                (reason) =>
                  reason.includes("subject_body_mismatch") ||
                  reason.includes("sender_content_mismatch") ||
                  reason.includes("phishing"),
              );
              const spamLikely = decision.spamLikely || spamReasonSignal;
              base.importance = spamLikely ? "not_important" : decision.importance;
              base.importanceReasons = [
                `qwen:${base.importance}`,
                `qwen_confidence:${decision.confidence.toFixed(2)}`,
                ...(spamLikely ? ["qwen:spam_likely"] : []),
                ...decision.reasons.map((r) => `qwen_reason:${r}`),
                ...base.importanceReasons,
              ].slice(0, 10);
              base.bodyText =
                base.importance === "important"
                  ? base.bodyText.slice(0, bodyMaxImportant)
                  : base.bodyText.slice(0, bodyMaxNotImportant);
              if (spamLikely) {
                appendJsonl(eventsFile, {
                  ts: nowIso(),
                  type: "qwen_spam_flagged",
                  recordId: base.id,
                  sourceId: source.id,
                  sourcePath: rawPath,
                  importance: base.importance,
                  importanceReasons: base.importanceReasons,
                });
              }
            }
          } catch (err) {
            appendJsonl(qwenErrorReviewFile, {
              ts: nowIso(),
              recordId: base.id,
              sourceId: source.id,
              sourcePath: rawPath,
              error: String(err),
            });
          }
        }

        const attachments = materializeAndAnalyzeAttachments({
          rawMessage,
          recordId: base.id,
          attachmentsRoot,
          attachmentTextDir,
          maxAttachmentBytes,
          caps,
          eventsFile,
          skippedReviewFile,
          errorReviewFile,
        });

        const record: MailRecord = {
          ...base,
          attachments,
        };

        seen.add(record.dedupeKey);
        appendJsonl(recordsFile, record);
        fs.appendFileSync(dedupeFile, `${record.dedupeKey}\n`, "utf8");
        processedCount += 1;

        if (record.importance === "important") {
          importantCount += 1;
        } else {
          notImportantCount += 1;
          if (
            RISKY_DROP_PATTERN.test(
              `${record.subject ?? ""} ${record.from ?? ""} ${record.bodyText}`,
            )
          ) {
            appendJsonl(riskyDropReviewFile, {
              ts: nowIso(),
              recordId: record.id,
              sourceId: source.id,
              sourcePath: rawPath,
              from: record.from,
              subject: record.subject,
              importanceReasons: record.importanceReasons,
            });
          }
        }

        appendJsonl(eventsFile, {
          ts: nowIso(),
          type: "ingested",
          recordId: record.id,
          dedupeKey: record.dedupeKey,
          sourceId: source.id,
          sourcePath: rawPath,
          importance: record.importance,
          importanceReasons: record.importanceReasons,
          attachmentCount: record.attachmentCount,
        });
        if (
          qwenCfg.enabled &&
          record.importanceReasons.some((reason) => reason.startsWith("qwen:"))
        ) {
          appendJsonl(eventsFile, {
            ts: nowIso(),
            type: "qwen_classified",
            recordId: record.id,
            sourceId: source.id,
            sourcePath: rawPath,
            importance: record.importance,
            importanceReasons: record.importanceReasons,
          });
        }

        writeQmdDoc(qmdDir, record);
      } catch (err) {
        failedCount += 1;
        appendJsonl(eventsFile, {
          ts: nowIso(),
          type: "error",
          sourceId: source.id,
          sourcePath: rawPath,
          error: String(err),
        });
        appendJsonl(errorReviewFile, {
          ts: nowIso(),
          sourceId: source.id,
          sourcePath: rawPath,
          parser: "ingest",
          error: String(err),
        });
      }
    };

    if (source.kind === "mbox") {
      await splitMboxMessages(source.path, async (raw) => handleMessage(raw, source.path));
    } else if (source.kind === "maildir") {
      await processMaildir(source.path, handleMessage);
    } else {
      const raw = fs.readFileSync(source.path, "utf8");
      await handleMessage(raw, source.path);
    }

    processedSourceIds.add(source.id);

    const nextCheckpoint: Checkpoint = {
      updatedAt: nowIso(),
      processedSourceIds: [...processedSourceIds],
      processedCount,
      skippedDuplicateCount,
      importantCount,
      notImportantCount,
      failedCount,
    };
    writeJson(checkpointFile, nextCheckpoint);

    if (processedCount >= maxMessages) {
      break;
    }
  }

  const nextIndex: IndexFile = {
    version: 2,
    updatedAt: nowIso(),
    format: "jsonl",
    recordsFile,
    dedupeFile,
    eventsFile,
    checkpointFile,
    counts: {
      processed: processedCount,
      important: importantCount,
      notImportant: notImportantCount,
      duplicates: skippedDuplicateCount,
      failed: failedCount,
    },
  };
  writeJson(indexFile, nextIndex);

  writeJson(path.join(outDir, "attachment-analysis-summary.json"), {
    generatedAt: nowIso(),
    tools: caps,
    maxAttachmentBytes,
    attachmentsRoot,
    attachmentTextDir,
  });

  console.log(
    [
      `processed=${processedCount}`,
      `important=${importantCount}`,
      `not_important=${notImportantCount}`,
      `duplicates=${skippedDuplicateCount}`,
      `failed=${failedCount}`,
      `index=${indexFile}`,
      `events=${eventsFile}`,
      `qmd=${qmdDir}`,
      `attachments=${attachmentsRoot}`,
      `review=${reviewDir}`,
    ].join(" "),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
