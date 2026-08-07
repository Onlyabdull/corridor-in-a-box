# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches
1.0. While pre-1.0, minor versions may contain breaking changes.

## [Unreleased]

### Fixed — correctness & security

Findings from an audit of this repo. Each was confirmed by execution against the
code as shipped, and each is now covered by a regression test in
`tests/security.test.ts`.

- **Negative amounts settled.** `isValidAmount` is a _signed_ syntax check
  (`subAmounts` needs negatives) and was the only guard at both the HTTP boundary
  and the engine entry point, so `POST /payments` with `"-100.00"` returned
  `200 completed` and handed the negative amount to the settlement submitter.
  Added `isSettleableAmount` (well-formed **and** strictly positive) and used it
  at both boundaries, plus an optional per-corridor `limits.max_amount` ceiling.
- **KYC was checked against the wrong account.** The SEP-12 status query was
  keyed to the operator's own SEP-10 signing account whenever a signer was
  configured — which is every production wiring — so `comply` answered "is the
  operator in good standing?" and recorded the result as the _recipient's_
  verdict. It now queries the recipient's SEP-12 customer id
  (`PartyRef.sep12Id`) and fails closed when there isn't one. Relatedly,
  `openTransaction` now sends `receiver_id`/`sender_id`, which it previously
  omitted entirely.
- **SEP-10 authentication failed open.** `authToken()` returned `undefined` on
  every failure path and callers proceeded _anonymously_, so an anchor that
  errored on `/auth` still had its SEP-12 answer accepted as an authenticated
  compliance verdict. Auth failure is now a hard, retryable error whenever a
  signer is configured.
- **`GET /payments/:key` leaked across tenants.** Any valid API key could read
  any run — including its `stellarTxHash` — by guessing a caller-chosen
  idempotency key. Runs now carry an `owner` set from the validated credential,
  reads are scoped to it, and only the error _code_ is returned rather than the
  stored message (which carries anchor URLs and upstream response bodies).
- **Failed authentication was not rate-limited.** The `401` returned before the
  limiter, so API keys could be brute-forced at line rate. Rate limiting now runs
  first.
- **The rate limiter was bypassable.** It keyed off the _unvalidated_ bearer
  token, so rotating the token minted a fresh bucket per request. It now keys off
  a recognised key, falling back to the client IP.
- **The SEP-38 `sell_amount` was discarded.** The anchor's own sell amount was
  parsed and thrown away, so the settle leg paid the amount originally requested
  rather than the one the firm quote bound to. Quotes are also now rejected when
  `buy_amount` contradicts `price × sell_amount` beyond a rounding tolerance.
- **The web API route lent out its credentials.** It proxied any anonymous
  caller's body to the internal `@corridor/service` _with the server's API key_
  attached. Proxying now requires `CORRIDOR_WEB_API_KEY` and fails closed if the
  proxy is configured without one. Added a request body-size cap; the demo's
  in-memory run store is now bounded.
- **Security headers.** The web app now sends CSP, `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`.
- **Stuck spinner.** A failed `fetch` in the payment runner threw with `running`
  still true, disabling the button until a page reload. Also fixed the failed-step
  highlight, which was computed from a hardcoded state and never rendered.

### Changed — honesty of reported status

- **Liveness now has three states, not two.** `runnable`/`not runnable` was
  derived purely from whether an endpoint string was non-empty, so a manifest
  naming a fictional anchor was reported as healthy by both `corridor plan` and
  the dashboard. Corridors are now `VERIFIED` (endpoints confirmed against a
  published `stellar.toml` on a recorded date, via the new
  `dest.endpoints.endpoints_verified_at`), `UNVERIFIED` (present but unchecked —
  **the honest default**, and where every corridor in this repo currently sits),
  or `NOT RUNNABLE`.
- **`mx-bitso.corridor.yaml` renamed to `mx-example.corridor.yaml`** and stripped
  of the company name. Its endpoints are and always were fictional; naming a real
  company on it implied a relationship that does not exist.
- **Two ROADMAP items reverted from ✅ to ⬜** because they did not survive a code
  read: Corridor #1 (a template with placeholder endpoints, not a live lane) and
  "Real refund path (reverse settlement)" (`refund()` unconditionally fails —
  what ships is escalation to a manual `held`, not a reversal). The grant
  proposal's corresponding claims were corrected the same way.

### Added

- GitHub issue and PR templates.
- Separate CI job that typechecks and builds the `web/` showcase app.
- `author`/`maintainers`/`repository` metadata in `package.json` (so the
  `SECURITY.md` reporting pointer resolves).
- `CHANGELOG.md` and `.env.example`.
- Request body-size limit in `@corridor/service` (memory-DoS guard).
- Explicit SEP-31 lifecycle status mapping (`mapSep31Status`) plus contract-shape
  tests for the adapter.
- Env-gated integration test against a real SEP-31 server (`tests/integration/`).
- `docs/operations.md` (runbook) and `docs/sep-coverage.md` (SEP-31 vs SEP-6/24).
- `IdempotencyStore.create()` — an atomic claim (conditional `INSERT … ON
CONFLICT DO NOTHING` in Postgres) implemented by both stores, plus regression
  tests for the concurrent-claim path.
- `PrometheusMetrics` — a zero-dependency `Metrics` sink that renders Prometheus
  text exposition, plus a `metricsText` option on `@corridor/service` that serves
  it at `GET /metrics` (public + unmetered). Runbook gains a Metrics & alerting
  section with `held`/`failed` alert rules.
- Pluggable rate limiting: a `RateLimiter` interface and `rateLimiter` service
  option so a shared (e.g. Redis) limiter can replace the per-process
  `TokenBucket` for multi-replica deployments.
- `gracefulShutdown(server)` helper to drain in-flight requests on SIGTERM/SIGINT.
- One-command testnet runner (`pnpm testnet` → `examples/run-testnet.ts`) wiring
  the real adapter + submitter + Postgres store to capture a live run; refuses
  mainnet without `CORRIDOR_ALLOW_MAINNET=1`.
- Live-Postgres integration test for `PostgresIdempotencyStore` (concurrent
  `create()`, version-guarded `put()`), gated on `CORRIDOR_TEST_DATABASE_URL`,
  with a Postgres service-container CI job.
- The `web/` API route now proxies to a real `@corridor/service` when
  `CORRIDOR_SERVICE_URL` is set; the in-repo simulation is fenced as demo-only.
- README status badges (CI, license, Node).
- One-command service runner (`pnpm serve` → `examples/run-service.ts`) wiring
  the real adapter/submitter/store behind `createService().server().listen()`
  — previously the service was importable but nothing ever started it. Serves
  every corridor manifest in `corridors/`, skipping `network: public` lanes
  unless `CORRIDOR_ALLOW_MAINNET=1`.
- An on-page "build-time snapshot, not a live liveness feed" label on the web
  dashboard's Corridors section — the underlying data was already disclosed in
  a code comment, now it's visible on the page itself.
- Dedicated unit tests for `@corridor/cli`, `@corridor/router`, and
  `@corridor/adapter-kit` — previously exercised only incidentally through
  other packages' tests; `conformanceSuite` had no coverage that actually ran
  in CI.
- `.github/CODEOWNERS`, `.github/dependabot.yml` (npm + github-actions,
  weekly), and a `feature_request.yml` issue template.
- `"engines": {"node": ">=22"}` in every package.json (root, `web/`, and all
  workspace packages), matching `.nvmrc` and the README's Node badge.
- SHA-pinned the GitHub Actions used in CI (previously floating `@v4` tags),
  plus new `codeql.yml` and `dependency-review.yml` workflows.
- `nightly-live-anchor.yml`: re-runs the opt-in live-anchor integration test
  on a schedule; inert until anchor secrets are configured.
- `docs/grant-proposal.md`: SCF Tier-2 draft with milestones mapped to
  ROADMAP.md/MAINTAINER.md; budget figures left as explicit placeholders.
- `@corridor/cli` is now npm-publish-ready: a `tsup` build step bundles it to
  a single `dist/index.js` (inlining `@corridor/manifest`/`@corridor/types`;
  `zod`/`yaml` stay real external dependencies), plus `bin`/`files`/
  `exports`/`description`/`license`/`repository`/`publishConfig`. Verified
  by installing the actual packed tarball into a scratch project and running
  the resulting `corridor` bin. The other 8 packages are unpublished still.
- `release.yml`: tag-triggered (`cli-vX.Y.Z`) npm publish workflow for
  `@corridor/cli` — full test suite, bundle build, a smoke run of the built
  bin, a tag↔package-version check, then `npm publish --provenance`. Needs
  one repo secret (`NPM_TOKEN`).
- The live-anchor suite (and the nightly workflow) now honours
  `ANCHOR_ASSET_ISSUER` / `ANCHOR_DEST_ASSET`, and `.env.example` + README
  document verified known-good values for the public SDF test anchor
  (`testanchor.stellar.org`) — the read-only probe runs against a real anchor
  with no self-hosted infrastructure.

- README links the live web dashboard (corridor-in-a-box.vercel.app), which
  the Vercel GitHub integration deploys from `main`.

### Fixed

- **The SEP-38 quote request was spec-invalid and every live anchor rejected
  it.** The adapter sent `sell_asset: stellar:USDC` (no issuer — the anchor
  answers 404 `sell_asset not found`) and omitted the required `context`
  field (400 `Unsupported context`). Found by running the opt-in live suite
  against the SDF test anchor; mocks never caught it. `requestQuote` now
  sends `context: "sep31"` and the SEP-38 Asset Identification Format
  (`stellar:CODE:ISSUER`, or `stellar:native` when the bridge asset is XLM),
  with regression tests pinning the exact body. First live-verified firm
  quote followed immediately.

- `.env.example` documented `CORRIDOR_HORIZON_URL`, which nothing in the
  codebase reads — the real scripts read `HORIZON_URL`. Renamed, and added
  the previously-undocumented `MANIFEST`, `CORRIDOR_ALLOW_MAINNET`, and
  `CORRIDORS_DIR` variables.
- **Concurrent double-settlement window in the idempotency gate.** `execute()`
  previously gated on `get()` alone, so two callers racing the same
  `idempotencyKey` could both pass the check and both settle on-chain (the
  `put()` version guard only prevents the stored row from going backwards, not
  two in-flight runs). `execute()` now atomically claims the key via
  `store.create()` before any work and returns `IDEMPOTENCY_CONFLICT` to the
  loser. Addresses the double-settlement scope item in `SECURITY.md`.
- **Unbounded memory in the rate limiter.** The `TokenBucket` map never evicted
  client entries (and the key can be a spoofable `X-Forwarded-For`), an
  exhaustion vector. It now evicts fully-refilled idle buckets (behaviour-neutral)
  and keys off a transport-resolved client IP rather than a raw header — see
  `trustProxy`.
- A thrown error inside the HTTP request handler (e.g. an unreachable idempotency
  DB) now returns `500` instead of hanging the socket / risking a process crash.

## [0.1.0] — 2026-06-18

Initial public release: the walking skeleton.

### Added

- `@corridor/types` — `Outcome<T>` no-throw result type and decimal-safe `Money`.
- `@corridor/manifest` — Zod schema + loader for a `*.corridor.yaml`; the corridor
  abstraction.
- `@corridor/adapter-kit` — `AnchorAdapter` port, conformance probes, mock adapter.
- `@corridor/sep31` — one adapter for any standards-compliant SEP-31 anchor
  (SEP-10 auth + SEP-12 KYC; crypto behind an injected signer).
- `@corridor/stellar` — settlement submitter + SEP-10 signer; `ExternalSigner`
  (KMS/HSM) port.
- `@corridor/router` — `RouteResolver` seam + static default.
- `@corridor/engine` — corridor-agnostic orchestration of quote → comply → settle
  → reconcile → recover, with a persisted state machine, crash-resume, recovery,
  audit trail, metrics hooks, and a durable Postgres idempotency store.
- `@corridor/service` — thin HTTP API over the engine (API-key auth, rate limit).
- `@corridor/cli` — manifest validation and an offline runnability `plan`.
- Reference, MX/Bitso, and NG→CN corridor manifests.
- Docs: key management, "why not Anchor Platform".

[Unreleased]: https://github.com/ezedike-evan/corridor-in-a-box/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ezedike-evan/corridor-in-a-box/releases/tag/v0.1.0
