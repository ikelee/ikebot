import path from "node:path";
import {
  analyzeAttachmentFile,
  detectAnalyzerCapabilities,
  walkFiles,
  type AttachmentAnalysisResult,
} from "./attachment-analysis-lib.ts";
import { appendJsonl, ensureDir, expandHome, parseArgs, writeJson } from "./shared.ts";

function usage(): never {
  console.error(
    "Usage: bun scripts/mail/attachment-extract.ts --in-dir <dir> [--out-dir <dir>] [--max-bytes <n>] [--max-files <n>]",
  );
  process.exit(1);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args["in-dir"] !== "string") {
    usage();
  }

  const inDir = path.resolve(expandHome(args["in-dir"]));
  const outDir = path.resolve(
    expandHome(
      typeof args["out-dir"] === "string"
        ? args["out-dir"]
        : "./tmp/mail-backfill/attachment-analysis",
    ),
  );
  const maxBytes =
    typeof args["max-bytes"] === "string" ? Number(args["max-bytes"]) : 25 * 1024 * 1024;
  const maxFiles =
    typeof args["max-files"] === "string" ? Number(args["max-files"]) : Number.POSITIVE_INFINITY;

  const textDir = path.join(outDir, "text");
  const reviewDir = path.join(outDir, "review");
  ensureDir(textDir);
  ensureDir(reviewDir);
  const summaryFile = path.join(outDir, "analysis-summary.json");
  const jsonlFile = path.join(outDir, "analysis.jsonl");
  const skippedFile = path.join(reviewDir, "attachment-skipped.jsonl");
  const errorFile = path.join(reviewDir, "attachment-errors.jsonl");
  fs.closeSync(fs.openSync(skippedFile, "a"));
  fs.closeSync(fs.openSync(errorFile, "a"));

  const caps = detectAnalyzerCapabilities();
  const allFiles: string[] = [];
  walkFiles(inDir, allFiles);

  let processed = 0;
  let ok = 0;
  let skipped = 0;
  let errors = 0;

  for (const filePath of allFiles) {
    if (processed >= maxFiles) {
      break;
    }
    processed += 1;

    try {
      const rec = analyzeAttachmentFile({ filePath, inDir, textDir, maxBytes, caps });
      appendJsonl(jsonlFile, rec);
      if (rec.status === "ok") {
        ok += 1;
      } else if (rec.status === "skipped") {
        skipped += 1;
        appendJsonl(skippedFile, rec);
      } else {
        errors += 1;
        appendJsonl(errorFile, rec);
      }
    } catch (err) {
      const rec: AttachmentAnalysisResult = {
        id: "error",
        sourcePath: filePath,
        relativePath: path.relative(inDir, filePath),
        sizeBytes: 0,
        ext: path.extname(filePath).toLowerCase(),
        parser: "none",
        status: "error",
        error: String(err),
      };
      appendJsonl(jsonlFile, rec);
      appendJsonl(errorFile, rec);
      errors += 1;
    }
  }

  writeJson(summaryFile, {
    generatedAt: new Date().toISOString(),
    inDir,
    outDir,
    processed,
    ok,
    skipped,
    errors,
    tools: caps,
  });

  console.log(`processed=${processed} ok=${ok} skipped=${skipped} errors=${errors}`);
  console.log(`summary=${summaryFile}`);
  console.log(`jsonl=${jsonlFile}`);
  console.log(`review=${reviewDir}`);
}

main();
