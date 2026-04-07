/**
 * Email sender via Gmail SMTP relay.
 *
 * The cluster's egress IP is whitelisted in Google Workspace for SMTP relay
 * (smtp-relay.gmail.com:587, no auth required from approved IPs). Configuration:
 *   MAIL_FROM            — from address (e.g. notifications@baisoln.com)
 *   MAIL_SMTP_HOST       — defaults to smtp-relay.gmail.com
 *   MAIL_SMTP_PORT       — defaults to 587
 *   MAIL_SMTP_USER       — optional (only if relay requires auth)
 *   MAIL_SMTP_PASS       — optional
 *
 * Throws on send failure — never fakes success.
 */
import { createLogger } from "../_core/logger.js";

const log = createLogger("Mailer");

let transporterPromise: Promise<any> | null = null;

async function getTransporter() {
  if (transporterPromise) return transporterPromise;
  transporterPromise = (async () => {
    const nodemailer = (await import("nodemailer")).default;
    const host = process.env.MAIL_SMTP_HOST || "smtp-relay.gmail.com";
    const port = parseInt(process.env.MAIL_SMTP_PORT || "587", 10);
    const user = process.env.MAIL_SMTP_USER;
    const pass = process.env.MAIL_SMTP_PASS;
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: false, // STARTTLS on 587
      auth: user && pass ? { user, pass } : undefined,
      tls: { ciphers: "TLSv1.2" },
    });
    log.info("SMTP transporter ready", { host, port, authenticated: Boolean(user) });
    return transport;
  })();
  return transporterPromise;
}

export interface SendMailInput {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string }>;
}

export async function sendMail(input: SendMailInput): Promise<{ messageId: string }> {
  const from = process.env.MAIL_FROM;
  if (!from) throw new Error("MAIL_FROM not configured");
  const transporter = await getTransporter();
  const result = await transporter.sendMail({
    from,
    to: Array.isArray(input.to) ? input.to.join(", ") : input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    attachments: input.attachments,
  });
  log.info("Mail sent", { to: input.to, subject: input.subject, messageId: result.messageId });
  return { messageId: result.messageId };
}
