import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { safeFileName, sha1 } from "./shared.ts";

export type AttachmentAnalysisResult = {
  id: string;
  sourcePath: string;
  relativePath: string;
  sizeBytes: number;
  ext: string;
  parser: string;
  status: "ok" | "skipped" | "error";
  textPath?: string;
  textChars?: number;
  error?: string;
};

export type AnalyzerCapabilities = {
  pdftotext: boolean;
  tesseract: boolean;
  unzip: boolean;
  textutil: boolean;
};

export function detectAnalyzerCapabilities(): AnalyzerCapabilities {
  return {
    pdftotext: commandExists("pdftotext"),
    tesseract: commandExists("tesseract"),
    unzip: commandExists("unzip"),
    textutil: commandExists("textutil"),
  };
}

function commandExists(bin: string): boolean {
  const res = spawnSync("sh", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
  return res.status === 0;
}

function stripXmlTags(input: string): string {
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractWithPdfToText(filePath: string): string {
  const res = spawnSync("pdftotext", ["-layout", "-enc", "UTF-8", filePath, "-"], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(res.stderr || "pdftotext failed");
  }
  return (res.stdout ?? "").trim();
}

function extractWithTesseract(filePath: string): string {
  const res = spawnSync("tesseract", [filePath, "stdout", "-l", "eng"], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(res.stderr || "tesseract failed");
  }
  return (res.stdout ?? "").trim();
}

function extractWithTextutil(filePath: string): string {
  const res = spawnSync("textutil", ["-convert", "txt", "-stdout", filePath], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(res.stderr || "textutil failed");
  }
  return (res.stdout ?? "").trim();
}

function unzipText(filePath: string, innerPath: string): string {
  const res = spawnSync("unzip", ["-p", filePath, innerPath], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(res.stderr || `unzip failed for ${innerPath}`);
  }
  return (res.stdout ?? "").trim();
}

function extractText(
  filePath: string,
  ext: string,
  caps: AnalyzerCapabilities,
): {
  parser: string;
  text: string;
} {
  const lowerExt = ext.toLowerCase();
  if ([".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm"].includes(lowerExt)) {
    const raw = fs.readFileSync(filePath, "utf8");
    if (lowerExt === ".xml" || lowerExt === ".html" || lowerExt === ".htm") {
      return { parser: "plain+strip-tags", text: stripXmlTags(raw) };
    }
    return { parser: "plain", text: raw.trim() };
  }

  if (lowerExt === ".pdf") {
    if (!caps.pdftotext) {
      throw new Error("pdftotext_missing");
    }
    return { parser: "pdftotext", text: extractWithPdfToText(filePath) };
  }

  if ([".png", ".jpg", ".jpeg", ".webp", ".heic", ".tiff", ".bmp", ".gif"].includes(lowerExt)) {
    if (!caps.tesseract) {
      throw new Error("tesseract_missing");
    }
    return { parser: "tesseract", text: extractWithTesseract(filePath) };
  }

  if ([".docx", ".pptx", ".xlsx"].includes(lowerExt)) {
    if (!caps.unzip) {
      throw new Error("unzip_missing");
    }
    if (lowerExt === ".docx") {
      return { parser: "unzip-docx", text: stripXmlTags(unzipText(filePath, "word/document.xml")) };
    }
    if (lowerExt === ".pptx") {
      return {
        parser: "unzip-pptx",
        text: stripXmlTags(unzipText(filePath, "ppt/slides/slide1.xml")),
      };
    }
    return {
      parser: "unzip-xlsx",
      text: stripXmlTags(unzipText(filePath, "xl/sharedStrings.xml")),
    };
  }

  if ([".doc", ".xls", ".rtf"].includes(lowerExt)) {
    if (!caps.textutil) {
      throw new Error("textutil_missing");
    }
    return { parser: "textutil", text: extractWithTextutil(filePath) };
  }

  throw new Error("unsupported_file_type");
}

export function analyzeAttachmentFile(params: {
  filePath: string;
  inDir: string;
  textDir: string;
  maxBytes: number;
  caps: AnalyzerCapabilities;
}): AttachmentAnalysisResult {
  const { filePath, inDir, textDir, maxBytes, caps } = params;
  const rel = path.relative(inDir, filePath);
  const ext = path.extname(filePath).toLowerCase();

  const st = fs.statSync(filePath);
  if (st.size > maxBytes) {
    return {
      id: sha1(filePath),
      sourcePath: filePath,
      relativePath: rel,
      sizeBytes: st.size,
      ext,
      parser: "size-gate",
      status: "skipped",
      error: `file_too_large>${maxBytes}`,
    };
  }

  let extracted: { parser: string; text: string };
  try {
    extracted = extractText(filePath, ext, caps);
  } catch (err) {
    const message = String(err);
    // Unsupported legacy/niche formats are expected; treat as skipped, not failed.
    if (message.includes("unsupported_file_type")) {
      return {
        id: sha1(filePath),
        sourcePath: filePath,
        relativePath: rel,
        sizeBytes: st.size,
        ext,
        parser: "unsupported",
        status: "skipped",
        error: "unsupported_file_type",
      };
    }
    // OCR occasionally fails on corrupted/odd images; keep the pipeline moving.
    if (message.toLowerCase().includes("error during processing")) {
      return {
        id: sha1(filePath),
        sourcePath: filePath,
        relativePath: rel,
        sizeBytes: st.size,
        ext,
        parser: "ocr",
        status: "skipped",
        error: "ocr_processing_error",
      };
    }
    throw err;
  }
  const id = sha1(`${filePath}:${st.size}:${st.mtimeMs}`);
  const textPath = path.join(textDir, `${safeFileName(id)}.txt`);
  fs.writeFileSync(textPath, `${extracted.text}\n`, "utf8");

  return {
    id,
    sourcePath: filePath,
    relativePath: rel,
    sizeBytes: st.size,
    ext,
    parser: extracted.parser,
    status: "ok",
    textPath,
    textChars: extracted.text.length,
  };
}

export function walkFiles(root: string, out: string[]): void {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
}
