#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i += 1;
  }

  const storeDir =
    args["store-dir"] || path.join(os.homedir(), ".openclaw", "mail-reclass-full-v1");
  const outDir = args["out-dir"] || path.join(storeDir, "digests");
  const qwenUrl = args["qwen-url"] || "http://127.0.0.1:11434/v1/chat/completions";
  const qwenModel = args["qwen-model"] || "qwen2.5:14b";
  const windowHours = Number(args["window-hours"] || "24");
  const maxItems = Number(args["max-items"] || "80");
  const nowIso = args["now"];

  if (!Number.isFinite(windowHours) || windowHours < 1) {
    throw new Error("--window-hours must be >= 1");
  }
  if (!Number.isFinite(maxItems) || maxItems < 1) {
    throw new Error("--max-items must be >= 1");
  }

  return { storeDir, outDir, qwenUrl, qwenModel, windowHours, maxItems, nowIso };
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

async function collectRecentRecordIds(eventsFile, startIso, endIso) {
  const ids = new Set();
  const rl = readline.createInterface({
    input: fs.createReadStream(eventsFile, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) {
      continue;
    }
    const event = safeJsonParse(line);
    if (!event || event.type !== "ingested" || !event.ts || !event.recordId) {
      continue;
    }
    if (event.ts >= startIso && event.ts <= endIso) {
      ids.add(event.recordId);
    }
  }

  return ids;
}

async function loadRecordsById(recordsFile, ids) {
  const out = [];
  if (ids.size === 0) {
    return out;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(recordsFile, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) {
      continue;
    }
    const record = safeJsonParse(line);
    if (!record || !record.id) {
      continue;
    }
    if (ids.has(record.id)) {
      out.push(record);
    }
  }

  return out;
}

function compactRecord(record) {
  const subject = (record.subject || "(no subject)").replace(/\s+/g, " ").trim();
  const from = (record.from || "(unknown sender)").replace(/\s+/g, " ").trim();
  const date = (record.date || "").replace(/\s+/g, " ").trim();
  const body = (record.bodyText || "").replace(/\s+/g, " ").trim().slice(0, 280);
  const importance = record.importance || "unknown";
  return `- [${importance}] ${subject} | from: ${from} | date: ${date} | body: ${body}`;
}

function buildPrompt(records, startIso, endIso, maxItems) {
  const important = records.filter((r) => r.importance === "important");
  const chosen = (important.length > 0 ? important : records).slice(0, maxItems);
  const lines = chosen.map(compactRecord).join("\n");

  return [
    `Create a concise daily email digest for the period ${startIso} to ${endIso}.`,
    "Focus on what is important/actionable. Ignore promotions unless urgent.",
    "Return strict JSON only with this schema:",
    '{"summary":string,"importantItems":[{"title":string,"why":string,"action"?:string}],"actionItems":string[],"noiseSummary":string}',
    "If there are no actionable items, keep summary short and actionItems empty.",
    "",
    "Emails:",
    lines || "(none)",
  ].join("\n");
}

function tryParseDigestJson(raw) {
  const direct = safeJsonParse(raw);
  if (direct && typeof direct.summary === "string") {
    return direct;
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const parsed = safeJsonParse(fenced[1].trim());
    if (parsed && typeof parsed.summary === "string") {
      return parsed;
    }
  }

  const objStart = raw.indexOf("{");
  const objEnd = raw.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) {
    const parsed = safeJsonParse(raw.slice(objStart, objEnd + 1));
    if (parsed && typeof parsed.summary === "string") {
      return parsed;
    }
  }

  return undefined;
}

function buildFallbackDigest(records, fallbackReason) {
  const important = records.filter((r) => r.importance === "important");
  const source = important.length > 0 ? important : records;
  const top = source.slice(0, 6).map((r) => {
    const subject = (r.subject || "(no subject)").replace(/\s+/g, " ").trim();
    const from = (r.from || "(unknown sender)").replace(/\s+/g, " ").trim();
    return { title: subject, why: `From ${from}` };
  });

  const summary =
    records.length === 0
      ? "No emails were ingested in the last 24 hours."
      : `Processed ${records.length} emails in the last 24 hours.` +
        (important.length > 0 ? ` ${important.length} were marked important.` : "");

  return {
    summary,
    importantItems: top,
    actionItems: [],
    noiseSummary: `Fallback digest used (${fallbackReason}).`,
  };
}

async function summarizeWithQwen(url, model, prompt) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You summarize email into actionable daily digests. Output valid JSON only and avoid markdown.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`qwen_http_${response.status}`);
  }

  const payload = await response.json();
  const raw = payload?.choices?.[0]?.message?.content?.trim() || "";
  const parsed = tryParseDigestJson(raw);
  if (!parsed || typeof parsed.summary !== "string") {
    throw new Error("qwen_invalid_json_output");
  }
  parsed.importantItems = Array.isArray(parsed.importantItems) ? parsed.importantItems : [];
  parsed.actionItems = Array.isArray(parsed.actionItems) ? parsed.actionItems : [];
  parsed.noiseSummary = typeof parsed.noiseSummary === "string" ? parsed.noiseSummary : "";
  return parsed;
}

function renderMarkdown(digest, records, startIso, endIso, generatedAt) {
  const importantCount = records.filter((r) => r.importance === "important").length;
  const lines = [];
  lines.push("# Daily Mail Digest");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Window: ${startIso} to ${endIso}`);
  lines.push(`- Emails processed: ${records.length}`);
  lines.push(`- Important emails: ${importantCount}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(digest.summary || "No summary.");
  lines.push("");
  lines.push("## Important Items");
  if (digest.importantItems.length === 0) {
    lines.push("- None.");
  } else {
    for (const item of digest.importantItems.slice(0, 12)) {
      const action = item.action ? ` | action: ${item.action}` : "";
      lines.push(`- ${item.title}: ${item.why}${action}`);
    }
  }
  lines.push("");
  lines.push("## Action Items");
  if (digest.actionItems.length === 0) {
    lines.push("- None.");
  } else {
    for (const action of digest.actionItems.slice(0, 12)) {
      lines.push(`- ${action}`);
    }
  }
  lines.push("");
  lines.push("## Noise");
  lines.push(digest.noiseSummary || "No notable noise patterns.");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = args.nowIso ? new Date(args.nowIso) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error("invalid --now timestamp");
  }

  const endIso = now.toISOString();
  const startIso = new Date(now.getTime() - args.windowHours * 60 * 60 * 1000).toISOString();

  const eventsFile = path.join(args.storeDir, "mail-events.jsonl");
  const recordsFile = path.join(args.storeDir, "mail-records.jsonl");
  if (!fs.existsSync(eventsFile)) {
    throw new Error(`missing events file: ${eventsFile}`);
  }
  if (!fs.existsSync(recordsFile)) {
    throw new Error(`missing records file: ${recordsFile}`);
  }

  const recordIds = await collectRecentRecordIds(eventsFile, startIso, endIso);
  const records = await loadRecordsById(recordsFile, recordIds);

  const prompt = buildPrompt(records, startIso, endIso, args.maxItems);
  let digest;
  try {
    digest = await summarizeWithQwen(args.qwenUrl, args.qwenModel, prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    digest = buildFallbackDigest(records, message);
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  const stamp = endIso.replace(/[:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const mdFile = path.join(args.outDir, `digest-${stamp}.md`);
  const jsonFile = path.join(args.outDir, `digest-${stamp}.json`);

  const markdown = renderMarkdown(digest, records, startIso, endIso, endIso);
  fs.writeFileSync(mdFile, markdown, "utf8");
  fs.writeFileSync(
    jsonFile,
    JSON.stringify(
      {
        generatedAt: endIso,
        startIso,
        endIso,
        storeDir: args.storeDir,
        recordsCount: records.length,
        importantCount: records.filter((r) => r.importance === "important").length,
        digest,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`digest_markdown=${mdFile}`);
  console.log(`digest_json=${jsonFile}`);
  console.log(`records_count=${records.length}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`daily_digest_error=${message}`);
  process.exit(1);
});
