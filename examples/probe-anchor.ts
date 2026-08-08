// Probe a live anchor and print the facts an attestation would carry.
//
//   pnpm probe:anchor testanchor.stellar.org
//
// This is the honest input to `corridor-attester`: it goes and asks the anchor,
// then reports exactly what came back. Nothing is inferred from the toml alone —
// "the toml lists a SEP-31 endpoint" and "a SEP-31 call actually worked" are
// recorded as separate facts (`seps` vs `probes_passed`), because collapsing
// them is how a registry starts asserting things nobody checked.
//
// Phase 3 turns this into a scheduled job that submits on-chain. For now it
// prints the values you hand to `stellar contract invoke`.

import { createHash } from "node:crypto";
import { Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

/** Bit order must match SEP_NUMBERS in contracts/registry/src/lib.rs. */
const SEP_NUMBERS = [1, 6, 10, 12, 24, 31, 38] as const;
/** Bit order must match PROBE_NAMES in contracts/registry/src/lib.rs. */
const PROBE_NAMES = [
  "toml_fetch",
  "sep10_auth",
  "sep38_quote",
  "sep12_status",
  "sep31_info",
] as const;

const bit = (i: number) => 1 << i;
const TIMEOUT_MS = 15_000;

async function get(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** Minimal stellar.toml reader — just the keys that matter for conformance. */
function tomlValue(toml: string, key: string): string | undefined {
  const m = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"));
  return m?.[1];
}

async function main(): Promise<void> {
  const domain = process.argv[2];
  if (!domain) {
    console.error("usage: pnpm probe:anchor <home-domain>");
    process.exit(2);
  }

  let seps = 0;
  let probesRun = 0;
  let probesPassed = 0;
  let tomlHash = "0".repeat(64);
  const note = (name: string, ok: boolean, detail = "") =>
    console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(13)} ${detail}`);

  console.log(`probing ${domain}\n`);

  // --- SEP-1: the toml itself -------------------------------------------
  probesRun |= bit(0);
  let toml = "";
  try {
    const res = await get(`https://${domain}/.well-known/stellar.toml`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toml = await res.text();
    tomlHash = createHash("sha256").update(toml).digest("hex");
    probesPassed |= bit(0);
    seps |= bit(0); // SEP-1 is served by definition if the toml is there
    note("toml_fetch", true, `sha256 ${tomlHash.slice(0, 16)}…`);
  } catch (e) {
    note("toml_fetch", false, String(e instanceof Error ? e.message : e));
    console.log("\nno toml, nothing further to probe.");
    return report(domain, seps, tomlHash, probesRun, probesPassed);
  }

  // What the toml ADVERTISES. Claims, not verified behaviour.
  const webAuth = tomlValue(toml, "WEB_AUTH_ENDPOINT");
  const kyc = tomlValue(toml, "KYC_SERVER");
  const sep6 = tomlValue(toml, "TRANSFER_SERVER");
  const sep24 = tomlValue(toml, "TRANSFER_SERVER_SEP0024");
  const sep31 = tomlValue(toml, "DIRECT_PAYMENT_SERVER");
  const sep38 = tomlValue(toml, "ANCHOR_QUOTE_SERVER");
  if (sep6) seps |= bit(1);
  if (webAuth) seps |= bit(2);
  if (kyc) seps |= bit(3);
  if (sep24) seps |= bit(4);
  if (sep31) seps |= bit(5);
  if (sep38) seps |= bit(6);
  console.log(
    `  advertised:   ${
      SEP_NUMBERS.filter((_, i) => seps & bit(i))
        .map((n) => `SEP-${n}`)
        .join(", ") || "none"
    }`,
  );

  // --- SEP-10: a full challenge/response, not just a reachable endpoint ---
  let token: string | undefined;
  if (webAuth) {
    probesRun |= bit(1);
    try {
      const kp = Keypair.random();
      const ch = (await (
        await get(`${webAuth}?account=${kp.publicKey()}&home_domain=${domain}`)
      ).json()) as { transaction?: string; network_passphrase?: string };
      if (!ch.transaction || !ch.network_passphrase) throw new Error("no challenge");
      const tx = TransactionBuilder.fromXDR(
        ch.transaction,
        ch.network_passphrase,
      ) as Transaction;
      tx.sign(kp);
      const out = (await (
        await get(webAuth, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transaction: tx.toXDR() }),
        })
      ).json()) as { token?: string };
      if (!out.token) throw new Error("no token returned");
      token = out.token;
      probesPassed |= bit(1);
      note("sep10_auth", true, "challenge signed, JWT issued");
    } catch (e) {
      note("sep10_auth", false, String(e instanceof Error ? e.message : e));
    }
  }

  // --- SEP-38: a firm quote with a future expiry -------------------------
  if (sep38) {
    probesRun |= bit(2);
    try {
      const info = (await (await get(`${sep38}/info`)).json()) as {
        assets?: { asset: string }[];
      };
      const stellarAsset = info.assets?.find((a) => a.asset.startsWith("stellar:"));
      const offchain = info.assets?.find((a) => a.asset.startsWith("iso4217:"));
      if (!stellarAsset || !offchain) throw new Error("no sellable/buyable pair advertised");
      const res = await get(`${sep38}/quote`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          context: "sep31",
          sell_asset: stellarAsset.asset,
          buy_asset: offchain.asset,
          sell_amount: "10",
        }),
      });
      if (!res.ok) throw new Error(`quote HTTP ${res.status}`);
      const q = (await res.json()) as { expires_at?: string };
      if (!q.expires_at || Date.parse(q.expires_at) <= Date.now()) {
        throw new Error("quote already expired");
      }
      probesPassed |= bit(2);
      note("sep38_quote", true, `firm quote expires ${q.expires_at}`);
    } catch (e) {
      note("sep38_quote", false, String(e instanceof Error ? e.message : e));
    }
  }

  // --- SEP-12: is customer status readable at all? -----------------------
  if (kyc && token) {
    probesRun |= bit(3);
    try {
      const res = await get(`${kyc}/customer?type=sep31-receiver`, {
        headers: { authorization: `Bearer ${token}` },
      });
      // 200 or a structured 404 both prove the endpoint speaks SEP-12; a 5xx
      // or a connection failure does not.
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      probesPassed |= bit(3);
      note("sep12_status", true, `HTTP ${res.status}`);
    } catch (e) {
      note("sep12_status", false, String(e instanceof Error ? e.message : e));
    }
  }

  // --- SEP-31: does it actually list anything receivable? ----------------
  if (sep31) {
    probesRun |= bit(4);
    try {
      const res = await get(`${sep31}/info`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { receive?: Record<string, unknown> };
      const assets = Object.keys(j.receive ?? {});
      if (assets.length === 0) {
        // Reachable but receives nothing. That is a real and important
        // distinction for an off-ramp registry: the endpoint exists, the lane
        // does not.
        throw new Error("receive list is EMPTY — advertises SEP-31 but accepts nothing");
      }
      probesPassed |= bit(4);
      note("sep31_info", true, `receives ${assets.join(", ")}`);
    } catch (e) {
      note("sep31_info", false, String(e instanceof Error ? e.message : e));
    }
  }

  report(domain, seps, tomlHash, probesRun, probesPassed);
}

function report(
  domain: string,
  seps: number,
  tomlHash: string,
  probesRun: number,
  probesPassed: number,
): void {
  console.log(`\n--- attestation for ${domain} ---`);
  console.log(
    `  seps           ${seps}   (${decode(
      seps,
      SEP_NUMBERS.map((n) => `SEP-${n}`),
    )})`,
  );
  console.log(`  probes_run     ${probesRun}   (${decode(probesRun, PROBE_NAMES)})`);
  console.log(`  probes_passed  ${probesPassed}   (${decode(probesPassed, PROBE_NAMES)})`);
  console.log(`  toml_hash      ${tomlHash}`);
  console.log(`\nstellar contract invoke --id $ATTESTER --source $KEY --network testnet -- attest \\
  --attester $ADDRESS --domain ${domain} --seps ${seps} \\
  --toml_hash ${tomlHash} --probes_run ${probesRun} --probes_passed ${probesPassed}`);
}

function decode(mask: number, names: readonly string[]): string {
  const on = names.filter((_, i) => mask & bit(i));
  return on.length ? on.join(", ") : "none";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
