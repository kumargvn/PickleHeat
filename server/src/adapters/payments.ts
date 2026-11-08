// Payment adapters.
//
// StripeConnectProvider: Stripe Connect "destination charges". Each organizer links their own
// Express account; a player's entry fee is charged by PickleHeat and transferred to the organizer,
// minus PickleHeat's application fee. Uses Stripe's REST API directly (no SDK) so it runs anywhere.
//
// MockPaymentProvider: same behaviour without real money, for demo mode and tests.

import type { CheckoutRequest, PaymentEvent, PaymentProvider, PayoutAccount, User } from "../ports";
import { hmacHex, safeEqual } from "./crypto";

const STRIPE_API = "https://api.stripe.com/v1";

/** Encodes nested objects the way Stripe's form API expects: a[b][c]=v. */
export function stripeForm(obj: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object" && item !== null) parts.push(stripeForm(item as Record<string, unknown>, `${key}[${i}]`));
        else parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") {
      parts.push(stripeForm(v as Record<string, unknown>, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

export class StripeConnectProvider implements PaymentProvider {
  readonly name = "stripe";

  constructor(private secretKey: string, private webhookSecret: string, private fetchFn: typeof fetch = fetch) {}

  private async call(method: "GET" | "POST", path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<any> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.secretKey}` };
    if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const res = await this.fetchFn(STRIPE_API + path, { method, headers, body: method === "POST" && params ? stripeForm(params) : undefined });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(`Stripe ${path}: ${body?.error?.message ?? res.status}`);
    return body;
  }

  async createAccount(user: User): Promise<string> {
    const a = await this.call("POST", "/accounts", {
      type: "express",
      email: user.email ?? undefined,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_type: "individual",
      metadata: { pickleheat_user_id: user.id },
    }, `acct-${user.id}`);
    return a.id as string;
  }

  async onboardingLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<string> {
    const l = await this.call("POST", "/account_links", { account: accountId, return_url: returnUrl, refresh_url: refreshUrl, type: "account_onboarding" });
    return l.url as string;
  }

  async accountStatus(accountId: string) {
    const a = await this.call("GET", `/accounts/${encodeURIComponent(accountId)}`);
    return { chargesEnabled: !!a.charges_enabled, payoutsEnabled: !!a.payouts_enabled, detailsSubmitted: !!a.details_submitted };
  }

  async dashboardLink(accountId: string): Promise<string> {
    const l = await this.call("POST", `/accounts/${encodeURIComponent(accountId)}/login_links`);
    return l.url as string;
  }

  async createCheckout(req: CheckoutRequest): Promise<{ id: string; url: string }> {
    const s = await this.call("POST", "/checkout/sessions", {
      mode: "payment",
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      customer_email: req.customerEmail ?? undefined,
      line_items: [{ quantity: 1, price_data: { currency: req.currency, unit_amount: req.amountCents, product_data: { name: req.description } } }],
      payment_intent_data: {
        application_fee_amount: req.applicationFeeCents,
        transfer_data: { destination: req.destinationAccountId },
        metadata: req.metadata,
      },
      metadata: req.metadata,
    }, `checkout-${req.metadata.entry_id ?? ""}-${req.metadata.payment_id ?? ""}`);
    return { id: s.id as string, url: s.url as string };
  }

  async refund(checkoutSessionId: string): Promise<void> {
    const s = await this.call("GET", `/checkout/sessions/${encodeURIComponent(checkoutSessionId)}`);
    if (!s.payment_intent) throw new Error("Nothing to refund: payment not completed");
    // Refund the player in full and pull the money back from the organizer, including PickleHeat's fee.
    await this.call("POST", "/refunds", { payment_intent: s.payment_intent, reverse_transfer: true, refund_application_fee: true }, `refund-${checkoutSessionId}`);
  }

  async parseWebhook(rawBody: string, signatureHeader: string | null): Promise<PaymentEvent | null> {
    if (!signatureHeader) throw new Error("Missing Stripe-Signature");
    const parts = Object.fromEntries(signatureHeader.split(",").map((kv) => kv.split("=") as [string, string]));
    const t = parts.t;
    const v1 = signatureHeader.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
    if (!t || v1.length === 0) throw new Error("Malformed Stripe-Signature");
    if (Math.abs(Date.now() / 1000 - Number(t)) > 300) throw new Error("Stale Stripe webhook");
    const expected = await hmacHex(this.webhookSecret, `${t}.${rawBody}`);
    if (!v1.some((s) => safeEqual(s, expected))) throw new Error("Bad Stripe signature");
    const ev = JSON.parse(rawBody) as { type: string; data: { object: any } };
    const o = ev.data.object;
    switch (ev.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        return o.payment_status === "paid" ? { type: "checkout_paid", providerRef: o.id } : null;
      case "checkout.session.expired":
      case "checkout.session.async_payment_failed":
        return { type: "checkout_failed", providerRef: o.id };
      case "account.updated":
        return { type: "account_updated", providerAccountId: o.id, chargesEnabled: !!o.charges_enabled, payoutsEnabled: !!o.payouts_enabled, detailsSubmitted: !!o.details_submitted };
      default:
        return null;
    }
  }
}

/** No real money. Checkout "URLs" point at the API's own mock pay page, which marks the payment paid. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  accounts = new Map<string, Pick<PayoutAccount, "chargesEnabled" | "payoutsEnabled" | "detailsSubmitted">>();
  sessions = new Map<string, CheckoutRequest>();
  refunded: string[] = [];
  private n = 0;

  constructor(private publicBaseUrl: string) {}

  async createAccount(user: User): Promise<string> {
    const id = `acct_mock_${user.id}`;
    this.accounts.set(id, { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
    return id;
  }
  async onboardingLink(_accountId: string, returnUrl: string): Promise<string> {
    return returnUrl;
  }
  async accountStatus(accountId: string) {
    return this.accounts.get(accountId) ?? { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true };
  }
  async dashboardLink(): Promise<string> {
    return `${this.publicBaseUrl}/v1/health`;
  }
  async createCheckout(req: CheckoutRequest): Promise<{ id: string; url: string }> {
    const id = `cs_mock_${++this.n}_${req.metadata.entry_id ?? ""}`;
    this.sessions.set(id, req);
    return { id, url: `${this.publicBaseUrl}/v1/payments/mock-pay?session=${encodeURIComponent(id)}` };
  }
  async refund(ref: string): Promise<void> {
    this.refunded.push(ref);
  }
  async parseWebhook(rawBody: string): Promise<PaymentEvent | null> {
    return JSON.parse(rawBody) as PaymentEvent;
  }
}
