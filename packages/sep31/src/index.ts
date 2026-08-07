// @corridor/sep31 — ONE adapter that works for any standards-compliant SEP-31
// receiving anchor (Anclap, Bitso, the Anchor Platform testnet reference server, ...).
//
// This is the whole point of the standard: you don't write a new adapter per anchor.
// Bespoke exchanges/OTC desks that don't speak SEP-31 implement AnchorAdapter
// directly instead — those would live in the private repo, not here.
//
// The HTTP shapes below follow SEP-31 (GET /info, POST /transactions,
// GET /transactions/:id), SEP-38 (POST /quote), SEP-10 (GET/POST web_auth) and
// SEP-12 (GET /customer). The crypto for SEP-10 — parsing and signing the
// challenge transaction XDR — lives behind an injected Sep10Signer so this
// adapter never has to depend on a Stellar SDK. The on-chain settle leg is NOT
// here; that's the engine's job.

import type { AnchorConfig, Corridor } from "@corridor/manifest";
import {
  applyPrice,
  compareAmounts,
  fail,
  isValidAmount,
  ok,
  subAmounts,
  type Outcome,
  type PaymentIntent,
} from "@corridor/types";
import type {
  AnchorAdapter,
  KycResult,
  OpenTransaction,
  Quote,
  TransactionStatus,
} from "@corridor/adapter-kit";

type FetchLike = typeof fetch;

/**
 * How far `buy_amount` may drift from `price × sell_amount` before we treat a
 * firm quote as internally inconsistent. Anchors round to their payout asset's
 * precision (2dp for most fiat) while price is quoted to 7, so exact equality is
 * the wrong test — 0.1% absorbs legitimate rounding without hiding a quote that
 * simply does not add up.
 */
const QUOTE_TOLERANCE = "0.001";

/**
 * Signs a SEP-10 challenge. The concrete implementation (Keypair + Transaction
 * from @stellar/stellar-sdk) is supplied by the caller, keeping this package
 * free of a chain SDK. See @corridor/stellar for a ready-made signer.
 */
export interface Sep10Signer {
  /** The Stellar account (G…) being authenticated. */
  readonly account: string;
  /** Sign the base64 challenge XDR and return the signed XDR. */
  signChallenge(challengeXdr: string, networkPassphrase: string): Promise<string>;
}

export interface Sep31AdapterOptions {
  /** Inject a fetch implementation (defaults to global fetch). Handy for tests. */
  fetchImpl?: FetchLike;
  /** SEP-10 signer. Without it the adapter calls anchors anonymously. */
  sep10?: Sep10Signer;
}

/**
 * Classify a SEP-31 transaction status into the engine's reconcile model.
 *
 * SEP-31 defines a lifecycle of `pending_*` / `incomplete` (in flight) plus the
 * terminals `completed` (success), `refunded`, `expired`, and `error`. The engine
 * only needs three buckets:
 *   - settled         → `completed`
 *   - terminalFailure → `refunded` | `expired` | `error`  (stop polling, recover)
 *   - otherwise        → still in flight, keep polling
 * Unknown statuses are treated as in-flight (fail-open to polling, never to a
 * false "settled"). Exported so it can grow as real anchors surface new statuses.
 */
export function mapSep31Status(raw: string): {
  status: string;
  settled: boolean;
  terminalFailure: boolean;
} {
  const status = (raw ?? "").toLowerCase();
  if (status === "completed") return { status, settled: true, terminalFailure: false };
  if (status === "refunded" || status === "expired" || status === "error") {
    return { status, settled: false, terminalFailure: true };
  }
  return { status, settled: false, terminalFailure: false };
}

/**
 * SEP-38 Asset Identification Format for the corridor's bridge asset:
 * `stellar:native` for XLM, `stellar:CODE:ISSUER` for everything else. Anchors
 * reject issuer-less Stellar asset ids ("sell_asset not found").
 */
function sep38SellAsset(corridor: Corridor): string {
  const code = corridor.settlement.bridge_asset;
  return code.toUpperCase() === "XLM"
    ? "stellar:native"
    : `stellar:${code}:${corridor.settlement.asset_issuer}`;
}

/** Decode a JWT's `exp` claim (epoch ms) without verifying it. */
function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export class Sep31Adapter implements AnchorAdapter {
  readonly name: string;
  private readonly anchor: AnchorConfig;
  private readonly fetchImpl: FetchLike;
  private readonly sep10?: Sep10Signer;
  private cachedToken?: { token: string; expMs: number };

  constructor(corridor: Corridor, opts: Sep31AdapterOptions = {}) {
    this.anchor = corridor.dest;
    this.name = corridor.dest.name;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sep10 = opts.sep10;
  }

  // SEP-10 challenge/response: GET a challenge transaction, sign it, POST it back
  // for a JWT. Cached until ~30s before expiry.
  //
  // FAILS CLOSED. This previously returned `undefined` on every failure path and
  // callers carried on unauthenticated — so an anchor that 500'd on /auth got
  // its SEP-12 status read anonymously, and whatever it said back was treated as
  // an authenticated compliance answer. Now: if a signer is configured, a failed
  // handshake is a hard, retryable error. `ok(undefined)` means one thing only —
  // no auth was configured for this anchor, so anonymous access is intended.
  private async authToken(): Promise<Outcome<string | undefined>> {
    const webAuth = this.anchor.endpoints.web_auth;
    if (!webAuth || !this.sep10) return ok(undefined);

    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expMs - 30_000 > now) {
      return ok(this.cachedToken.token);
    }

    const authFailed = (why: string) =>
      fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-10 auth failed (${why})`, {
        retryable: true,
      });

    try {
      const url = new URL(webAuth);
      url.searchParams.set("account", this.sep10.account);
      url.searchParams.set("home_domain", this.anchor.endpoints.home_domain);
      const challengeRes = await this.fetchImpl(url.toString());
      if (!challengeRes.ok) return authFailed(`challenge HTTP ${challengeRes.status}`);
      const challenge = (await challengeRes.json()) as {
        transaction?: string;
        network_passphrase?: string;
      };
      if (!challenge.transaction || !challenge.network_passphrase) {
        return authFailed("challenge response missing transaction/network_passphrase");
      }

      const signed = await this.sep10.signChallenge(
        challenge.transaction,
        challenge.network_passphrase,
      );
      const tokenRes = await this.fetchImpl(webAuth, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transaction: signed }),
      });
      if (!tokenRes.ok) return authFailed(`token HTTP ${tokenRes.status}`);
      const { token } = (await tokenRes.json()) as { token?: string };
      if (!token) return authFailed("token response missing `token`");

      this.cachedToken = { token, expMs: jwtExpiryMs(token) ?? now + 15 * 60_000 };
      return ok(token);
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-10 auth request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  /** `Authorization` header for an authenticated call, or {} when the corridor
   *  configures no SEP-10. Propagates an auth failure to the caller. */
  private authHeader(token: string | undefined): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  private base(corridor: Corridor): Outcome<{ sep31: string; sep38?: string }> {
    const sep31 = this.anchor.endpoints.transfer_server_sep31;
    if (!sep31) {
      return fail(
        "ANCHOR_UNAVAILABLE",
        `${this.name}: no SEP-31 transfer server configured for corridor ${corridor.id}`,
      );
    }
    return ok({ sep31, sep38: this.anchor.endpoints.quote_server });
  }

  async requestQuote(intent: PaymentIntent, corridor: Corridor): Promise<Outcome<Quote>> {
    const b = this.base(corridor);
    if (!b.ok) return b;
    if (!b.value.sep38) {
      return fail("QUOTE_UNAVAILABLE", `${this.name}: anchor exposes no SEP-38 quote server`);
    }
    const auth = await this.authToken();
    if (!auth.ok) return auth;
    try {
      const res = await this.fetchImpl(`${b.value.sep38}/quote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.authHeader(auth.value),
        },
        body: JSON.stringify({
          // Required by SEP-38: the protocol the quote will be executed under.
          context: "sep31",
          sell_asset: sep38SellAsset(corridor),
          buy_asset: this.anchor.asset,
          sell_amount: intent.sourceAmount.amount,
        }),
      });
      if (!res.ok) {
        return fail("QUOTE_UNAVAILABLE", `${this.name}: quote HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await res.json()) as {
        id: string;
        price: string;
        expires_at: string;
        sell_amount: string;
        buy_amount: string;
      };

      // Honour the anchor's OWN sell_amount, not the amount we asked for. The
      // anchor may adjust for fees, rounding or minimums, and the firm quote
      // binds to its number — settling the requested amount instead means the
      // payout will not match and reconcile fails only after the money has left.
      const sellAmount = j.sell_amount ?? intent.sourceAmount.amount;
      if (!isValidAmount(sellAmount)) {
        return fail(
          "QUOTE_UNAVAILABLE",
          `${this.name}: quote sell_amount "${sellAmount}" is malformed`,
        );
      }

      // Cross-check the anchor's arithmetic before trusting a firm quote:
      // buy_amount should be price × sell_amount. A mismatch means either a
      // broken anchor or one quoting something other than what we asked for.
      const expectedBuy = applyPrice(sellAmount, j.price);
      if (expectedBuy.ok && isValidAmount(j.buy_amount)) {
        const drift = subAmounts(j.buy_amount, expectedBuy.value);
        const tolerance = applyPrice(expectedBuy.value, QUOTE_TOLERANCE);
        if (drift.ok && tolerance.ok) {
          const abs = drift.value.startsWith("-") ? drift.value.slice(1) : drift.value;
          const within = compareAmounts(abs, tolerance.value);
          if (within.ok && within.value > 0) {
            return fail(
              "QUOTE_UNAVAILABLE",
              `${this.name}: quote ${j.id} is internally inconsistent — ` +
                `buy_amount ${j.buy_amount} != price ${j.price} × sell_amount ${sellAmount} ` +
                `(expected ~${expectedBuy.value})`,
            );
          }
        }
      }

      return ok<Quote>({
        id: j.id,
        price: j.price,
        expiresAt: Date.parse(j.expires_at),
        sourceAmount: { asset: intent.sourceAmount.asset, amount: sellAmount },
        destAmount: { asset: this.anchor.asset, amount: j.buy_amount },
        firm: true,
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: quote request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  async ensureCompliance(
    intent: PaymentIntent,
    corridor: Corridor,
  ): Promise<Outcome<KycResult>> {
    const kyc = this.anchor.endpoints.kyc_server;
    if (!kyc) {
      // Some corridors deliver 1:1 with no per-customer KYC at the receiver.
      return ok<KycResult>({ status: "accepted" });
    }
    // SEP-12: check the receiving anchor's view of THE RECIPIENT's status. The
    // sending anchor collects/verifies PII and registers the customer with the
    // receiving anchor (SEP-12 PUT /customer), which returns the customer id we
    // carry as `recipient.sep12Id`. Here we only read status — no PII flows
    // through the engine. NEEDS_INFO / PROCESSING surface as "pending" so the
    // engine fails closed rather than settling early.
    //
    // This used to query `this.sep10?.account` — the OPERATOR's own signing
    // account — whenever a signer was configured, which is every production
    // wiring. It therefore answered "is the operator in good standing?" and
    // recorded the result as the recipient's KYC verdict: a compliance control
    // that reported a pass without ever evaluating the customer. Fail closed
    // instead when we have no id for the recipient.
    const sep12Id = intent.recipient.sep12Id;
    if (!sep12Id) {
      return fail(
        "KYC_REQUIRED",
        `${this.name}: recipient has no SEP-12 customer id — register the receiver ` +
          `with this anchor (SEP-12 PUT /customer) and set recipient.sep12Id before ` +
          `settling. Refusing to settle on an unverified recipient.`,
      );
    }
    const auth = await this.authToken();
    if (!auth.ok) return auth;
    try {
      const url = new URL(`${kyc}/customer`);
      url.searchParams.set("id", sep12Id);
      url.searchParams.set("type", `${corridor.compliance.dest_jurisdiction}:receiver`);
      const res = await this.fetchImpl(url.toString(), {
        headers: this.authHeader(auth.value),
      });
      if (!res.ok) {
        return fail("KYC_REQUIRED", `${this.name}: SEP-12 customer HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await res.json()) as { id?: string; status?: string };
      const status = (j.status ?? "").toUpperCase();
      if (status === "ACCEPTED") {
        return ok<KycResult>({ status: "accepted", customerId: j.id });
      }
      if (status === "REJECTED") {
        return ok<KycResult>({ status: "rejected", customerId: j.id });
      }
      // PROCESSING, NEEDS_INFO, or anything unknown → not yet cleared.
      return ok<KycResult>({ status: "pending", customerId: j.id });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: SEP-12 request failed`, {
        retryable: true,
        cause,
      });
    }
  }

  async openTransaction(
    intent: PaymentIntent,
    quote: Quote,
    corridor: Corridor,
  ): Promise<Outcome<OpenTransaction>> {
    const b = this.base(corridor);
    if (!b.ok) return b;
    // SEP-31 requires the receiving anchor to know WHO it is paying out to. The
    // receiver_id is the SEP-12 customer id from registration; without it a
    // conformant anchor rejects the transaction, and a lenient one would open a
    // payment with no identified beneficiary.
    if (!intent.recipient.sep12Id) {
      return fail(
        "KYC_REQUIRED",
        `${this.name}: cannot open a SEP-31 transaction without recipient.sep12Id`,
      );
    }
    const auth = await this.authToken();
    if (!auth.ok) return auth;
    try {
      const res = await this.fetchImpl(`${b.value.sep31}/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.authHeader(auth.value),
        },
        body: JSON.stringify({
          // The quote's sell amount, which requestQuote() now takes from the
          // anchor's own response rather than echoing what we asked for.
          amount: quote.sourceAmount.amount,
          asset_code: corridor.settlement.bridge_asset,
          quote_id: quote.id,
          receiver_id: intent.recipient.sep12Id,
          ...(intent.sender.sep12Id ? { sender_id: intent.sender.sep12Id } : {}),
        }),
      });
      if (!res.ok) {
        return fail("ANCHOR_UNAVAILABLE", `${this.name}: open-tx HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await res.json()) as {
        id: string;
        stellar_account_id: string;
        stellar_memo?: string;
      };
      return ok<OpenTransaction>({
        transactionId: j.id,
        depositAddress: j.stellar_account_id,
        memo: j.stellar_memo,
      });
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: open-tx failed`, {
        retryable: true,
        cause,
      });
    }
  }

  async getTransaction(transactionId: string): Promise<Outcome<TransactionStatus>> {
    const sep31 = this.anchor.endpoints.transfer_server_sep31;
    if (!sep31) return fail("ANCHOR_UNAVAILABLE", `${this.name}: no SEP-31 server`);
    try {
      const res = await this.fetchImpl(`${sep31}/transactions/${transactionId}`);
      if (!res.ok) {
        return fail("ANCHOR_UNAVAILABLE", `${this.name}: get-tx HTTP ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const j = (await res.json()) as { transaction: { status: string } };
      return ok<TransactionStatus>(mapSep31Status(j.transaction.status));
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${this.name}: get-tx failed`, {
        retryable: true,
        cause,
      });
    }
  }
}
