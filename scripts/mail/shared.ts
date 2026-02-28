import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SourceKind = "mbox" | "maildir" | "eml";

export type MailSource = {
  id: string;
  kind: SourceKind;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
};

export type MailAttachment = {
  fileName: string;
  mime?: string;
  filePath?: string;
  textPath?: string;
  analysisStatus?: "ok" | "skipped" | "error";
  analysisError?: string;
};

export type MailRecord = {
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

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

export function expandHome(input: string): string {
  if (!input.startsWith("~")) {
    return input;
  }
  return path.join(os.homedir(), input.slice(1));
}

export function resolveCsvPaths(input: string): string[] {
  return input
    .split(",")
    .map((entry) => expandHome(entry.trim()))
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readJsonIfExists<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function appendJsonl(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function sha1(input: string | Buffer): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

export function cleanHeaderValue(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  const trimmed = input.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

export function parseHeaders(rawMessage: string): Record<string, string> {
  const [rawHeaders] = splitHeadersAndBody(rawMessage);
  const lines = rawHeaders.split(/\r?\n/);
  const headers: Record<string, string> = {};
  let currentKey = "";

  for (const line of lines) {
    if (/^[\t ]/.test(line) && currentKey) {
      headers[currentKey] = `${headers[currentKey]} ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    currentKey = line.slice(0, idx).trim().toLowerCase();
    headers[currentKey] = line.slice(idx + 1).trim();
  }

  return headers;
}

export function splitHeadersAndBody(rawMessage: string): [string, string] {
  const marker = rawMessage.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const idx = rawMessage.indexOf(marker);
  if (idx < 0) {
    return [rawMessage, ""];
  }
  return [rawMessage.slice(0, idx), rawMessage.slice(idx + marker.length)];
}

export function extractPlainBody(rawMessage: string): string {
  const [rawHeaders, rawBody] = splitHeadersAndBody(rawMessage);
  const headers = parseHeaders(rawHeaders);
  const contentType = (headers["content-type"] ?? "").toLowerCase();

  if (!contentType.includes("multipart/")) {
    return normalizeBodyText(rawBody);
  }

  const boundaryMatch = headers["content-type"]?.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) {
    return normalizeBodyText(rawBody);
  }

  const token = `--${boundary}`;
  const parts = rawBody.split(token);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === "--") {
      continue;
    }
    const [partHeaders, partBody] = splitHeadersAndBody(trimmed);
    const headerMap = parseHeaders(partHeaders);
    const ct = (headerMap["content-type"] ?? "text/plain").toLowerCase();
    const disposition = (headerMap["content-disposition"] ?? "").toLowerCase();
    if (disposition.includes("attachment")) {
      continue;
    }
    if (ct.includes("text/plain")) {
      return normalizeBodyText(partBody);
    }
  }

  return normalizeBodyText(rawBody);
}

function normalizeBodyText(input: string): string {
  return input
    .replace(/\r/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

export type ExtractedAttachment = {
  filename?: string;
  mime?: string;
  data: Buffer;
  transferEncoding?: string;
};

export function extractMessageAttachments(rawMessage: string): ExtractedAttachment[] {
  const [rawHeaders, rawBody] = splitHeadersAndBody(rawMessage);
  const headers = parseHeaders(rawHeaders);
  return extractParts(headers, rawBody);
}

function extractParts(headers: Record<string, string>, body: string): ExtractedAttachment[] {
  const contentType = (headers["content-type"] ?? "text/plain").toLowerCase();
  if (!contentType.includes("multipart/")) {
    const maybe = decodeAttachmentLeaf(headers, body);
    return maybe ? [maybe] : [];
  }

  const boundaryMatch = headers["content-type"]?.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) {
    return [];
  }

  const token = `--${boundary}`;
  const parts = body.split(token);
  const out: ExtractedAttachment[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === "--") {
      continue;
    }
    const [partHeadersRaw, partBody] = splitHeadersAndBody(trimmed);
    const partHeaders = parseHeaders(partHeadersRaw);
    const nested = extractParts(partHeaders, partBody);
    out.push(...nested);
  }

  return out;
}

function decodeAttachmentLeaf(
  headers: Record<string, string>,
  body: string,
): ExtractedAttachment | undefined {
  const disposition = (headers["content-disposition"] ?? "").toLowerCase();
  const contentType = headers["content-type"] ?? "application/octet-stream";
  const encoding = (headers["content-transfer-encoding"] ?? "").toLowerCase();

  const nameFromDisposition =
    headers["content-disposition"]?.match(/filename\*?=(?:"([^"]+)"|([^;\s]+))/i)?.[1] ??
    headers["content-disposition"]?.match(/filename\*?=(?:"([^"]+)"|([^;\s]+))/i)?.[2];
  const nameFromType =
    headers["content-type"]?.match(/name=(?:"([^"]+)"|([^;\s]+))/i)?.[1] ??
    headers["content-type"]?.match(/name=(?:"([^"]+)"|([^;\s]+))/i)?.[2];
  const filename = cleanHeaderValue(nameFromDisposition ?? nameFromType);

  const isAttachmentLike = disposition.includes("attachment") || Boolean(filename);
  if (!isAttachmentLike) {
    return undefined;
  }

  let data: Buffer;
  if (encoding.includes("base64")) {
    const normalized = body.replace(/\s+/g, "");
    data = Buffer.from(normalized, "base64");
  } else if (encoding.includes("quoted-printable")) {
    const normalized = body.replace(/=\r?\n/g, "");
    const decoded = normalized.replace(/=([A-Fa-f0-9]{2})/g, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    data = Buffer.from(decoded, "utf8");
  } else {
    data = Buffer.from(body, "utf8");
  }

  return {
    filename,
    mime: cleanHeaderValue(contentType.split(";")[0]),
    data,
    transferEncoding: cleanHeaderValue(encoding),
  };
}

const IMPORTANT_SUBJECT = [
  /invoice/i,
  /receipt/i,
  /payment/i,
  /statement/i,
  /tax/i,
  /booking/i,
  /booking confirmation/i,
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

const PROMO_SUBJECT = [
  /newsletter/i,
  /digest/i,
  /coupon/i,
  /sale/i,
  /deal/i,
  /promo/i,
  /flyer/i,
  /special offer/i,
  /unsubscribe/i,
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

const PROMO_FROM = [/noreply/i, /mailer-daemon/i, /news/i, /offers?/i, /marketing/i];
const BULK_SENDER_DOMAIN = [
  /mailchimp/i,
  /constantcontact/i,
  /surveymailcenter/i,
  /e\.hollisterco\.com/i,
  /abercrombie\.com/i,
  /urbanoutfitters\.com/i,
  /facebookmail\.com/i,
  /communication\.microsoft\.com/i,
  /calendarnotification@outlook\.com/i,
  /e\.starbucks\.com/i,
  /twitter\.com/i,
  /e\.microsoft\.com/i,
  /newsletter/i,
];
const BODY_PROMO_MARKERS = [
  /unsubscribe/i,
  /view this email online/i,
  /this email is sent from an account we use for sending messages only/i,
  /do not reply/i,
  /don't reply/i,
  /all rights reserved/i,
  /manage (?:email )?preferences/i,
];
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
const FORWARDED_BLOCK_MARKERS = [
  /forwarded message/i,
  /original message/i,
  /from:\s+.+\n\s*sent:\s+.+\n\s*to:\s+.+\n\s*subject:/i,
];
const FORWARD_SUBJECT_PREFIX = /^\s*fwd?\s*:/i;
const REPLY_SUBJECT_PREFIX = /^\s*re\s*:/i;
const REPLY_BODY_MARKERS = [/\bon .+wrote:/i, /^\s*>.+/m, /\breply above this line\b/i];
const PHISHING_URGENCY_MARKERS = [
  /\burgent(?: action)? required\b/i,
  /\bverify (?:your )?account\b/i,
  /\baccount (?:is )?(?:suspended|locked|disabled)\b/i,
  /\bunusual (?:sign-?in|login|activity)\b/i,
  /\bconfirm (?:your )?identity\b/i,
  /\baction required\b/i,
  /\bsecurity alert\b/i,
];
const PHISHING_CREDENTIAL_MARKERS = [
  /\bpassword\b/i,
  /\bpasscode\b/i,
  /\blog(?:in|on)\b/i,
  /\bssn\b/i,
  /\bsocial security\b/i,
  /\bpin\b/i,
  /\b2fa\b/i,
  /\bone[- ]time code\b/i,
];
const PHISHING_BRAND_RULES = [
  { keyword: /\bchase\b/i, senderDomain: /(^|\.)chase\.com$/i },
  { keyword: /\bpaypal\b/i, senderDomain: /(^|\.)paypal\.com$/i },
  { keyword: /\bapple\b/i, senderDomain: /(^|\.)apple\.com$/i },
  {
    keyword: /\bmicrosoft|outlook|office 365|office365\b/i,
    senderDomain: /(^|\.)microsoft\.com$/i,
  },
  { keyword: /\bgoogle|gmail\b/i, senderDomain: /(^|\.)google\.com$/i },
  { keyword: /\bamazon\b/i, senderDomain: /(^|\.)amazon\.(com|ca)$/i },
  { keyword: /\bbank of america|bofa\b/i, senderDomain: /(^|\.)bankofamerica\.com$/i },
  { keyword: /\bwells fargo\b/i, senderDomain: /(^|\.)wellsfargo\.com$/i },
];
const PERSONAL_FORWARDER_DOMAINS = [
  /(^|\.)hotmail\.com$/i,
  /(^|\.)outlook\.com$/i,
  /(^|\.)gmail\.com$/i,
  /(^|\.)live\.com$/i,
  /(^|\.)icloud\.com$/i,
  /(^|\.)me\.com$/i,
  /(^|\.)msn\.com$/i,
  /(^|\.)yahoo\.com$/i,
  /(^|\.)aol\.com$/i,
];

function extractEmails(raw: string): string[] {
  const matches = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  return matches.map((email) => email.toLowerCase());
}

function isHumanishEmail(email: string): boolean {
  return !/(^|[._-])(no-?reply|donotreply|mailer-daemon)([._-]|@|$)/i.test(email);
}

function senderDomainFromHeader(rawFrom: string): string | undefined {
  const email = extractEmails(rawFrom)[0];
  if (!email) {
    return undefined;
  }
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) {
    return undefined;
  }
  return email.slice(at + 1).toLowerCase();
}

function getPhishingSuspicion(params: {
  subject: string;
  bodyText: string;
  from: string;
  forwarded: boolean;
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const senderDomain = senderDomainFromHeader(params.from);
  const text = `${params.subject}\n${params.bodyText}`;
  const fromPersonalForwarder = Boolean(
    senderDomain && PERSONAL_FORWARDER_DOMAINS.some((rx) => rx.test(senderDomain)),
  );

  if (PHISHING_URGENCY_MARKERS.some((rx) => rx.test(text))) {
    score += 1;
    reasons.push("phishing_urgency");
  }
  if (
    PHISHING_CREDENTIAL_MARKERS.some((rx) => rx.test(text)) &&
    /\b(click|open|visit|verify|confirm|update|reset)\b/i.test(text)
  ) {
    score += 1;
    reasons.push("credential_request_pattern");
  }
  if (/\b(bit\.ly|tinyurl|t\.co|lnkd\.in)\b/i.test(text)) {
    score += 1;
    reasons.push("short_link_pattern");
  }
  if (!params.forwarded && senderDomain && !fromPersonalForwarder) {
    for (const rule of PHISHING_BRAND_RULES) {
      const subjectMentionsBrand = rule.keyword.test(params.subject);
      const bodyMentionsBrand = subjectMentionsBrand || rule.keyword.test(params.bodyText);
      if (!bodyMentionsBrand) {
        continue;
      }
      if (!rule.senderDomain.test(senderDomain)) {
        score += 2;
        reasons.push(subjectMentionsBrand ? "subject_sender_mismatch" : "sender_content_mismatch");
      }
      break;
    }
  }

  return { score, reasons: [...new Set(reasons)] };
}

export function classifyImportance(params: {
  subject?: string;
  from?: string;
  bodyText: string;
  hasAttachment: boolean;
  headers: Record<string, string>;
}): { importance: "important" | "not_important"; reasons: string[] } {
  const strongReasons: string[] = [];
  const weakReasons: string[] = [];
  const subject = decodeRfc2047Words(params.subject ?? "");
  const from = params.from ?? "";
  const bodyText = params.bodyText;
  const hasLegalClaimSignal =
    LEGAL_CLAIM_SIGNALS.some((rx) => rx.test(subject)) ||
    LEGAL_CLAIM_SIGNALS.some((rx) => rx.test(bodyText));
  const hasForwardedBlock = FORWARDED_BLOCK_MARKERS.some((rx) => rx.test(bodyText));
  const isForwarded = FORWARD_SUBJECT_PREFIX.test(subject) || hasForwardedBlock;
  const phishing = getPhishingSuspicion({ subject, bodyText, from, forwarded: isForwarded });

  if (phishing.score >= 3) {
    return {
      importance: "not_important",
      reasons: [
        "bucket:for_sure_not_important",
        "phishing_signal",
        `phishing_score:${phishing.score}`,
        ...phishing.reasons,
      ],
    };
  }

  if (params.hasAttachment) {
    strongReasons.push("has_attachment");
  }

  for (const rx of IMPORTANT_SUBJECT) {
    if (rx.test(subject)) {
      strongReasons.push(`subject:${rx.source}`);
      break;
    }
  }

  if (!isForwarded) {
    for (const rx of IMPORTANT_FROM) {
      if (rx.test(from)) {
        strongReasons.push(`from:${rx.source}`);
        break;
      }
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

  const references = params.headers["references"] ?? "";
  const inReplyTo = params.headers["in-reply-to"] ?? "";
  const hasThreading = references.length > 0 || inReplyTo.length > 0;
  const senderLooksBulk =
    !isForwarded &&
    (PROMO_FROM.some((rx) => rx.test(from)) || BULK_SENDER_DOMAIN.some((rx) => rx.test(from)));
  const hasReplySignals =
    REPLY_SUBJECT_PREFIX.test(subject) || REPLY_BODY_MARKERS.some((rx) => rx.test(bodyText));
  const participantEmails = new Set<string>([
    ...extractEmails(from),
    ...extractEmails(params.headers["to"] ?? ""),
    ...extractEmails(params.headers["cc"] ?? ""),
  ]);
  const humanParticipants = [...participantEmails].filter((email) => isHumanishEmail(email));
  const hasMultiPartyConversation = new Set(humanParticipants).size >= 2;
  if (
    hasThreading &&
    !senderLooksBulk &&
    hasReplySignals &&
    hasMultiPartyConversation &&
    !hasForwardedBlock
  ) {
    strongReasons.push("threaded_human_chain");
  }

  const hasListUnsubscribe = Boolean(params.headers["list-unsubscribe"]);
  let promoSignals = 0;

  for (const rx of PROMO_SUBJECT) {
    if (rx.test(subject)) {
      promoSignals += 1;
      break;
    }
  }
  if (!isForwarded) {
    for (const rx of PROMO_FROM) {
      if (rx.test(from)) {
        promoSignals += 1;
        break;
      }
    }
  }
  if (hasListUnsubscribe) {
    promoSignals += 1;
  }
  if (senderLooksBulk) {
    promoSignals += 1;
  }
  for (const rx of BODY_PROMO_MARKERS) {
    if (rx.test(bodyText)) {
      promoSignals += 1;
      break;
    }
  }

  // Outlook calendar birthday blasts are almost always low-value for retrieval.
  if (/calendarnotification@outlook\.com/i.test(from) && /\bbirthday\b/i.test(subject)) {
    return {
      importance: "not_important",
      reasons: ["bucket:for_sure_not_important", "calendar_birthday_notification"],
    };
  }

  if (
    !params.hasAttachment &&
    LOW_VALUE_CI_SUBJECT.some((rx) => rx.test(subject)) &&
    !hasLegalClaimSignal
  ) {
    return {
      importance: "not_important",
      reasons: ["bucket:for_sure_not_important", "ci_notification_noise"],
    };
  }
  if (
    !params.hasAttachment &&
    (LOW_VALUE_SOCIAL_SUBJECT.some((rx) => rx.test(subject)) || /nextdoor/i.test(from)) &&
    !hasLegalClaimSignal
  ) {
    return {
      importance: "not_important",
      reasons: ["bucket:for_sure_not_important", "social_digest_noise"],
    };
  }

  if (strongReasons.length > 0) {
    return {
      importance: "important",
      reasons: ["bucket:for_sure_important", ...strongReasons, ...weakReasons],
    };
  }

  // Weak hints alone should not override strong bulk/newsletter signals.
  if (
    !params.hasAttachment &&
    promoSignals >= 2 &&
    weakReasons.length === 0 &&
    !hasLegalClaimSignal
  ) {
    return {
      importance: "not_important",
      reasons: ["bucket:for_sure_not_important", "promo_combined_signals"],
    };
  }
  if (!params.hasAttachment && promoSignals >= 3 && !hasLegalClaimSignal) {
    return {
      importance: "not_important",
      reasons: ["bucket:for_sure_not_important", "promo_overrides_weak_signals"],
    };
  }
  if (!params.hasAttachment && promoSignals >= 2 && !hasLegalClaimSignal) {
    return {
      importance: "not_important",
      reasons: ["bucket:for_sure_not_important", "default_to_promo_when_bulk"],
    };
  }

  // "maybe" bucket defaults to important; optional model pass can demote.
  if (weakReasons.length > 0) {
    return { importance: "important", reasons: ["bucket:maybe", ...weakReasons] };
  }

  return { importance: "important", reasons: ["bucket:maybe", "default_keep_conservative"] };
}

export function messageDedupeKey(headers: Record<string, string>, bodyText: string): string {
  const messageId = cleanHeaderValue(headers["message-id"]);
  if (messageId) {
    return `mid:${messageId.toLowerCase()}`;
  }
  const from = cleanHeaderValue(headers["from"]) ?? "";
  const to = cleanHeaderValue(headers["to"]) ?? "";
  const subject = cleanHeaderValue(headers["subject"]) ?? "";
  const date = cleanHeaderValue(headers["date"]) ?? "";
  return `hash:${sha1(`${from}|${to}|${subject}|${date}|${bodyText.slice(0, 1000)}`)}`;
}

export function safeFileName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function nowIso(): string {
  return new Date().toISOString();
}
