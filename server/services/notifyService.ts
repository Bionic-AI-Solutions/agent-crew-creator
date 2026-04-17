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
  if (!expected) {
    res.status(503).json({ error: "Notify webhook not configured — set webhook_token in Vault" });
    return;
  }
  const got = req.header("x-bionic-token");
  if (got !== expected) {
    res.status(401).json({ error: "invalid token" });
    return;
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

  // Webhook — validate URL to prevent SSRF
  if (payload.to_webhook) {
    try {
      const webhookUrl = new URL(payload.to_webhook);
      // Only allow HTTPS webhooks (or HTTP for known internal hosts)
      if (webhookUrl.protocol !== "https:" && webhookUrl.protocol !== "http:") {
        log.warn("Webhook rejected: invalid protocol", { url: payload.to_webhook });
        res.status(400).json({ error: "Webhook URL must use https" });
        return;
      }
      // Block internal/private IPs and metadata endpoints
      const blockedHosts = ["169.254.169.254", "metadata.google", "localhost", "127.0.0.1", "0.0.0.0", "[::1]"];
      if (blockedHosts.some((h) => webhookUrl.hostname.includes(h))) {
        log.warn("Webhook rejected: blocked host", { host: webhookUrl.hostname });
        res.status(400).json({ error: "Webhook URL points to restricted host" });
        return;
      }
      // Block internal K8s service addresses unless explicitly allowed
      if (webhookUrl.hostname.endsWith(".svc.cluster.local") && !process.env.ALLOW_INTERNAL_WEBHOOKS) {
        log.warn("Webhook rejected: internal K8s service", { host: webhookUrl.hostname });
        res.status(400).json({ error: "Webhook URL must be external (set ALLOW_INTERNAL_WEBHOOKS=true to override)" });
        return;
      }

      // Resolve hostname to IP and block private/link-local ranges
      try {
        const dns = await import("dns");
        const { promisify } = await import("util");
        const resolve4 = promisify(dns.resolve4);
        const ips = await resolve4(webhookUrl.hostname);
        for (const ip of ips) {
          if (ip.startsWith("10.") || ip.startsWith("172.16.") || ip.startsWith("172.17.") ||
              ip.startsWith("172.18.") || ip.startsWith("172.19.") || ip.startsWith("172.2") ||
              ip.startsWith("172.3") || ip.startsWith("192.168.") || ip.startsWith("127.") ||
              ip.startsWith("169.254.") || ip === "0.0.0.0") {
            log.warn("Webhook rejected: resolved to private IP", { host: webhookUrl.hostname, ip });
            res.status(400).json({ error: "Webhook URL resolves to private/internal IP" });
            return;
          }
        }
      } catch (dnsErr) {
        log.warn("Webhook DNS resolution failed", { host: webhookUrl.hostname, error: String(dnsErr) });
        // Allow the fetch to try (DNS might resolve differently from the fetch perspective)
      }

      // Only allow HTTPS in production
      if (process.env.NODE_ENV === "production" && webhookUrl.protocol !== "https:") {
        res.status(400).json({ error: "Webhook URL must use HTTPS in production" });
        return;
      }

      const r = await fetch(payload.to_webhook, {
        method: "POST",
        redirect: "error", // SSRF defense: reject any redirects
        signal: AbortSignal.timeout(10_000), // 10s timeout
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
