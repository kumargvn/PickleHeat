// Push adapters. APNs: Apple's HTTP/2 API with a token signed by your .p8 key (ES256).
// Log: sends nothing and keeps the messages in memory (local development, demo mode and tests).
//
// APNs needs HTTP/2. Cloudflare Workers' fetch speaks it; Bun's does not yet, so the local
// Bun entry should leave the APNS_* settings empty.

import type { Device, PushMessage, PushSender } from "../ports";
import { b64urlDecode } from "./crypto";

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === "string" ? enc.encode(b) : b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** Contents of the AuthKey_XXXX.p8 file (with or without the BEGIN/END lines). */
  privateKey: string;
  /** The app's bundle ID. */
  topic: string;
}

export class ApnsPushSender implements PushSender {
  readonly name = "apns";
  private key: Promise<CryptoKey> | null = null;
  private jwt: { token: string; at: number } | null = null;

  constructor(private cfg: ApnsConfig, private fetchFn: typeof fetch = fetch, private now: () => number = Date.now) {}

  private importKey(): Promise<CryptoKey> {
    if (!this.key) {
      const body = this.cfg.privateKey.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
      const der = b64urlDecode(body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
      this.key = crypto.subtle.importKey("pkcs8", der as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    }
    return this.key;
  }

  /** Apple wants the same token reused for 20-60 minutes. */
  private async token(): Promise<string> {
    const now = this.now();
    if (this.jwt && now - this.jwt.at < 40 * 60_000) return this.jwt.token;
    const head = b64url(JSON.stringify({ alg: "ES256", kid: this.cfg.keyId }));
    const claims = b64url(JSON.stringify({ iss: this.cfg.teamId, iat: Math.floor(now / 1000) }));
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await this.importKey(), enc.encode(`${head}.${claims}`));
    this.jwt = { token: `${head}.${claims}.${b64url(sig)}`, at: now };
    return this.jwt.token;
  }

  async send(devices: Device[], m: PushMessage): Promise<string[]> {
    if (!devices.length) return [];
    const auth = `bearer ${await this.token()}`;
    const payload = JSON.stringify({ aps: { alert: { title: m.title, body: m.body }, sound: "default", ...(m.badge != null ? { badge: m.badge } : {}) }, ...(m.link ? { link: m.link } : {}) });
    const gone: string[] = [];
    await Promise.all(
      devices.map(async (d) => {
        const host = d.environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
        try {
          const res = await this.fetchFn(`https://${host}/3/device/${d.id}`, {
            method: "POST",
            headers: { authorization: auth, "apns-topic": this.cfg.topic, "apns-push-type": "alert", "apns-priority": "10", "content-type": "application/json" },
            body: payload,
          });
          if (res.status === 410) gone.push(d.id);
          else if (res.status === 400) {
            const reason = ((await res.json().catch(() => ({}))) as { reason?: string }).reason;
            if (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic") gone.push(d.id);
          }
        } catch {
          /* a push that doesn't arrive is not worth failing the request; the in-app notification is still there */
        }
      }),
    );
    return gone;
  }
}

export class LogPushSender implements PushSender {
  readonly name = "log";
  sent: { tokens: string[]; message: PushMessage }[] = [];

  async send(devices: Device[], m: PushMessage): Promise<string[]> {
    if (devices.length) this.sent.push({ tokens: devices.map((d) => d.id), message: m });
    if (this.sent.length > 100) this.sent.shift();
    return [];
  }
}
