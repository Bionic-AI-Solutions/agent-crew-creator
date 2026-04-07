/**
 * Notification dispatcher used by the Due Diligence template.
 *
 * Receives a payload (subject, recipients, dossier markdown) from a Dify
 * workflow's HTTP node, optionally renders the markdown to a simple PDF,
 * then dispatches via Gmail SMTP relay and/or generic webhook.
 *
 * Auth: callers must present `X-Bionic-Token` matching env NOTIFY_WEBHOOK_TOKEN.
 * The Dify DSL injects this token at install time so cluster-internal traffic
 * is still verified end-to-end.
 */
import type { Request, Response } from "express";
import { createLogger } from "../_core/logger.js";
import { sendMail } from "./mailer.js";

const log = createLogger("Notify");

interface NotifyPayload {
  subject: string;
  to_email?: string;
  to_webhook?: string;
  render_pdf?: boolean;
  dossier_markdown?: string;
}

export function getNotifyToken(): string {
  return process.env.NOTIFY_WEBHOOK_TOKEN || "";
}

/**
 * Render markdown to a minimal PDF. We avoid pulling a full headless-browser
 * dependency by emitting a single-page PDF whose content stream is the
 * markdown rendered as monospaced text. Good enough for an email attachment
 * the analyst will preview before sharing externally; can be upgraded later
 * to weasyprint / puppeteer if richer typography is needed.
 */
function markdownToPdfBuffer(title: string, markdown: string): Buffer {
  const escape = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const lines = `${title}\n${"=".repeat(title.length)}\n\n${markdown}`.split(/\r?\n/);
  // Build a content stream: start at top-left of A4, 11pt Courier, 14pt leading
  const content: string[] = ["BT", "/F1 11 Tf", "14 TL", "50 800 Td"];
  for (const line of lines) {
    // Wrap lines longer than ~95 chars
    const chunks = line.match(/.{1,95}/g) || [""];
    for (const chunk of chunks) {
      content.push(`(${escape(chunk)}) Tj T*`);
    }
  }
  content.push("ET");
  const stream = content.join("\n");

  const objects: string[] = [];
  const offsets: number[] = [];
  let pdf = "%PDF-1.4\n";
  const push = (obj: string) => {
    offsets.push(pdf.length);
    pdf += obj;
    objects.push(obj);
  };
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  push(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
  );
  push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n");
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

export async function handleNotifyWebhook(req: Request, res: Response): Promise<void> {
  const expected = getNotifyToken();
  if (expected) {
    const got = req.header("x-bionic-token");
    if (got !== expected) {
      res.status(401).json({ error: "invalid token" });
      return;
    }
  }
  const payload = req.body as NotifyPayload;
  if (!payload?.subject) {
    res.status(400).json({ error: "missing subject" });
    return;
  }
  const dossier = payload.dossier_markdown || "";
  const dispatched: string[] = [];

  // Email
  if (payload.to_email) {
    try {
      const attachments = payload.render_pdf
        ? [
            {
              filename: `${payload.subject.replace(/[^a-z0-9-_]+/gi, "_")}.pdf`,
              content: markdownToPdfBuffer(payload.subject, dossier),
              contentType: "application/pdf",
            },
          ]
        : undefined;
      await sendMail({
        to: payload.to_email,
        subject: payload.subject,
        text: dossier,
        html: `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${dossier
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")}</pre>`,
        attachments,
      });
      dispatched.push("email");
    } catch (err) {
      log.error("Email dispatch failed", { error: String(err) });
    }
  }

  // Webhook
  if (payload.to_webhook) {
    try {
      const r = await fetch(payload.to_webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `*${payload.subject}*\n\n${dossier.slice(0, 3500)}`,
          subject: payload.subject,
          dossier_markdown: dossier,
        }),
      });
      if (r.ok) dispatched.push("webhook");
      else log.warn("Webhook returned non-OK", { status: r.status });
    } catch (err) {
      log.error("Webhook dispatch failed", { error: String(err) });
    }
  }

  log.info("Notify dispatched", { subject: payload.subject, dispatched });
  res.json({ ok: true, dispatched });
}
