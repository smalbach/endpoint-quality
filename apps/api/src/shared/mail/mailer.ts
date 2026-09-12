/**
 * Sending mail, behind a port.
 *
 * Two adapters and the choice is `MAIL_DRIVER`:
 *
 * - `log` writes the mail to the process log. The default, because a local install or a CI job
 *   should not need a mail provider to register an account — and the reset link is right there in
 *   the output for whoever is running it.
 * - `brevo` sends through Brevo's HTTP API, which is what the analyzer used. HTTP rather than SMTP
 *   so there is no dependency to add and no port to open.
 *
 * Deliberately not routed through the SSRF guard: the guard exists for URLs the *product's users*
 * type, and this one is a constant.
 */
import { Logger } from "@nestjs/common";

export const MAILER = Symbol("MAILER");

export type Mail = { to: string; subject: string; html: string; text: string };

export interface MailerPort {
  send(mail: Mail): Promise<void>;
}

export class LogMailer implements MailerPort {
  private readonly logger = new Logger("Mail");

  async send(mail: Mail): Promise<void> {
    this.logger.log(`Para ${mail.to} · ${mail.subject}\n${mail.text}`);
  }
}

export class BrevoMailer implements MailerPort {
  constructor(
    private readonly apiKey: string,
    private readonly from: { email: string; name: string },
  ) {}

  async send(mail: Mail): Promise<void> {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": this.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: this.from,
        to: [{ email: mail.to }],
        subject: mail.subject,
        htmlContent: mail.html,
        textContent: mail.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Brevo respondió ${response.status}`);
  }
}

/** A mail the tests can read: the reset link is only reachable through it. */
export class RecordingMailer implements MailerPort {
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

function layout(title: string, paragraphs: string[], action: { label: string; href: string }): string {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f8fafc;font-family:system-ui,sans-serif;color:#0f172a">
<div style="max-width:480px;margin:32px auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px">
<p style="margin:0 0 4px;font-size:12px;color:#64748b">Endpoint Quality</p>
<h1 style="margin:0 0 16px;font-size:18px">${escapeHtml(title)}</h1>
${paragraphs.map((paragraph) => `<p style="font-size:14px;line-height:22px;color:#334155">${escapeHtml(paragraph)}</p>`).join("\n")}
<p style="margin:24px 0"><a href="${escapeHtml(action.href)}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">${escapeHtml(action.label)}</a></p>
<p style="font-size:12px;color:#94a3b8;word-break:break-all">${escapeHtml(action.href)}</p>
</div></body></html>`;
}

export function welcomeMail(input: { name: string; link: string }): Omit<Mail, "to"> {
  const lines = [
    `Hola, ${input.name}.`,
    "Tu cuenta está creada. Crea un proyecto, importa su contrato OpenAPI y lanza la primera corrida.",
  ];
  return {
    subject: "Bienvenida a Endpoint Quality",
    html: layout("Tu cuenta está lista", lines, { label: "Entrar", href: input.link }),
    text: `${lines.join("\n\n")}\n\n${input.link}`,
  };
}

export function passwordResetMail(input: { name: string; link: string; minutes: number }): Omit<Mail, "to"> {
  const lines = [
    `Hola, ${input.name}.`,
    `Alguien pidió restablecer la contraseña de esta cuenta. El enlace funciona una sola vez durante ${input.minutes} minutos.`,
    "Si no fuiste tú, ignora este correo: tu contraseña no cambia.",
  ];
  return {
    subject: "Restablecer tu contraseña",
    html: layout("Restablecer la contraseña", lines, { label: "Elegir una contraseña nueva", href: input.link }),
    text: `${lines.join("\n\n")}\n\n${input.link}`,
  };
}
