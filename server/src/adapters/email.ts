// Email adapters. Resend: one HTTPS call, works on Workers. Log: sends nothing and keeps the
// messages in memory (local development, demo mode and tests).

import type { EmailMessage, EmailSender } from "../ports";

export class ResendEmailSender implements EmailSender {
  readonly name = "resend";
  readonly live = true;

  /** @param from e.g. "PickleHeat <hello@yourdomain.com>"; the domain must be verified in Resend. */
  constructor(private apiKey: string, private from: string, private fetchFn: typeof fetch = fetch) {}

  async send(m: EmailMessage): Promise<void> {
    const res = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    });
    if (!res.ok) throw new Error(`Resend: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

export class LogEmailSender implements EmailSender {
  readonly name = "log";
  readonly live = false;
  sent: EmailMessage[] = [];

  async send(m: EmailMessage): Promise<void> {
    this.sent.push(m);
    if (this.sent.length > 50) this.sent.shift();
  }
}
