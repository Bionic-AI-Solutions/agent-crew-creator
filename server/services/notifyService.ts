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
import { renderReportPdf } from "./pdfReport.js";

const log = createLogger("Notify");

interface NotifyPayload {
  subject: string;
  to_email?: string;
  to_webhook?: string;
  render_pdf?: boolean;
  dossier_markdown?: string;
}

let _notifyTokenCache: string | null = null;
export async function getNotifyToken(): Promise<string> {
  if (_notifyTokenCache !== null) return _notifyTokenCache;
  const fromEnv = process.env.NOTIFY_WEBHOOK_TOKEN;
  if (fromEnv) {
    _notifyTokenCache = fromEnv;
    return fromEnv;
  }
  try {
    const { readPlatformSecret } = await import("../vaultClient.js");
    const v = await readPlatformSecret("notify");
    _notifyTokenCache = v?.webhook_token || "";
    return _notifyTokenCache;
  } catch {
    _notifyTokenCache = "";
    return "";
  }
}


export async function handleNotifyWebhook(req: Request, res: Response): Promise<void> {
  const expected = await getNotifyToken();
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
              content: await renderReportPdf({
                title: payload.subject,
                subtitle: "Investment Due Diligence Report",
                preparedFor: payload.to_email,
                markdown: dossier,
              }),
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
