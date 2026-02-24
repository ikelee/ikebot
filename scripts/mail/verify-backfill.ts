import fs from "node:fs";
import path from "node:path";
import { expandHome, parseArgs, readJsonIfExists } from "./shared.ts";

type LegacyIndexFile = {
  version: number;
  updatedAt: string;
  records: Record<
    string,
    {
      importance: "important" | "not_important";
      hasAttachment: boolean;
      from?: string;
      subject?: string;
      date?: string;
      dedupeKey: string;
    }
  >;
};

type JsonlIndexFile = {
  version: 2;
  updatedAt: string;
  format: "jsonl";
  recordsFile: string;
  counts?: {
    processed?: number;
    important?: number;
    notImportant?: number;
    duplicates?: number;
    failed?: number;
  };
};

function usage(): never {
  console.error(
    "Usage: bun scripts/mail/verify-backfill.ts [--out-dir <dir>] [--index <file>] [--events <file>]",
  );
  process.exit(1);
}

function countJsonl(filePath: string): number {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.trim().length === 0) {
    return 0;
  }
  return raw.trimEnd().split(/\r?\n/).length;
}

function readJsonlRecords(filePath: string): Array<{
  importance: "important" | "not_important";
  hasAttachment: boolean;
  from?: string;
}> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.trim().length === 0) {
    return [];
  }
  const out: Array<{
    importance: "important" | "not_important";
    hasAttachment: boolean;
    from?: string;
  }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as {
        importance?: "important" | "not_important";
        hasAttachment?: boolean;
        from?: string;
      };
      if (parsed.importance === "important" || parsed.importance === "not_important") {
        out.push({
          importance: parsed.importance,
          hasAttachment: parsed.hasAttachment === true,
          from: parsed.from,
        });
      }
    } catch {
      continue;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(
    expandHome(typeof args["out-dir"] === "string" ? args["out-dir"] : "./tmp/mail-backfill"),
  );
  const indexPath = path.resolve(
    expandHome(typeof args.index === "string" ? args.index : path.join(outDir, "mail-index.json")),
  );
  const eventsPath = path.resolve(
    expandHome(
      typeof args.events === "string" ? args.events : path.join(outDir, "mail-events.jsonl"),
    ),
  );

  if (!fs.existsSync(indexPath)) {
    usage();
  }

  const index = readJsonIfExists<LegacyIndexFile | JsonlIndexFile>(indexPath);
  if (!index) {
    throw new Error(`failed to parse index: ${indexPath}`);
  }

  const records =
    "format" in index && index.format === "jsonl"
      ? readJsonlRecords(path.resolve(expandHome(index.recordsFile)))
      : Object.values(index.records);
  const total = records.length;
  let important = 0;
  let notImportant = 0;
  let withAttachments = 0;

  const fromCount = new Map<string, number>();

  for (const rec of records) {
    if (rec.importance === "important") {
      important += 1;
    } else {
      notImportant += 1;
    }
    if (rec.hasAttachment) {
      withAttachments += 1;
    }
    const from = (rec.from ?? "").trim();
    if (from) {
      fromCount.set(from, (fromCount.get(from) ?? 0) + 1);
    }
  }

  const topSenders = [...fromCount.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([from, count]) => ({ from, count }));

  const eventLines = countJsonl(eventsPath);

  const report = {
    generatedAt: new Date().toISOString(),
    indexPath,
    eventsPath,
    totals: {
      total,
      important,
      notImportant,
      withAttachments,
      events: eventLines,
    },
    topSenders,
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
