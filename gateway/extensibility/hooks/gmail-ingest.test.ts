import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../infra/config/config.js";
import { ingestGmailHookPayload } from "./gmail-ingest.js";

describe("gmail hook ingest", () => {
  it("ingests messages into the mail workspace", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gmail-ingest-"));
    const cfg = {
      agents: {
        list: [{ id: "mail", workspace }],
      },
    } as OpenClawConfig;

    const summary = await ingestGmailHookPayload({
      cfg,
      payload: {
        messages: [
          {
            id: "msg-1",
            from: "billing@example.com",
            subject: "Invoice for your subscription",
            snippet: "Your invoice is ready",
          },
        ],
      },
    });

    expect(summary.outDir).toBe(workspace);
    expect(summary.ingested).toBe(1);
    expect(summary.duplicates).toBe(0);
    expect(fs.existsSync(path.join(workspace, "mail-records.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "mail-events.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "mail-index.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "mail-checkpoint.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "mail-dedupe-keys.txt"))).toBe(true);
  });

  it("skips duplicates on rerun", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gmail-ingest-rerun-"));
    const cfg = {
      agents: {
        list: [{ id: "mail", workspace }],
      },
    } as OpenClawConfig;
    const payload = {
      messages: [
        {
          id: "msg-2",
          from: "alerts@example.com",
          subject: "Security alert",
          snippet: "New login detected",
        },
      ],
    };

    const first = await ingestGmailHookPayload({ cfg, payload });
    const second = await ingestGmailHookPayload({ cfg, payload });

    expect(first.ingested).toBe(1);
    expect(first.duplicates).toBe(0);
    expect(second.ingested).toBe(0);
    expect(second.duplicates).toBe(1);
  });

  it("uses hooks.gmail.storeDir as canonical output path", async () => {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gmail-store-"));
    const cfg = {
      hooks: {
        gmail: {
          storeDir,
        },
      },
    } as OpenClawConfig;

    const summary = await ingestGmailHookPayload({
      cfg,
      payload: {
        messages: [{ id: "msg-store-1", subject: "Hello", snippet: "World" }],
      },
    });

    expect(summary.outDir).toBe(storeDir);
    expect(fs.existsSync(path.join(storeDir, "mail-records.jsonl"))).toBe(true);
  });

  it("downgrades forwarded promo messages", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gmail-ingest-fw-"));
    const cfg = {
      hooks: {
        gmail: {
          storeDir: workspace,
        },
      },
    } as OpenClawConfig;

    await ingestGmailHookPayload({
      cfg,
      payload: {
        messages: [
          {
            id: "msg-fw-1",
            from: "news@marketing.example.com",
            subject: "FW: weekly deals",
            snippet: "Unsubscribe to stop receiving these emails",
            body: "Forwarded message from sender. Sale now on.",
          },
        ],
      },
    });

    const line = fs.readFileSync(path.join(workspace, "mail-records.jsonl"), "utf8").trim();
    const record = JSON.parse(line) as { importance: string; importanceReasons: string[] };
    expect(record.importance).toBe("not_important");
    expect(record.importanceReasons).toContain("promo_combined_signals");
  });

  it("writes qmd docs only for important records", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gmail-ingest-qmd-"));
    const cfg = {
      hooks: {
        gmail: {
          storeDir: workspace,
        },
      },
    } as OpenClawConfig;

    await ingestGmailHookPayload({
      cfg,
      payload: {
        messages: [
          {
            id: "msg-qmd-important",
            from: "billing@example.com",
            subject: "Invoice for your subscription",
            snippet: "Your invoice is ready",
          },
          {
            id: "msg-qmd-not-important",
            from: "news@marketing.example.com",
            subject: "weekly deals",
            snippet: "sale now on",
          },
        ],
      },
    });

    const records = fs
      .readFileSync(path.join(workspace, "mail-records.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line)) as Array<{
      id: string;
      importance: "important" | "not_important";
    }>;
    const important = records.find((record) => record.importance === "important");
    const notImportant = records.find((record) => record.importance === "not_important");
    expect(important).toBeDefined();
    expect(notImportant).toBeDefined();

    const importantDoc = path.join(workspace, "qmd", "emails", "important", `${important!.id}.md`);
    const notImportantDoc = path.join(
      workspace,
      "qmd",
      "emails",
      "important",
      `${notImportant!.id}.md`,
    );
    expect(fs.existsSync(importantDoc)).toBe(true);
    expect(fs.existsSync(notImportantDoc)).toBe(false);
  });

  it("treats forwarded sender identity as neutral", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gmail-ingest-fw-neutral-"));
    const cfg = {
      hooks: {
        gmail: {
          storeDir: workspace,
        },
      },
    } as OpenClawConfig;

    await ingestGmailHookPayload({
      cfg,
      payload: {
        messages: [
          {
            id: "msg-fw-neutral-1",
            from: "alerts@bank.example.com",
            subject: "FW: quick note",
            snippet: "Forwarded message. FYI only.",
            body: "Forwarded message. FYI only.",
          },
        ],
      },
    });

    const line = fs.readFileSync(path.join(workspace, "mail-records.jsonl"), "utf8").trim();
    const record = JSON.parse(line) as { importanceReasons: string[] };
    expect(record.importanceReasons.some((reason) => reason.startsWith("from:"))).toBe(false);
  });

  it("flags obvious phishing mismatch as not important", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gmail-ingest-phish-"));
    const cfg = {
      hooks: {
        gmail: {
          storeDir: workspace,
        },
      },
    } as OpenClawConfig;

    await ingestGmailHookPayload({
      cfg,
      payload: {
        messages: [
          {
            id: "msg-phish-1",
            from: "alerts@totally-not-chase-security.co",
            subject: "Chase security alert - verify your account now",
            snippet: "Urgent action required",
            body: "Urgent action required. Your account is suspended. Click this link to verify your password.",
          },
        ],
      },
    });

    const line = fs.readFileSync(path.join(workspace, "mail-records.jsonl"), "utf8").trim();
    const record = JSON.parse(line) as { importance: string; importanceReasons: string[] };
    expect(record.importance).toBe("not_important");
    expect(record.importanceReasons).toContain("phishing_signal");
  });
});
