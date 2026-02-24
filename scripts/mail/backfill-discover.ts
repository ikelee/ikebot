import fs from "node:fs";
import path from "node:path";
import {
  type MailSource,
  ensureDir,
  expandHome,
  parseArgs,
  resolveCsvPaths,
  sha1,
  writeJson,
} from "./shared.ts";

type DiscoverOutput = {
  generatedAt: string;
  roots: string[];
  counts: Record<string, number>;
  sources: MailSource[];
};

function usage(): never {
  console.error(
    "Usage: bun scripts/mail/backfill-discover.ts --roots <csv paths> [--out <file>] [--max-depth <n>]",
  );
  process.exit(1);
}

function statSource(filePath: string, kind: MailSource["kind"]): MailSource {
  const st = fs.statSync(filePath);
  return {
    id: sha1(`${kind}:${filePath}:${st.size}:${st.mtimeMs}`),
    kind,
    path: filePath,
    sizeBytes: st.size,
    mtimeMs: st.mtimeMs,
  };
}

function looksLikeMbox(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (base.endsWith(".mbox") || base.endsWith(".mbx")) {
    return true;
  }
  if (base.endsWith(".msf") || base.endsWith(".sqlite") || base.endsWith(".dat")) {
    return false;
  }
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(12);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, bytes).toString("utf8");
    return head.startsWith("From ") || head.includes("\nFrom ");
  } catch {
    return false;
  }
}

function discover(root: string, maxDepth: number, out: MailSource[]): void {
  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    const hasMaildir = entries.some(
      (entry) => entry.isDirectory() && (entry.name === "cur" || entry.name === "new"),
    );
    if (hasMaildir) {
      out.push(statSource(current, "maildir"));
      return;
    }

    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(next, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".eml")) {
        out.push(statSource(next, "eml"));
        continue;
      }
      if (looksLikeMbox(next)) {
        out.push(statSource(next, "mbox"));
      }
    }
  };

  walk(root, 0);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rootsArg = args["roots"];
  if (typeof rootsArg !== "string") {
    usage();
  }

  const maxDepth = typeof args["max-depth"] === "string" ? Number(args["max-depth"]) : 10;
  if (!Number.isFinite(maxDepth) || maxDepth < 1) {
    throw new Error("--max-depth must be a positive number");
  }

  const outFile = path.resolve(
    expandHome(typeof args.out === "string" ? args.out : "./tmp/mail-backfill/sources.json"),
  );

  const roots = resolveCsvPaths(rootsArg);
  const sources: MailSource[] = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) {
      console.warn(`skip missing root: ${root}`);
      continue;
    }
    discover(root, maxDepth, sources);
  }

  const unique = new Map<string, MailSource>();
  for (const source of sources) {
    unique.set(source.path, source);
  }

  const deduped = [...unique.values()].toSorted((a, b) => a.path.localeCompare(b.path));
  const counts: Record<string, number> = { mbox: 0, maildir: 0, eml: 0 };
  for (const source of deduped) {
    counts[source.kind] += 1;
  }

  const payload: DiscoverOutput = {
    generatedAt: new Date().toISOString(),
    roots,
    counts,
    sources: deduped,
  };

  ensureDir(path.dirname(outFile));
  writeJson(outFile, payload);

  console.log(`wrote ${deduped.length} sources -> ${outFile}`);
  console.log(`counts: mbox=${counts.mbox} maildir=${counts.maildir} eml=${counts.eml}`);
}

main();
