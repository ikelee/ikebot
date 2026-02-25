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
});
