# Roadmap

This project is a **walking skeleton**: the orchestration is real and tested
against mocks, but the money-moving paths and durability are being filled in.
The list below is roughly the order in which the skeleton becomes a beta-grade
system. Items marked ✅ are done.

## Phase 1 — Move real money on testnet

- ✅ SEP-10 challenge/response auth in the SEP-31 adapter (`authToken()`).
- ✅ SEP-12 KYC handoff against `kyc_server`.
- ✅ A real `SettlementSubmitter` on `@stellar/stellar-sdk` (build → sign →
  submit a native payment, watch Horizon).
- ✅ The settle leg executed against **live Stellar testnet** — build → sign →
  submit → confirm on Horizon, reproducible via `pnpm verify:settle`. Captured
  tx: [`855933c7…08dfd245`](https://stellar.expert/explorer/testnet/tx/855933c73b85b9071318ff0bfd9213096a1edfaef68417dea1c2e8fb08dfd245)
  (ledger 4024693, 2026-08-07). This is the settle leg **only** — no anchor is
  involved, so it is not yet a corridor run.
- ⬜ A demonstrated end-to-end run against the Anchor Platform SEP-31 reference
  server (corridor #0) — quote → comply → open → settle → reconcile with a real
  counterparty — captured in the README. This is the remaining Phase-1 item.

## Phase 2 — Durability & correctness

- ✅ Decimal-safe `Money` arithmetic (no float, explicit rounding).
- ✅ Durable idempotency store (Postgres) + crash-resume of in-flight runs.
- ✅ `reconcile` polls until settled/timeout; `recovery.timeout_seconds`
  enforced; retry backoff.
- ⬜ Real refund path (reverse settlement). **Not implemented.**
  `StellarSettlementSubmitter.refund()` unconditionally returns a non-retryable
  failure — an already-credited payment cannot be reversed unilaterally on
  chain, which is correct behaviour, but it means the engine's only real
  recovery is escalation to `held` for manual intervention. A genuine refund
  path means driving the receiving anchor's SEP-31 refund flow. What ships
  today is the escalation, not the reversal.

## Phase 3 — Operability (required before close beta)

- ✅ Structured logging + append-only audit trail of every state transition.
- ✅ Metrics / tracing hooks (injectable `Metrics`; per-verb timings + counters).
- ✅ Signing-key management: an `ExternalSigner` port (KMS/HSM-ready) and
  [docs/key-management.md](./docs/key-management.md).
- ✅ A thin service/API layer (`@corridor/service`: HTTP over the engine, with
  API-key auth and rate limiting).
- ✅ A runnable launcher for `@corridor/service` (`pnpm serve` →
  `examples/run-service.ts`), serving every corridor manifest with the same
  mainnet safety guard as `pnpm testnet`.
- ✅ Nightly CI job re-running the live-anchor probe
  (`tests/integration/sep31-live.test.ts`), inert until anchor secrets are
  configured.

## Phase 4 — Corridors

- ⬜ Corridor #1 manifest for a live SEP-31 receive-side anchor.
  `mx-example.corridor.yaml` exists but is a **template with fictional
  endpoints** — it demonstrates the manifest shape, it does not describe a lane
  that exists. This item closes when a real anchor's `stellar.toml` values are
  in the file and `endpoints_verified_at` is set.
- ⬜ Additional real corridors as off-ramps come online.
- ⬜ `ng-cn` becomes runnable the day a compliant RMB SEP-31 off-ramp exists.

## Phase 5 — Grant-maturity / protocol depth (after wave entry)

- ⬜ Demonstrate all four SEP flows (SEP-10, SEP-12, SEP-31, SEP-38) against a
  live anchor, with tests.
- ⬜ SCF Tier-2 grant proposal — structure and milestones drafted in
  [docs/grant-proposal.md](./docs/grant-proposal.md); budget figures and
  submission still pending maintainer input.
- ⬜ Corridor #1 live: fill `mx-example.corridor.yaml` endpoints from the real
  `stellar.toml` (blocked — needs a verified live anchor domain, not a code
  change).

See [CONTRIBUTING.md](./CONTRIBUTING.md) for good first issues.
