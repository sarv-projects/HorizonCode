# 16 — Operations: install, release, gates, diagnostics, updates

> **Status of this document:** `DESIGNED` as a specification of the operations plane. **Implementation status (final audit, 2026-11-06):** a `hzcode` binary exists (`/data/home/forge/hzcode/bin/hzcode`, chat-first, headless-capable) and so does the v0.1 kernel — as a Rust binary named `hz-kernel` at `kernel/target/release/hz-kernel`, *not* the designed `hzk` asset; levels and evidence in `28-implementation-status.md`. Install/release integrity, signing, the gate runner, `hzcode doctor`, backup/restore and the enterprise plane below remain specification targets, marked `[planned]` unless defined by `/data/home/forge/hzcode/docs/_conventions.md`. The README status note this paragraph used to cite was rewritten in the final audit (the README now leads with the implemented state).
>
> This document decides *how the thing is built, shipped, watched, diagnosed, updated and defended*. It does not restate authority semantics: those live in `/data/home/forge/hzcode/docs/14-surfaces.md` (exit codes, S16) and the authority/safety document. Where this document needs a name that `_conventions.md` does not define, it says so and requires the addition (R-ops-74).

**Owner:** operations (release engineering, CI/CD, observability, diagnostics, security response, cost accounting, docs governance).
**Plane:** cross-plane. Operations is the only authority allowed to build, sign, distribute and diagnose binaries on an operator's machine.

---

## 1. Purpose

This document decides, in one place, ten things that were previously scattered or unstated:

1. **Distribution.** Which channels exist (npm/bun, `install.sh`, Homebrew, cargo, nix, Docker), what each is allowed to install, and how the kernel asset `hzk` travels with the CLI as one signed, digest-pinned unit.
2. **Versioning.** Semver policy per artifact (CLI, kernel, TS packages, protocol revision `HZ_PROTO` / `HZ_ABI`), which artifacts are lockstep, how the changelog is produced, which channels exist (stable/beta/nightly) and what rollback means.
3. **Release integrity.** Signing, SBOM, provenance attestation, reproducibility — including what is *not* reproducible, stated honestly.
4. **CI/CD.** The closed gate catalog, what fails a build, gate lanes and timeouts, and the single narrow exception process.
5. **Observability.** OpenTelemetry traces/metrics/logs, local-first defaults, exactly what is recorded and what is redacted, opt-in telemetry rules, and the local trace file format.
6. **Diagnostics.** What `hzcode doctor` checks, the support-bundle format and its redaction contract, crash handling, and log-level conventions.
7. **Performance engineering.** One budgets registry, the benchmark harness, regression thresholds, and profile presets.
8. **Security operations.** Disclosure, dependency policy, secret scanning, and who must revise the threat model when.
9. **Update mechanism.** Self-update for CLI and kernel, signature verification before swap, atomic swap, rollback, offline/staged modes.
10. **Cost and docs operations.** Price-table discipline (`prices.json`, `pricecheck`), budgets, the opt-in cost dashboard, and the authority order inside `docs/`.

This document owns no runtime semantics. It owns the *lifecycle* of every artifact that carries them.

---

## 2. Rules

Rules are numbered `R-ops-<n>` and are individually testable. Runbooks (§2.12) are prescribed procedures, not law: if a runbook step conflicts with a rule, the rule wins and the runbook is a bug.

### 2.1 Install and distribution

| # | Rule | Test |
|---|---|---|
| **R-ops-1** | For a given version, every channel MUST install the same artifact bytes for a given `(os, arch)`. Channels are transport, not variants; no channel may preconfigure, patch or slim the binary. | `gate:install-smoke` `[planned]` compares `sha256` of the installed executable across npm, `install.sh`, Homebrew, cargo, nix and Docker for one version. |
| **R-ops-2** | The npm/bun package `@horizoncode/cli` MUST be a thin launcher that resolves the platform binary and verifies its digest before exec. It MUST NOT bundle a second copy of runtime logic and MUST NOT run a post-install script that fetches from any host other than the manifest-declared release host. | `packages/cli/test/dist/npm-launcher.test.ts` `[planned]`, `gate:install-smoke`. |
| **R-ops-3** | `ops/install.sh` `[planned]` MUST fetch the release manifest, verify the manifest signature, then verify the `sha256` of the artifact it downloads before extraction. Any mismatch MUST abort with exit `3` (unprovable/fail-closed, RC-5) and MUST leave no partial install. | `packages/testing/src/ops/install-tamper.test.ts` `[planned]`; runs in `gate:install-smoke`. |
| **R-ops-4** | The kernel asset (`hzk`, Windows `hzk.exe`) MUST be published in the same signed release as the CLI, and its digest MUST be recorded in `ops/kernel-pin.toml` `[planned]`. A CLI MUST refuse to launch a kernel whose digest differs from its pin, with exit `3`. `[planned]` call: `resolveKernelAsset()` in `@horizoncode/kernel-client`. | `gate:kernel-pin` (catalog §3.5). |
| **R-ops-5** | The Homebrew formula `ops/homebrew/hzcode.rb` `[planned]` MUST reference the released tarball URL plus `sha256` and MUST NOT build from source. A formula that resolves to a moving URL is a release blocker. | `gate:install-smoke`; formula lint job `[planned]`. |
| **R-ops-6** | cargo and nix installation MUST be supported as `cargo install hzcode-cli` `[planned]` and a flake output `.#hzcode` `[planned]`, and both MUST consume the same pinned kernel asset as §2.1 rather than compiling or downloading a different one. | `gate:install-smoke`; `flake.nix` `[planned]` build check. |
| **R-ops-7** | The Docker image `ops/docker/Dockerfile` `[planned]` MUST be distroless-style, run as non-root, ship CLI and kernel at the same version, and contain no credentials, no package manager cache and no build toolchain. | image scan in `gate:install-smoke`; `docker inspect` assertions `[planned]`. |
| **R-ops-8** | Installation MUST NOT require network access after the artifact is fetched, and MUST write only under the declared install roots: the install prefix (`~/.local/bin` by default), the config root `~/.config/horizon/`, the state root `~/.local/state/horizon/` (name addition required in `_conventions.md` §1, R-ops-74), the workspace config `.hz/`, and the container image root. | `gate:install-smoke` `strace`/`fs-sandbox` assertion `[planned]`. |
| **R-ops-9** | Every build MUST answer `hzcode version --json` with at least `{ version, channel, commit, kernelDigest, HZ_PROTO, HZ_ABI, schemaRevision }`, and diagnostics MUST use that output rather than re-deriving versions. | `packages/cli/test/commands/version.test.ts` `[planned]`; consumed by `hzcode doctor` and `hzcode support-bundle`. |

### 2.2 Versioning and release trains

| # | Rule | Test |
|---|---|---|
| **R-ops-10** | Semver applies per artifact, not to the product as a whole. `hzcode` (CLI), each `@horizoncode/*` package, each `hz_*` crate, `HZ_PROTO` and `HZ_ABI` carry independent versions. `HZ_PROTO` and `HZ_ABI` are integers bumped only on a breaking change (`_conventions.md` §1) — never on a feature addition that is backward compatible. | `gate:wire-parity`; `hz_codegen` `[planned]` refuses to emit a schema change without a revision delta in `packages/protocol/src/revision.json` `[planned]`. |
| **R-ops-11** | CLI and kernel are a **release train**: every stable release publishes one manifest naming both, and every pair in the manifest MUST have been tested together in `gate:kernel-abi-compat`. Independently updating them later is allowed only within the compatibility set declared in `ops/kernel-compat.toml` `[planned]`. | `hzcode release verify ops/release-manifest.json` `[planned]`; `gate:kernel-abi-compat`. |
| **R-ops-12** | A breaking `HZ_PROTO`/`HZ_ABI` bump MUST ship a compatibility window of at least one minor release in which both mixed pairs (old CLI + new kernel, new CLI + old kernel) **fail closed** with exit `3` and a named reason code, never degrade silently. This is ADR-002 as seen from the packaging side. | `gate:cross-plane-abi`; mixed-pair fixtures in `packages/testing/src/ops/abi-matrix` `[planned]`. |
| **R-ops-13** | The changelog MUST be generated from merged change metadata (PR title, ADR/issue references), grouped by artifact; hand-written entries are additive only and MUST carry a link to the change they describe. A generated section MUST NOT be edited in place. | `ops/changelog.gen.ts` `[planned]`; `gate:changelog` `[planned]` regenerates and diffs. |
| **R-ops-14** | Exactly three channels exist: `nightly` (built from `main`, ephemeral CI artifacts only; MUST NOT be installable by `install.sh` or any package manager), `beta` (release candidate, signed, installable, no deprecation guarantees), `stable` (tagged, signed, the only channel that may be a default). | `gate:release-integrity` `[planned]` asserts `channel` against the artifact class. |
| **R-ops-15** | A stable release MUST be reproducible from its tag alone (toolchain and dependency set pinned in `ops/release.lock` `[planned]`) **or** the manifest MUST declare `"reproducible": false` together with a one-line reason. Either claim MUST be machine-readable; silence is not allowed. | `gate:reproducible` `[planned]` (see R-ops-24). |
| **R-ops-16** | Rollback MUST be possible to the immediately preceding stable version installed on this machine: `hzcode update --rollback` re-installs it only after verifying its digest and signature. Every channel MUST keep the previous three stable versions downloadable; published artifacts are immutable. | `packages/testing/src/ops/update-rollback.test.ts` `[planned]`. |
| **R-ops-17** | Deprecating a channel, formula, crate or image MUST be announced one minor release before removal, and removal MUST NOT delete or re-name an already published artifact. Re-tagging a released version is forbidden. | `gate:release-integrity` checks tag↔artifact immutability against the published manifest history `[planned]`. |

### 2.3 Release integrity

| # | Rule | Test |
|---|---|---|
| **R-ops-18** | Every user-installable artifact (CLI binary, kernel asset, sidecars, Docker image, npm tarball) MUST carry a signature that verifies offline against a key or certificate pinned in the CLI distribution. `hzcode update` and `install.sh` MUST verify before use. | `gate:release-integrity` `[planned]`; offline verification test in `packages/testing/src/ops/verify-offline.test.ts` `[planned]`. |
| **R-ops-19** | An SBOM (CycloneDX JSON) MUST be generated per released artifact, attached to the release, and MUST list direct and transitive dependencies with pinned versions and detected licenses. | `gate:sbom` `[planned]`; SBOM diff review in the release checklist. |
| **R-ops-20** | A provenance attestation (SLSA-style in-toto) MUST be produced by **the same CI job that built the artifact**, never by a downstream job. If the attestation's subject digest does not equal the artifact digest, the release MUST be quarantined and not advertised. | `gate:attestation-subject` `[planned]`. |
| **R-ops-21** | `ops/release-manifest.json` `[planned]` (schema `ReleaseManifestV1`, in `@horizoncode/protocol`) is the single authority describing a release: artifacts with `sha256`, kernel pin, `HZ_PROTO`, `HZ_ABI`, SBOM and attestation references, `reproducible` flag, channel. `ops/kernel-pin.toml` is the committed source of truth for the kernel digest; `gate:kernel-pin` fails if the two disagree. | `gate:kernel-pin`; `gate:release-integrity`. |
| **R-ops-22** | No artifact may be published from a dirty working tree, an unpinned toolchain, or a build whose inputs are not in `ops/release.lock`. The publish job MUST fail with exit `3` instead of publishing. | `gate:clean-build` `[planned]`. |
| **R-ops-23** | Debug sidecars / symbol files for CLI and kernel MUST be published and attested like the artifacts themselves, so crash diagnosis (§2.6) does not require shipping symbols to users. | `gate:release-integrity`; `hzcode support-bundle` symbolisation check `[planned]`. |
| **R-ops-24** | If `reproducible: true`, an independent second builder MUST produce a byte-identical CLI binary for `linux/amd64`; the comparison runs in `gate:reproducible` `[planned]` on every stable tag. If it fails, the flag is downgraded in the same change and the reason recorded. | `gate:reproducible` `[planned]`. |
| **R-ops-25** | Every check in this subsection is **fail-closed and non-waivable**; §2.4's exception process does not apply to any rule in §2.1 (kernel pinning), §2.3, or R-ops-61…R-ops-65. | `gate:gate-selftest` asserts those gates have no waiver file `[planned]`. |

### 2.4 CI/CD gate catalog

The gate table in `/data/home/forge/hzcode/docs/24-feature-catalog.md` §3.5 is the registry; this subsection adds the operations-owned gates and the rules that govern all of them. Names introduced here MUST be registered in §3.5 in the same change (`_conventions.md` §1: a document that needs a new name adds it to the canonical set), and `25-roadmap-and-glossary.md` owns the glossary entries.

| # | Rule | Test |
|---|---|---|
| **R-ops-26** | A gate MUST be invoked as a single named command that prints exactly one verdict line `gate:<name> PASS|FAIL|WAIVED` and exits `0` for PASS/WAIVED, non-zero for FAIL. Gates that print prose instead of a verdict are non-conforming. | `gate:gate-selftest` `[planned]`. |
| **R-ops-27** | Every gate MUST ship a **fail fixture**: a repository or input on which it fails, checked in. A gate without a fail fixture is itself a build failure. | `gate:gate-selftest` `[planned]`; fixtures under `packages/testing/fixtures/gates/<gate>/` `[planned]`. |
| **R-ops-28** | Gates are hermetic and deterministic: no network access and no wall-clock or locale dependence, except the explicitly network-tagged lanes (`providers-live` `[planned]`) which MUST be excluded from the required set. | `gate:gate-hermeticity` `[planned]` runs gates with the network namespace disabled in the fast lane. |
| **R-ops-29** | Gate timeouts are hard limits (§8). A timeout MUST be reported as FAIL, never as skipped or inconclusive. | `packages/testing/src/gates/timeout.test.ts` `[planned]`. |
| **R-ops-30** | Only these gates are non-waivable: `gate:kernel-pin`, `gate:cross-plane-abi`, `gate:no-unknown-retry`, `gate:receipt-coverage`, `gate:secret-scan` `[planned]`, `gate:doc-status`, `gate:release-integrity` `[planned]`, `gate:attestation-subject` `[planned]`, and `gate:gate-selftest`. Every other gate MAY be waived under R-ops-31. | `gate:gate-selftest` asserts the non-waivable list matches the constant in `ops/gates/policy.ts` `[planned]`. |
| **R-ops-31** | The exception process is one file per gate: `ops/gates/waivers/<gate>.toml` `[planned]` with `owner`, `reason`, `expires` (≤ 30 days from commit), `issue`. A waiver is valid only while unexpired and only for the `main` lane; it MUST NOT be honored on a tag build. An expired waiver is a FAIL. | waiver-expiry test in `gate:gate-selftest` `[planned]`. |
| **R-ops-32** | PR lanes are path-mapped: the fast lane runs always; the full lane runs when `packages/**`, `crates/**`, `ops/**`, `docs/**` or the gate definitions change. A gate MAY be moved between lanes only by an operations-owned change that also updates §8's wall-clock budget. | `ops/lanes.toml` `[planned]`; `gate:lane-budget` `[planned]` compares lane content to the §8 budget. |
| **R-ops-33** | Every gate MUST be runnable locally with the same command the CI runs, and that command MUST be documented in `docs/16-operations.md` §3 (Interfaces) rather than in CI YAML comments. | doc link check in `gate:doc-status`; `hzcode bench`/`ops/gates/run.ts` `[planned]`. |

#### 2.4.1 The gate catalog

Roughly two dozen gates exist. The table below is the operational view: what fails the build, which lane, and whether it is waivable. Gates marked `catalog` are defined in `/data/home/forge/hzcode/docs/24-feature-catalog.md` §3.5; gates marked `ops` are introduced by this document.

| Gate | Source | Fails the build when | Lane | Waivable |
|---|---|---|---|---|
| `gate:unit` `[planned]` | ops | Any unit test fails, or coverage of a package marked `sensitive:` drops below its declared floor. | fast + full | yes |
| `gate:integration` `[planned]` | ops | Any integration test fails (multi-package: core↔protocol↔server↔kernel-client). | full | yes |
| `gate:boundary-test` | catalog | A new caller of a one-primitive boundary appears (subagent construction, effect submission, event append) outside the sanctioned primitive. | fast + full | no-by-practice (§7.2) |
| `gate:adversarial` `[planned]` | ops | Any adversarial/prompt-injection fixture flips an authority outcome (a batch that must be denied is allowed, or a receipt is fabricated). | full | yes |
| `gate:cache-guard` | catalog | The compiled prompt prefix drifts for a `(provider, model, config)` tuple; changing a pin requires the `--update-golden` commit with rationale (RC-8, ADR-009). | full | yes |
| `gate:tool-declaration` | catalog | A tool lacks a full declaration (schema, effect class, capability ID, renderers, idempotency, telemetry) per ADR-015. | fast + full | yes |
| `gate:event-catalogue-parity` `[planned]` | ops | An event name is emitted, subscribed or documented that is not in `_conventions.md` §6, or a canonical event is emitted with a mismatched payload shape (RC-1…RC-4). | fast + full | yes |
| `gate:parity-ratchet` / `gate:frontend-parity` | catalog | A catalog capability becomes unreachable from a surface (Section A reachability), or a capability edge reaches one front-end and not another. | full | yes |
| `gate:prompt-governance` `[planned]` | ops | A prompt template, agent profile or system fragment changes without an owner-approved change record, or a prompt bypasses the template embedding path. | full | yes |
| `gate:import-boundary` `[planned]` | ops | A package/crate imports across its declared boundary — including deep imports into another package's `src/`, and any import of kernel internals from the TS side. Companion to `gate:layering`, which checks rank order. | fast + full | yes |
| `gate:perf-regression` `[planned]` | ops | A tracked benchmark regresses beyond §8's thresholds, or a benchmark's metric definition is missing its four lines (NF-041/NF-050). | nightly + release | yes |
| `gate:cross-platform-matrix` `[planned]` | ops | The required `linux/macOS/Windows` × `amd64/arm64` cell fails: build, install, `hzcode doctor`, or the platform smoke suite. | full + release | yes (release: no) |
| `gate:kernel-abi-compat` `[planned]` | ops | Any mixed CLI/kernel pair inside the compatibility set in `ops/kernel-compat.toml` fails to fail-closed or to interoperate as declared. | full + release | yes (release: no) |
| `gate:kernel-pin` | catalog | The kernel asset digest or manifest is unpinned, stale, or disagrees with `ops/kernel-pin.toml`. | fast + full + release | **no** |
| `gate:cross-plane-abi` | catalog | The TS side does not fail closed on a missing or older native ABI (ADR-002). | fast + full | **no** |
| `gate:no-unknown-retry` | catalog | Code retries an `UNKNOWN` automatically (RC-7). | fast + full | **no** |
| `gate:receipt-coverage` | catalog | A mutating tool has no declared observation path (ADR-012). | full | **no** |
| `gate:layering`, `gate:file-size`, `gate:function-size`, `gate:repolint-debt` | catalog | An import violates the rank law; debt (file size, function size, baseline) increases — baselines may only decrease. | fast + full | yes |
| `gate:wire-parity` | catalog | A wire schema is edited in two places or lacks one generated owner. | fast + full | yes |
| `gate:sensitive-path-coverage` | catalog | A path declared `sensitive:` is not covered by a test proving its behaviour. | full | yes |
| `gate:dead-lane-fail-closed` | catalog | A disabled lane reports success instead of `UNKNOWN`/refusal. | full | yes |
| `gate:provenance` / `gate:notice` `[planned]` | catalog | Inherited code lacks an upstream pin or NOTICE entry (ADR-014). | full | yes |
| `gate:doc-status` | catalog | A document claims a status level above its evidence, or a status table row lacks an evidence column (`_conventions.md` §8). | fast + full | **no** |
| `gate:secret-scan` `[planned]` | ops | A secret, private key or credential pattern is found in history or the diff. | fast + full | **no** |
| `gate:dependency-policy` `[planned]` | ops | A dependency is unpinned, unlicensed-per-`deny.toml`, yanked, or fails the advisory allow-list (§2.8). | daily + release | yes |
| `gate:release-integrity` `[planned]` | ops | A release artifact, signature, SBOM, manifest or channel assignment fails its checks (§2.3). | release | **no** |
| `gate:attestation-subject` `[planned]` | ops | Provenance subject digest ≠ artifact digest (R-ops-20). | release | **no** |
| `gate:install-smoke` `[planned]` | ops | Any channel installs different bytes, writes outside the declared roots, or requires post-install network (R-ops-1…R-ops-8). | nightly + release | yes (release: no) |
| `gate:reproducible` `[planned]` | ops | A second builder is not byte-identical while `reproducible: true` (R-ops-24). | release | yes (only by downgrading the flag, R-ops-15) |
| `gate:gate-selftest` `[planned]` | ops | Any gate lacks a passing pass-fixture, a failing fail-fixture, a verdict line, a timeout, or a waiver-policy entry (R-ops-26…R-ops-31, R-ops-32). | full + release | **no** |

"Waivable: no-by-practice" means the gate is technically insertable into the waiver file, but any waiver that touches authority semantics MUST be treated as an ADR change by the reviewer; the rationale for not doing that is recorded in the waiver's `reason`.

The remaining ops gates introduced by this document — none of which appears in the table above — are registered in `/data/home/forge/hzcode/docs/24-feature-catalog.md` §3.5 in the same change (R-ops-26):

| Gate | Fails when |
|---|---|
| `gate:changelog` `[planned]` | A generated changelog section does not match its inputs, or a generated section is hand-edited (R-ops-13). |
| `gate:clean-build` `[planned]` | A release build runs from a dirty working tree, or from a toolchain not pinned in `ops/release.lock` (R-ops-22). |
| `gate:sbom` `[planned]` | An artifact has no SBOM, or its SBOM omits a dependency or a license (R-ops-19). |
| `gate:log-redaction` `[planned]` | A canary secret or canary prompt string appears in a trace, a log, a crash record or a bundle (R-ops-35, R-ops-38, R-ops-43). |
| `gate:gate-hermeticity` `[planned]` | A gate opens a network socket, or depends on wall clock or locale (R-ops-28). |
| `gate:lane-budget` `[planned]` | A lane exceeds its §8 wall-clock budget, or a document restates a budget number without citing its `ops/budgets.toml` key (R-ops-32, R-ops-48). |
| `gate:pricecheck` `[planned]` | A price-table entry is edited or deleted, or a configured model has no price row and no explicit `null` with a reason (R-ops-68, R-ops-69). |
| `gate:doc-names` `[planned]` | A name used in `docs/` is defined neither in `_conventions.md` nor in the registered gate catalog (R-ops-74). |
| `gate:doc-template` `[planned]` | A document omits a template section without a stated reason, or presents them out of order (R-ops-76). |

#### 2.4.2 Checks adopted from the final audit (Part D, RC-15)

> Adopted 2026-11-07 from [29-final-audit.md](./29-final-audit.md) Part D (RC-15).

- **Prompt-vs-grant lint:** a profile whose prompt mentions an effect absent from its ceiling fails the build.
- **Generated-reference drift:** model-facing references (tool catalogs, command docs) are **generated** from the declarations; CI gates drift.
- **`.hz`-cannot-supply-authority test:** workspace-supplied configuration can never encode an authority grant (narrowing only, mechanically asserted).

#### 2.4.3 Metric and fixture contracts (RC-15)

> Adopted 2026-11-07 from the adoption wave (H-7 and the hostile-fixture corpus; sources A.9.6 oh-my-pi, A.9.5 mini-swe-agent, distilled in `30-steal-list.md` §2 F/H).

- **Metric contract:** every published number carries four slots — **Metric** (what is measured), **Anchor** (the baseline it is compared against), **Population** (on what runs), **Excludes** (what was discarded and why). A number without the four slots is not a result; cross-version comparisons without it are theatre.
- **Hostile-input fixture corpus for read paths:** checked-in fixtures including a lockfile tarpit, a single 600 KB line, a FIFO, lying extensions, Unicode filenames and near-miss filenames — the file tools, truncation and redaction paths MUST run against them in CI.

### 2.5 Observability

Owner: `@horizoncode/observe` (OTel, logging, metrics, redaction — `_conventions.md` §3). Default posture: **local-first**. A run records everything it needs locally and exports nothing anywhere unless the operator says so.

| # | Rule | Test |
|---|---|---|
| **R-ops-34** | The export mode is one setting, `HZ_OTEL_EXPORT ∈ {off, local, otlp}` (default `local`). `local` writes traces to the local trace file (§2.5.1) and starts no exporter; `otlp` requires an explicitly configured endpoint. No implicit endpoint, no environment-variable pickup of a third-party collector. | `packages/observe/test/export-mode.test.ts` `[planned]`. |
| **R-ops-35** | Recorded: span/event ids, timestamps, durations, capability IDs, effect classes, decision reason codes, receipt and artifact digests, token and cost counters, model/provider identifiers, git commit of the workspace. **Redacted by default**: prompt text, tool input/output bodies, file contents, environment variable values, header values, user home paths beyond the workspace root. Redacted values appear as `sha256:<digest>` plus a length, never as truncation of the raw value. | `gate:log-redaction` `[planned]`: canary secrets and canary prompt strings injected into a fixture session MUST NOT appear in traces, logs, a crash record or a support bundle. |
| **R-ops-36** | OpenTelemetry attributes follow the GenAI semantic conventions for model calls (`gen_ai.*`) and carry `hz.*` attributes for `hz.capability.id`, `hz.effect.class`, `hz.decision.reason_code`, `hz.receipt.digest`, `hz.session.id`, `hz.step.id`. One step = one span tree rooted at `hz.step`; an effect is a child span that ends only at a terminal vocabulary word (RC-7). | `packages/observe/test/semconv.test.ts` `[planned]`; conformance fixture `packages/testing/fixtures/traces/genai-minimal.jsonl` `[planned]`. |
| **R-ops-37** | Every span exported to OTLP MUST also be representable as a line of the local trace file (§4). The local file is the substrate; OTLP is a projection. A trace that cannot be written locally MUST NOT be exported. | `packages/observe/test/trace-roundtrip.test.ts` `[planned]`. |
| **R-ops-38** | Redaction runs at the emission boundary (one function `redact(record)` `[planned]` in `@horizoncode/observe`), not at the exporter. A record that has not passed `redact()` MUST NOT be written to any sink — file, OTLP, crash record or bundle. Redaction MUST be fail-closed: an unknown field type is dropped, not passed through. | `gate:log-redaction`; `packages/observe/test/redact-fail-closed.test.ts` `[planned]`. |
| **R-ops-39** | Metrics are declared in one registry `packages/observe/src/metrics.ts` `[planned]` with name, unit, type and labels, and the minimum set is: `hz.effect.count{outcome, capability}`, `hz.unknown.count{capability}`, `hz.reconcile.duration`, `hz.step.duration`, `hz.usage.tokens{provider, model, kind}`, `hz.cost.micros{provider, model}`, `hz.cache.prefix.hit{family}`, `hz.permission.decision.count{outcome}`. A metric not in the registry MUST NOT be emitted. | `gate:event-catalogue-parity` extension for metrics `[planned]`; registry diff test. |
| **R-ops-40** | Opt-in telemetry (any sink that leaves the machine, including crash reports and the org cost dashboard of R-ops-71) MUST be: off by default; enabled only by an explicit interactive confirmation or a managed-policy setting that names the endpoint; accompanied by a manifest listing every field sent; revocable at any time with immediate effect; and never enabled implicitly by a non-interactive flag such as `--yes` or `CI=true`. | `packages/observe/test/telemetry-consent.test.ts` `[planned]`; a CI job that asserts no default-on path exists `[planned]`. |

#### 2.5.1 Local trace file

Path: `.hz/traces/<session-id>.jsonl` in the workspace, or the state root `~/.local/state/horizon/traces/<session-id>.jsonl` when the workspace is read-only. One JSON object per line, schema `TraceRecordV1` in `@horizoncode/protocol`. Required fields: `ts` (RFC 3339, microseconds), `traceId`, `spanId`, `parentSpanId` (nullable), `name`, `kind`, `sessionId`, `stepId` (nullable), `attributes` (already redacted), `durationUs` (nullable; null until the span ends), `outcome` (nullable; terminal vocabulary of RC-7 only). The file is append-only, MUST be replayable by `hzcode session replay --trace` `[planned]`, and MUST be self-describing enough to render without the database.

### 2.6 Diagnostics

| # | Rule | Test |
|---|---|---|
| **R-ops-41** | `hzcode doctor` MUST run the check set in §2.6.1 and print, per check: `name`, `status ∈ {ok, warn, fail, skipped}`, a one-line finding, and a fix hint. `--json` MUST emit the same content as `DoctorReportV1`. | `packages/cli/test/commands/doctor.test.ts` `[planned]`. |
| **R-ops-42** | `hzcode doctor` is **read-only**. It MUST NOT repair anything without an explicit `--fix <check>`, MUST NOT delete files, MUST NOT contact the network unless `--online` is passed, and MUST be safe to run while another session holds a claim. | `packages/cli/test/commands/doctor-readonly.test.ts` `[planned]`: the check set runs under a filesystem sandbox that fails on any write. |
| **R-ops-43** | `hzcode support-bundle` MUST produce a single archive `hzcode-support-<utc-timestamp>.tar.zst` containing `manifest.json`, `versions.json`, `doctor.json`, `redaction-report.json`, the requested logs and trace records, and recent receipts. Every entry MUST have its `sha256` in `manifest.json`. The bundle MUST verify with `hzcode support-bundle --verify <file>` before it is attached anywhere. | `packages/cli/test/commands/support-bundle.test.ts` `[planned]`; tamper test in `gate:gate-selftest`. |
| **R-ops-44** | A crash of the CLI, the kernel, or a supervised child MUST write a crash record to the state root and MUST NOT block the session from being resumed. The record contains the crash class, the stack (symbolised from the published sidecar when available, otherwise the raw frames), versions from R-ops-9, the last N redacted trace records, and a `recovery` field naming what the user or the kernel will do next (resume, reconcile, refuse). | `packages/testing/src/ops/crash-record.test.ts` `[planned]`; a SIGKILL-of-kernel acceptance fixture `[planned]`. |
| **R-ops-45** | Crash reporting to any remote sink is opt-in under R-ops-40. The default is a local record plus a printed pointer to the file. No prompt text, file contents or secrets are included by construction (R-ops-38). | `telemetry-consent.test.ts`; `gate:log-redaction`. |
| **R-ops-46** | Log levels are exactly `error`, `warn`, `info`, `debug`, `trace`; default `info`; selected by `HZ_LOG` or `--log-level`. TTY output is human-readable, non-TTY output is one JSON object per line. Changing the level MUST NOT change behaviour, and `debug`/`trace` MUST NOT widen any capability, mask a policy decision, or emit an unredacted record. | `packages/observe/test/log-levels.test.ts` `[planned]`. |
| **R-ops-47** | Every diagnostic artifact (doctor report, bundle, crash record) MUST embed `versions.json` built from `hzcode version --json`, including `hzk` digest, `HZ_PROTO`, `HZ_ABI`, schema revision, platform triple, sandbox backend and its guarantee summary. A diagnostic that cannot name the kernel digest is not a diagnostic. | `packages/cli/test/commands/versions-embed.test.ts` `[planned]`. |

#### 2.6.1 The doctor check set

| Check | Passes when | Fail-closed? |
|---|---|---|
| `kernel.asset` | `hzk`/`hzk.exe` exists at the resolved path and its digest equals `ops/kernel-pin.toml`. | yes — missing or mismatched ⇒ `fail`, exit `3` |
| `kernel.abi` | `HZ_ABI`/`HZ_PROTO` of CLI and kernel are in the declared compatibility set. | yes ⇒ exit `3` (ADR-002) |
| `kernel.exec` | The kernel starts, answers a `ping`/`caps` handshake, and exits cleanly when asked. | yes ⇒ exit `3` |
| `sandbox.backends` | The platform's expected backend is available (Landlock/bubblewrap/seccomp on Linux, Seatbelt on macOS, write-restricted token/AppContainer on Windows) and the guarantee vector is reported honestly. | warn on degraded, fail when the mode requires the missing dimension |
| `fs.type` | The storage root is a local filesystem. | warn on NFS/SMB/FUSE; `fail` only under `--strict` (see RN-5) |
| `state.db` | The SQLite file opens, passes `PRAGMA integrity_check`, and its schema revision matches the binary. | yes ⇒ exit `3` |
| `state.migrations` | No pending migration is blocked and no downgrade is required. | yes ⇒ exit `3` (RN-7) |
| `disk.space` | Free space at the state root ≥ the configured floor (default 1 GiB) plus headroom for the current session estimate. | fail under the floor |
| `cache.prefix` | The compiled prompt prefix for the active `(provider, model, config)` matches its golden pin. | warn only outside CI |
| `providers.reachability` | Skipped unless `--online`; each configured provider answers within its timeout. | warn (never fail: an offline machine is valid) |
| `config.narrowing` | Workspace config only narrows user config; no workspace-named program is trusted implicitly. | yes ⇒ exit `3` (project-config safety) |
| `clock.skew` | Local clock is within 120 s of the last observed server or file-clock evidence. | warn |
| `plugins.manifests` | Every installed plugin manifest verifies against its signature and capability declaration. | fail per-plugin; exit `3` only if a plugin is load-bearing for the current session |

### 2.7 Performance engineering

| # | Rule | Test |
|---|---|---|
| **R-ops-48** | There is exactly one budgets registry: `ops/budgets.toml` `[planned]`. Every numeric budget in every document is a *citation* of a key in that file; a document that restates a number without naming its key is non-conforming. | `gate:lane-budget` `[planned]` cross-checks §8 and `ops/budgets.toml`; `gate:doc-status` flags uncited numbers in budget tables. |
| **R-ops-49** | The benchmark harness is `hzcode bench` `[planned]`, driven by frozen suites declared in `ops/bench/suites.toml` `[planned]`. A suite names its fixtures, its runner class and its metrics; results are recorded as `BenchResultV1` JSONL. | `packages/cli/test/commands/bench.test.ts` `[planned]`; `gate:perf-regression`. |
| **R-ops-50** | A benchmark metric MUST carry the four lines required by NF-041/NF-050: *counts what*, *from which anchor*, *over which population*, *excluding what*. A metric without all four lines is a gate failure, not a documentation nit. | `gate:perf-regression` definition check; `ops/bench/METRICS.md` `[planned]` is generated from the suite definitions. |
| **R-ops-51** | Regression policy: with a stable baseline (two consecutive baseline runs within 3 % p50 of each other), a candidate fails `gate:perf-regression` when p50 worsens by more than 5 % or p95 by more than 10 % on the same runner class, or when a declared hard ceiling in `ops/budgets.toml` is exceeded regardless of baseline. If the baseline is unstable (variance > 3 %), the gate reports `UNSTABLE` and fails until it is re-baselined; it never silently passes. | `gate:perf-regression`; `packages/testing/src/ops/baseline-stability.test.ts` `[planned]`. |
| **R-ops-52** | Baselines live in `ops/bench/baseline/<suite>.<platform>.json` `[planned]` and may only be raised by a commit whose message contains the rationale and the run id (`--update-baseline`); raising a baseline is a reviewable event, exactly like the cache-guard pin rule (RC-8). | `gate:perf-regression` refuses a diff that raises a baseline without a run id. |
| **R-ops-53** | Profile presets are a fixed set — `--profile ci`, `tui-startup`, `stream-latency`, `session-replay`, `tool-roundtrip` `[planned]` — each naming its metric set and budget keys. Adding or renaming a preset is an operations-owned change that updates `ops/budgets.toml` and this rule in the same PR. | `gate:gate-selftest` preset-registry diff `[planned]`. |

### 2.8 Security operations

| # | Rule | Test |
|---|---|---|
| **R-ops-54** | Vulnerability disclosure runs through `SECURITY.md` `[planned]` at the repository root and `.well-known/security.txt` on the project site `[planned]`: a private reporting channel, acknowledgement within 3 working days, a 90-day coordinated-disclosure default (shorter when the reporter and the project agree, longer only if a fix requires it and both parties agree in writing), and public advisories with CVE or GHSA identifiers when a CVE is warranted. | `ops/security/disclosure-checklist.md` `[planned]` is checked at release time by the release owner; RN-8 is the operational runbook. |
| **R-ops-55** | Every dependency is pinned: `bun.lock` for TS, `Cargo.lock` for Rust, digests for container bases and downloaded assets. Shipped manifests and `package.json`/`Cargo.toml` ranges MUST NOT float at install time. An upgrade is a PR that updates lockfile, SBOM and (if applicability changes) the advisory allow-list together. | `gate:dependency-policy`; `bun install --frozen-lockfile` and `cargo --locked` in every build job. |
| **R-ops-56** | Dependency admission is allow-list based: a license allow-list in `deny.toml` `[planned]` (Rust) and `ops/security/licenses.allow` `[planned]` (TS), a crate/binary allow-list for anything that links or ships as native code, and advisory scanning via `cargo-deny` + `cargo-audit` for Rust and the bun equivalent of `npm audit` for TS. Triage SLA: critical ≤ 7 days, high ≤ 30 days, medium/low at the next minor; an unpatched advisory with no mitigation MUST be published in the release notes. | `gate:dependency-policy` runs `cargo deny check advisories bans licenses sources` `[planned]`; the TS side runs `bun audit --json` `[planned]`. |
| **R-ops-57** | Secret scanning runs in two places — a fast local pre-commit hook and `gate:secret-scan` in CI over the diff and (on tags) the history reachable from the tag. A finding fails the build and the response is rotate-then-clean, in that order (RN-8). | `gate:secret-scan`; hook installed by `hzcode init --hooks` `[planned]`. |
| **R-ops-58** | The kernel asset is the highest-value supply-chain target: digest pin (R-ops-4), signature (R-ops-18), provenance (R-ops-20) and a non-waivable gate (`gate:kernel-pin`). A kernel asset MUST NOT be fetched from any host not named in the release manifest; mirrors are allowed only because their content is digest-verified. | `gate:kernel-pin`; `packages/testing/src/ops/kernel-mirror.test.ts` `[planned]`. |
| **R-ops-59** | The threat model lives with the authority/safety document (the `docs/18-*`-class document; the exact filename is `UNKNOWN` in this document and MUST be filled in by the owner of that file [planned]), and MUST be revised within one release of any change to: an effect class, the capability registry, a sandbox backend, the update path, or the redaction rules. The revision date and the triggering change MUST be recorded in the threat model itself. | `gate:doc-status` checks the revision date against the last change to `_conventions.md` §5, `crates/hz_sandbox`, and the update path `[planned]`. |
| **R-ops-60** | A security report that implicates an authority boundary (a denial that can be bypassed, a receipt that can be forged, an `UNKNOWN` that can be laundered into success) is **fail-closed by default until proven otherwise**: the affected capability MAY be disabled by a published kill-switch configuration while the matter is open, and that decision is recorded. | `ops/security/killswitch.md` `[planned]`; a fixture that disables `terminal.run` and asserts the refusal `[planned]`. |

### 2.9 Update mechanism

| # | Rule | Test |
|---|---|---|
| **R-ops-61** | `hzcode update` (and every install/swap path) is a **host operation**, not a capability: it has no capability ID, is not exposed as a tool, and MUST NOT be reachable from a session batch or from any model-originated request. Its origin is always `UserAction`. | `packages/testing/src/ops/update-origin.test.ts` `[planned]`: a scripted model batch asking the CLI to update MUST be refused as unknown/denied. |
| **R-ops-62** | The update flow is fixed and ordered: (1) resolve channel and current version; (2) fetch `ops/release-manifest.json`; (3) verify manifest signature; (4) select artifacts for this platform; (5) download into a staging directory; (6) re-verify digest and signature of **each** artifact; (7) if busy, stop; (8) atomic swap; (9) post-swap smoke (`hzcode version --json`, kernel handshake, `doctor` subset); (10) retain the previous version for rollback. No step may be skipped for "fast path". | `packages/testing/src/ops/update-flow.test.ts` `[planned]`; an ordering test that fails if a step's observable side effect is missing. |
| **R-ops-63** | Signature and digest verification happen **before** the swap, always. Any verification failure aborts with exit `3`, leaves the existing install byte-identical to what it was, and writes an `update_failed` entry to the install journal (§4). | tamper test: corrupt one byte of the staged CLI or the staged kernel and assert both the abort and the untouched install `[planned]`. |
| **R-ops-64** | The swap is atomic and all-or-nothing across CLI **and** kernel: either both move to the staged version or neither does. Preferred mechanism: a versioned directory plus a symlink flip (same filesystem), with a same-directory `rename(2)` fallback. A crash at any instant MUST leave a working install — the old one or the new one — never a mixed pair. | `packages/testing/src/ops/swap-crash.test.ts` `[planned]`: kill the process between each pair of steps and assert the invariant on restart. |
| **R-ops-65** | Rollback exists in two forms: automatic (a failed post-swap smoke reverts immediately) and explicit (`hzcode update --rollback`). Both verify the previous artifacts before re-installing them; neither trusts the staging directory after a failure. | `update-rollback.test.ts`; `swap-crash.test.ts`. |
| **R-ops-66** | Modes: `--check` (report only, never download), `--offline --from <dir>` (install from a local manifest+artifacts, still signature-verified), `--staged` (fetch and verify now, apply at next start or on `hzcode update --apply`), `--pin <version>` (hold at a version; auto-update never crosses a pin), `--channel <stable|beta|nightly>` (R-ops-14). Automatic updating is **off by default**; when a managed policy enables it, it MAY be enabled only for the `stable` channel and MUST NOT move the kernel outside the compatibility set of R-ops-11. | `packages/testing/src/ops/update-modes.test.ts` `[planned]`. |
| **R-ops-67** | An update MUST NOT run while any session in this workspace holds an execution claim, and MUST NOT terminate a running session to proceed. On a busy install the command reports `update_busy` and exits `1`; the operator may retry after the session settles. `--force` is deliberately not part of the interface. | `packages/testing/src/ops/update-busy.test.ts` `[planned]`. |

### 2.10 Cost and budget operations

| # | Rule | Test |
|---|---|---|
| **R-ops-68** | The vendor price table is a single append-only file, `packages/provider/src/prices.json` `[planned]` (owner: `@horizoncode/provider`). Corrections are appended as new entries with `effectiveFrom`, `sourceUrl` and `supersedes`; existing entries are never edited or deleted. | `pricecheck` `[planned]` (`ops/pricecheck.ts`): flags edits/deletions in the diff and any provider/model present in the catalog without a price entry. |
| **R-ops-69** | `pricecheck` MUST run on every change to `prices.json` and on a schedule against vendor documentation. It fails on: a removed entry, an unexplained gap (a model offered by a configured provider with no covered price row) or a price that contradicts the cited source URL. Unknown prices are represented explicitly as `null` with a reason — never guessed. | `gate:pricecheck` `[planned]`; it needs network access, so it runs on the nightly and dependency lanes rather than the hermetic fast lane (R-ops-28). |
| **R-ops-70** | Cost accounting MUST record, per settled model call, the price-table revision (`priceTableDigest`) used to compute cost, and MUST record the amount in integer micros (`hz.cost.micros`, R-ops-39). A cost figure that cannot name its price-table revision is not auditable and MUST NOT be displayed as a number. | `packages/core/test/budgets/cost-attribution.test.ts` `[planned]`; the receipt-replay fixture verifies cost determinism from a frozen table. |
| **R-ops-71** | Budgets are declared in TOML — `.hz/budgets.toml` per workspace and `~/.config/horizon/budgets.toml` per user — with keys for tokens, wall-clock, steps, cost micros, triage, web-search and subagent fan-out. Workspace budgets MAY only narrow user budgets, never widen them; the kernel enforces exhaustion and the CLI exits `5` (RC-5) with a budget report. | `packages/core/test/budgets/narrowing.test.ts` `[planned]`; `budget_report` tool output fixture. |
| **R-ops-72** | The org-level cost dashboard is an **opt-in server feature** of `@horizoncode/server`, off by default, requiring an explicitly configured collection endpoint and the consent rules of R-ops-40. It MUST aggregate counts, tokens and micros only; prompt text, tool bodies and file contents MUST NOT be accepted by the collector even if sent. Changing any budget default is a MINOR release note item. | `packages/server/test/cost-dashboard-consent.test.ts` `[planned]`; collector schema test that rejects a payload containing `prompt` or `content` fields. |

### 2.11 Docs governance

| # | Rule | Test |
|---|---|---|
| **R-ops-73** | Authority order inside `docs/`: `/data/home/forge/hzcode/docs/_conventions.md` > `/data/home/forge/hzcode/docs/02-decisions.md` (ADRs) > the topic-owner document for a topic > `/data/home/forge/hzcode/docs/24-feature-catalog.md` (catalogue; it references, it does not rule) > `/data/home/forge/hzcode/docs/25-roadmap-and-glossary.md` (terms and sequencing). When two documents disagree, the higher one wins and the lower one MUST be corrected in the same change. | `gate:doc-status` `[planned]` extension: a cross-reference conflict list is produced for review. |
| **R-ops-74** | `_conventions.md` wins on **names**. A document that needs a name not defined there MUST add it there in the same change (as this document does for the state root `~/.local/state/horizon/`). Names introduced by a lower-authority document without a `_conventions.md` entry are a gate failure. | `gate:doc-names` `[planned]`: extracts backticked identifiers from `docs/*.md` and checks the ones that look like names (paths, commands, gates, packages, crates) against `_conventions.md` plus the registered gate catalog. |
| **R-ops-75** | Status law (`_conventions.md` §8): a document MUST NOT claim a status level above its evidence, must state the level it does claim, and MUST render an unknown as `UNKNOWN`, never as implied success. Every status table row carries an evidence column; "evidence" is a file, a test, a run id or the literal `UNKNOWN`. | `gate:doc-status`; this document's §10 is itself checked. |
| **R-ops-76** | Every document in `docs/` uses the template in `_conventions.md` §9, in order. A section may be omitted only with a stated reason. Sections the template does not cover (like the runbooks below) MUST be placed inside an existing template section rather than appended as a new top-level one. Reference sections that refine an existing template section MAY be appended after the template's last section as a numbered sequence; each MUST name the template section it refines. This document's §12–§16 are such a sequence (§12 refines §7, §13–§14 refine the observability rules, §15 refines §8, §16 refines the versioning and release rules). | `gate:doc-template` `[planned]`. |
| **R-ops-77** | Editing a numbered rule is a semantic change: renumbering is forbidden, removal MUST be recorded as a tombstone (`R-ops-N` kept with `removed in <version>; superseded by <rule>`), and any change to a rule that another document cites MUST update that citation in the same change. | `gate:doc-status`; review checklist in `ops/security/disclosure-checklist.md`'s sibling `ops/docs/review.md` `[planned]`. |

### 2.12 Runbooks

A runbook is not law; it is the prescribed first response. Each names its exit code (RC-5, owned by `/data/home/forge/hzcode/docs/14-surfaces.md` §2.2 S16) and the artifact it produces for later diagnosis. Runbooks are consumed by `hzcode doctor` fix hints, so each MUST be referenced from the check it serves.

**RN-1 — Kernel missing or digest mismatch.**
- *Symptoms:* `kernel_asset_missing` or `kernel_digest_mismatch`; every effect attempt refuses; exit `3`. `hzcode version` still works (R-ops-9).
- *Diagnosis:* `hzcode doctor --json` → `kernel.asset`; compare `version.kernelDigest` to the CLI's pin and to `ops/kernel-pin.toml`. Distinguish three cases: asset absent (bad install), asset present with a different digest (corruption or a substituted binary), pin stale relative to the release manifest (packaging defect).
- *Action:* if absent or corrupt — reinstall the exact version (`hzcode update --pin <current> --from <verified artifact>` in the offline case) and re-run the smoke; never copy a kernel from another machine or version. If the pin disagrees with the manifest — stop, file a release-integrity defect, quarantine the release; do not edit `ops/kernel-pin.toml` locally. Failures are recorded in the install journal and a crash-style record (§4) so support can see the refused digest pair.

**RN-2 — `UNKNOWN` receipt reconciliation.**
- *Symptoms:* an effect settles as `UNKNOWN` (RC-7); the run stops short instead of retrying; the session claims a step with no terminal settlement.
- *Diagnosis:* inspect the receipt chain (`hzcode session verify <id>` `[planned]`) and the lease record; `hzcode session tree` shows the affected run; the kernel's reconciliation pass reports what it can prove about the effect's real outcome. Confirm nothing retried automatically (that would itself be a `gate:no-unknown-retry` failure).
- *Action:* reconcile by evidence, in this order — (1) if the effect is observable and provably not applied, a new decision + lease may re-attempt it, which emits `hz.effect.reconciled`; (2) if it is provably applied, close it with the observed outcome; (3) if it stays unprovable, leave it `UNKNOWN`, surface it in `hzcode session verify` output and refuse dependent steps. Never convert `UNKNOWN` into success by assertion, and never let a retry loop run unattended.

**RN-3 — Cache-guard failure.**
- *Symptoms:* `gate:cache-guard` fails; a prefix pin in `packages/context/test/golden/prefix/<family>.sha256` no longer matches (RC-8).
- *Diagnosis:* run the gate's diff mode; read the produced prefix-diff artifact to see which component changed — system prompt, tool schema set, or declared config. A schema change usually means `packages/protocol`/`hz_abi` moved under the prefix; a prompt change usually means a template edit under `gate:prompt-governance`.
- *Action:* if the drift is unintended, revert the offending change. If it is intended, land an explicit `--update-golden` commit containing a written rationale for each changed family, and expect a cost note in the release changelog (prefix churn burns cache). A pin must never be relaxed to a tolerance; it is either updated with rationale or restored.

**RN-4 — Disk full.**
- *Symptoms:* writes fail (`ENOSPC`); event append or blob write refuses; exit `1`; `doctor` `disk.space` fails.
- *Diagnosis:* `hzcode doctor` reports free space at the state root and the workspace; `hzcode du` `[planned]` (inherited ergonomic command, see `/data/home/forge/hzcode/docs/24-feature-catalog.md` A.3) attributes usage per session, trace file, artifact and snapshot.
- *Action:* reclaim in this order — (1) traces older than retention (default 14 days, §4); (2) expired worktrees via the worktree pool; (3) superseded session snapshots, keeping the newest per session; (4) compact the database. Never delete the event log under pressure: the log is the record of what happened. If the log itself must be relocated, use the storage-root setting and follow RN-5's guidance when the new root is not local. Record the action in the session log as a retention marker, not as a new event type (RC-3).

**RN-5 — NFS or another network filesystem detected.**
- *Symptoms:* `doctor` `fs.type` warns; SQLite write latency spikes; occasional `SQLITE_IOERR`, `disk I/O error` or lost-lock messages; `hzcode session reindex` `[planned]` finds gaps.
- *Diagnosis:* the check reports the filesystem type and mount options for the workspace and the state root. Treat any network filesystem (NFS, SMB, SSHFS, some FUSE layers) as unsupported for SQLite-backed state: locking and `fsync` semantics are not reliable enough for an event log (`/data/home/forge/hzcode/docs/24-feature-catalog.md` A.2 records the reference implementation's own NFS migration work).
- *Action:* move the state root to a local disk (storage-root setting) and re-run `hzcode doctor --strict`, which fails until the state root is local. If the *workspace* must live on a network filesystem, that is allowed — the workspace is files, not state — but the state root MUST NOT follow it. Do not use `--allow-network-fs` as a permanent fix; it is an explicit, documented best-effort escape hatch that MUST appear in the session posture and in `hzcode session verify` output.

**RN-6 — Provider outage and fallback.**
- *Symptoms:* model calls fail or time out; `hz.error.raised` with class `provider`; a step ends without a completion; a confusing mixture of retries across models.
- *Diagnosis:* `hzcode doctor --online` for reachability per configured provider; the provider layer's error taxonomy distinguishes authentication, rate limit, quota, transport and malformed-response failures; the session log shows which fallback, if any, was taken and by which policy. Check that no `UNKNOWN` effect was produced by the outage itself — an outage is a *failed* call, not an unprovable effect, unless the request was already sent when the connection died, in which case the honest outcome is `UNKNOWN` (RN-2 applies).
- *Action:* rate limits and transport errors MAY fall back along the configured model chain; authentication and quota errors MUST NOT silently switch models (they are configuration problems, exit `2`). Fallback choices are recorded per step so cost and quality regressions are attributable. If a provider stays down, pin the run to a working model set for the session rather than editing global config under incident pressure.

**RN-7 — Schema migration blocked.**
- *Symptoms:* startup refuses with a schema error; `doctor` `state.migrations` fails; exit `3`. Typical causes: the database was written by a newer binary (downgrade), a migration partially applied after a crash, or a migration gated behind a flag that is off.
- *Diagnosis:* compare `state.db`'s recorded schema revision with `version.schemaRevision` from `hzcode version --json`; inspect the migration ledger for an uncommitted or half-applied entry; decide whether this is a *forward* migration (needs a newer binary: update) or a *backward* one (the data is newer than the code).
- *Action:* forward case — update to the version that owns the schema, never hand-edit tables. Backward case — fail closed: stop, keep the database intact, and either use the newer binary or restore from the pre-migration snapshot; do not "fix" the revision marker. Partial migration — the ledger decides whether the transaction committed; if it did not, re-running the migration is safe and MUST be the only automated repair, behind `hzcode doctor --fix state.migrations` `[planned]` with a snapshot taken first. Never downgrade by deleting the database.

**RN-8 — Plugin crash loop.**
- *Symptoms:* the plugin host restarts in a tight loop; sessions stall at `plugins.invoke`; `hz.error.raised` with class `plugin`; possibly a supervisor lease that never releases.
- *Diagnosis:* `doctor` `plugins.manifests` for signature/capability problems (a manifest that fails verification explains most loops); the plugin host's crash record; the kernel's supervision log for lease state. Confirm this is a plugin crash and not a provider or sandbox denial masquerading as one.
- *Action:* the host MUST trip a circuit breaker after 3 crashes in 60 s and MUST mark the plugin disabled for the session rather than retry indefinitely; affected tool calls then end as `failed`, not `UNKNOWN` (an unavailable dependency is a failure, not an unprovable effect — RC-7). Disable the plugin explicitly, report it in `hzcode session verify`, and require a signed manifest plus a successful smoke before re-enabling. A crash loop MUST NOT be able to hold a lease: the supervisor reclaims it and records the reclamation.

## 3. Interfaces

Operations owns the commands, files and settings below. Anything not listed here but used by these flows (kernel protocol, event schema, policy files) belongs to another document and is cited, not redefined.

### 3.1 Commands

| Command | Purpose | Key flags | Exit codes (RC-5) | Status |
|---|---|---|---|---|
| `hzcode version` | Identity of this install: `{ version, channel, commit, kernelDigest, HZ_PROTO, HZ_ABI, schemaRevision }` (R-ops-9). | `--json` | 0; 3 if the kernel digest cannot be resolved | `[planned]` |
| `hzcode doctor` | Run the §2.6.1 check set; read-only (R-ops-42). | `--json`, `--online`, `--strict`, `--fix <check>` | 0 ok/warn; 2 usage/config; 3 any fail-closed check fails | `[planned]` |
| `hzcode update` | Self-update of CLI + kernel per R-ops-62. | `--check`, `--staged`, `--apply`, `--offline --from <dir>`, `--pin <version>`, `--rollback`, `--channel <stable\|beta\|nightly>` | 0; 1 `update_busy`/swap failure after rollback; 2 usage; 3 verification failure | `[planned]` |
| `hzcode support-bundle` | Build or verify a redacted diagnostics archive (R-ops-43). | `--out <path>`, `--since <ts>`, `--verify <file>`, `--include-prompts` (interactive confirmation required) | 0; 1; 2 path/permission | `[planned]` |
| `hzcode bench` | Run a benchmark suite from `ops/bench/suites.toml`. | `--suite <name>`, `--profile <preset>`, `--baseline <file>`, `--record <file>` | 0; 1 regression; 2 setup | `[planned]` |
| `hzcode release verify <manifest>` | Offline verification of a release manifest, its signatures, digests, SBOM and attestation references. | `--offline`, `--json` | 0; 3 any integrity failure | `[planned]` |
| `hzcode session verify <id>` | Cited here because RN-2 and several gates consume it; its full definition belongs to the sessions/state document. | — | per that document | `[planned]` |
| `ops/gates/run.ts <gate>` | The single gate entry point, identical locally and in CI (R-ops-33). | `--json`, `--lane <lane>`, `--waiver-check` | 0 PASS/WAIVED; 1 FAIL; 2 gate misconfigured | `[planned]` |
| `hzcode config show --origin` | Explain the effective configuration: value + layer + revision that set it (§12.1, R-ops-81). | `--json`, `--origin` | 0; 2 unknown key | `[planned]` |
| `hzcode audit export` / `hzcode audit verify <bundle>` | Export or verify the audit stream with receipt-chain and OwnerLog-chain checks (§12.3). | `--since`, `--out`, `--tenant` | 0; 3 verification failure | `[planned]` |
| `hzcode observe dashboard` | Local read-only OTel dashboard, loopback-bound by default (§14, R-ops-111). | `--bind`, `--port` | 0; 2 bind/config failure | `[planned]` |
| `hzcode run --cpu-profile[=<file>]` / `--heap-profile[=<file>]` | Host profiling flags, absent from default builds' behaviour and never tool-exposed (§13, R-ops-102, R-ops-104). | `--heap-profile-after=<n>` | 0; 2 profiling unavailable in this build | `[planned]` |

### 3.2 Files and settings operations owns

| Path | Kind | Owner | Purpose |
|---|---|---|---|
| `/data/home/forge/hzcode/ops/budgets.toml` | registry | ops | Every numeric budget in the project (R-ops-48, §8). |
| `/data/home/forge/hzcode/ops/kernel-pin.toml` | pin | ops | The `hzk` digest(s) this revision of the CLI expects (R-ops-4). |
| `/data/home/forge/hzcode/ops/kernel-compat.toml` | matrix | ops | CLI↔kernel compatibility set (R-ops-11, R-ops-12). |
| `/data/home/forge/hzcode/ops/release.lock` | lockfile | ops | Toolchain + dependency pin set for reproducible builds (R-ops-15, R-ops-22). |
| `/data/home/forge/hzcode/ops/release-manifest.json` | artifact | ops | `ReleaseManifestV1`, the single release authority (R-ops-21). |
| `/data/home/forge/hzcode/ops/gates/<gate>.toml` | gate config | ops | Timeouts, lane, fixture paths, non-waivable flag (R-ops-26…R-ops-32). |
| `/data/home/forge/hzcode/ops/gates/waivers/<gate>.toml` | waiver | ops | The only exception mechanism (R-ops-31). |
| `/data/home/forge/hzcode/ops/install.sh` | installer | ops | Verified standalone install (R-ops-3). |
| `/data/home/forge/hzcode/ops/homebrew/hzcode.rb` | formula | ops | Homebrew channel (R-ops-5). |
| `/data/home/forge/hzcode/ops/docker/Dockerfile` | image | ops | Docker channel (R-ops-7). |
| `/data/home/forge/hzcode/flake.nix` | build | ops | `.#hzcode` output (R-ops-6). |
| `/data/home/forge/hzcode/ops/bench/suites.toml`, `/data/home/forge/hzcode/ops/bench/baseline/` | benchmark | ops | Suites and ratcheted baselines (R-ops-49, R-ops-52). |
| `/data/home/forge/hzcode/packages/provider/src/prices.json` | data | provider, ops-signed-off | Append-only price table (R-ops-68). |
| `/data/home/forge/hzcode/ops/pricecheck.ts` | tool | ops | Price-table and gap verification (R-ops-69). |
| `~/.config/horizon/budgets.toml` | user config | user | User-level budget ceilings (R-ops-71). |
| `.hz/budgets.toml` | workspace config | user | Workspace budget ceilings; narrowing only (R-ops-71). |
| `~/.config/horizon/install-journal.jsonl` | journal | ops | Install/update/rollback history, append-only. |
| `~/.local/state/horizon/` | state root | ops | Traces, crash records, bench results, staging; name addition required in `_conventions.md` §1 (R-ops-74). |
| `~/.config/horizon/support/` | output | ops | Default location for `hzcode support-bundle` output. |

Environment settings owned here: `HZ_LOG` (R-ops-46), `HZ_OTEL_EXPORT` (R-ops-34), `HZ_OTLP_ENDPOINT` (only read when the mode is `otlp`), `HZ_UPDATE_CHANNEL`, `HZ_TELEMETRY` (must be an explicit `1`/`on`, never inferred, R-ops-40).

### 3.3 What operations does *not* own

Kernel semantics, capability IDs, guard decisions, receipts and the ABI live in the authority documents and `_conventions.md`. Exit codes are owned by `/data/home/forge/hzcode/docs/14-surfaces.md` §2.2 (S16) and are only referenced here. Event names are owned by `_conventions.md` §6; operations MUST NOT introduce a session event, and its own bookkeeping (install journal, retention markers, bench results) MUST stay outside the session event log (RC-2, RC-3).

---

## 4. Data

### 4.1 What diagnostics write, and where

| Artifact | Path | Format | Retention |
|---|---|---|---|
| Local trace | `.hz/traces/<session-id>.jsonl` (workspace) or `~/.local/state/horizon/traces/<session-id>.jsonl` | `TraceRecordV1`, JSONL, append-only (§2.5.1) | 14 days default; counts toward RN-4 reclamation first |
| Doctor report | stdout / `--json`; not persisted unless requested | `DoctorReportV1` | n/a |
| Support bundle | `~/.config/horizon/support/<timestamp>/hzcode-support-<ts>.tar.zst` | `.tar.zst` + `manifest.json` + `redaction-report.json` (R-ops-43) | user-owned; never auto-created, never auto-deleted |
| Crash record | `~/.local/state/horizon/crash/crash-<ts>.json` | `CrashRecordV1` + redacted trace tail | 30 days or 50 records, whichever is smaller |
| Install journal | `~/.config/horizon/install-journal.jsonl` | `InstallJournalV1`, append-only, rotated at 1 MiB | kept (audit trail of what ran on this machine) |
| Bench results | `~/.local/state/horizon/bench/<ts>.jsonl` (local); `ops/bench-results.jsonl` (CI, committed per release) | `BenchResultV1` | CI results kept per release; local results 30 days |
| Update staging | `~/.local/state/horizon/staging/<version>/` | artifact bytes + verified manifest copy | deleted on successful swap or rollback; a leftover staging dir is itself a `doctor` finding `[planned]` |

### 4.2 Rules for this data

- Every artifact above is written by `redact()`-passed records only (R-ops-38); a diagnostic writer that bypasses redaction is a gate failure.
- No artifact in this table contains secrets, prompt text or file contents by default; the only exception is an explicitly confirmed `hzcode support-bundle --include-prompts`, which MUST mark itself in `redaction-report.json` and MUST print a warning naming the file it just produced.
- Bundles are self-verifying: `manifest.json` lists `path`, `sha256`, `bytes` and `source` for every entry; `--verify` recomputes them (R-ops-43).
- The state root is local-disk only (RN-5). Diagnostics MUST NOT write into the workspace except `.hz/traces/`, and MUST NOT write into a repository tracked by git.
- Nothing in this section is a session event; retention and bookkeeping are storage/kernel metadata per RC-3.

## 5. Errors & failure modes

Exit codes are the canonical table from `/data/home/forge/hzcode/docs/14-surfaces.md` §2.2 (S16, RC-5): `0` success · `1` error · `2` usage/config/environment · `3` unprovable/fail-closed · `4` policy denial · `5` budget · `130`/`143` signals. Operations MUST NOT invent codes; it MUST use one of these and a named reason code below.

| Reason code | Exit | Trigger | Behaviour | Fail-closed? |
|---|---|---|---|---|
| `kernel_asset_missing` | 3 | `hzk` not present at the resolved path | Refuse to start any effect path; `version`/`doctor` still work; RN-1. | **yes** |
| `kernel_digest_mismatch` | 3 | Kernel bytes differ from the pin | Refuse and report both digests; never "use it anyway" (R-ops-4). | **yes** |
| `kernel_abi_incompatible` | 3 | CLI and kernel revisions outside the compatibility set | Refuse; mixed pairs are a tested, expected failure (R-ops-12, ADR-002). | **yes** |
| `kernel_handshake_failed` | 3 | Kernel starts but does not answer `ping`/`caps` | Refuse; treat as corrupt install (RN-1). | **yes** |
| `update_signature_invalid` | 3 | Manifest or artifact signature fails | Abort before any write to the install; existing install untouched (R-ops-63). | **yes** |
| `update_digest_mismatch` | 3 | Staged artifact digest differs from manifest | Abort; discard staging; journal `update_failed`. | **yes** |
| `update_swap_failed` | 1 | Rename/flip fails mid-swap | Automatic rollback to the previous version; if rollback itself fails, the install is reported broken with RN-1 steps. | no (recoverable) |
| `update_busy` | 1 | A session holds an execution claim | Refuse; no `--force` exists (R-ops-67). | no |
| `update_offline_missing` | 2 | `--offline --from <dir>` lacks a manifest or artifact | Refuse with the missing path. | no |
| `doctor_check_failed` | 3 | Any fail-closed check in §2.6.1 fails | Report all checks, then exit 3 (`--json` still emitted). | **yes** |
| `state_db_unusable` | 3 | Integrity check fails or schema revision is unreadable | Refuse to open; RN-7; the file is preserved, never auto-deleted. | **yes** |
| `schema_migration_blocked` | 3 | Forward migration unavailable or a downgrade is required | Refuse; snapshot first; no silent repair (RN-7). | **yes** |
| `network_fs_state_root` | 3 under `--strict`, warn otherwise | State root is on NFS/SMB/FUSE | Warn with the mount evidence; `--strict` refuses (RN-5). | partially |
| `disk_full` | 1 | `ENOSPC` on state, trace or artifact write | Fail the write; never truncate the event log; RN-4. | no |
| `bundle_write_failed` | 2 | Output path unwritable or verification fails | Fail the bundle; a partially written archive MUST NOT be reported as produced. | no |
| `crash_record_write_failed` | 1 | State root unwritable during crash handling | Print the pointer to stderr; never suppress the original crash. | no |
| `gate_timeout` | 1 (CI) | A gate exceeds its §8 timeout | FAIL, never skip (R-ops-29). | **yes** (CI) |
| `gate_misconfigured` | 2 (CI) | Missing fixture, missing timeout, unknown gate name | FAIL; a gate with no fail fixture is a build failure (R-ops-27). | **yes** (CI) |
| `waiver_expired` | 1 (CI) | A waiver past its `expires` date | FAIL; no renewal without a new review (R-ops-31). | **yes** (CI) |
| `pricecheck_gap` | 1 (CI) / warn (local) | A configured provider model has no price row and no explicit `null` with reason | FAIL; never guess a price (R-ops-69). | **yes** (CI) |
| `plugin_crash_loop` | 1 | Plugin host crashes ≥ 3 times in 60 s | Circuit-break; plugin disabled for the session; calls end `failed`, not `UNKNOWN` (RN-8). | no |
| `provider_unavailable` | 2 when auth/quota, warn otherwise | Reachability or call failure | Auth/quota never silently falls back; transport/rate-limit may fall back along the configured chain (RN-6). | no |
| `cost_unknown` | — (display rule) | A cost figure whose `priceTableDigest` is missing | The number MUST NOT be displayed; show `UNKNOWN` with the reason (R-ops-70). | n/a |

Two structural failure modes deserve naming because they are silent by construction:

1. **Diagnostics leaking.** A diagnostic path that writes an unredacted record fails open exactly once and permanently. Mitigations: single emission boundary (R-ops-38), canary gate (`gate:log-redaction`), and the rule that new sinks MUST be added as `redact()`-callers rather than as direct writers.
2. **Gate erosion.** A gate that is skipped, timed out, or silently waived looks identical to a passing gate in a green summary. Mitigations: one verdict line per gate (R-ops-26), timeout = FAIL (R-ops-29), waivers with expiry (R-ops-31), and `gate:gate-selftest` (R-ops-27) run on every full lane.

---

## 6. Flows

### F1 — Release: from tag to publish

1. A release owner creates an annotated tag `v<semver>` on `main` (or a release branch for a patch on an older minor).
2. CI verifies the tag is signed, the commit is on `main`/release branch, and the working tree is clean (R-ops-22).
3. The build job reads `ops/release.lock` and builds CLI, kernel asset and sidecars for the full cross-platform matrix. Build inputs are recorded in the provenance attestation (R-ops-20).
4. Gates run in release mode: `gate:kernel-pin`, `gate:cross-plane-abi`, `gate:receipt-coverage`, `gate:no-unknown-retry`, `gate:doc-status`, `gate:secret-scan`, `gate:unit`, `gate:integration`, `gate:adversarial`, `gate:cache-guard`, `gate:cross-platform-matrix`, `gate:kernel-abi-compat`, `gate:gate-selftest`. Waivers MUST NOT be honored on a tag build (R-ops-31).
5. `gate:release-integrity` assembles `ops/release-manifest.json`: artifact digests, kernel pin, `HZ_PROTO`/`HZ_ABI`, channel, SBOM references, attestation references, `reproducible` flag (R-ops-21).
6. Signatures are produced for manifest and artifacts; the SBOM is generated per artifact (R-ops-18, R-ops-19).
7. If `reproducible: true`, an independent builder performs the byte comparison (`gate:reproducible`); a mismatch downgrades the flag in the same change or blocks the release (R-ops-15, R-ops-24).
8. `gate:install-smoke` installs every channel in a container and asserts identical bytes and declared install roots (R-ops-1…R-ops-8).
9. Publish: artifacts, manifest, SBOM, attestations, sidecars and the generated changelog are attached to the release; package-manager metadata (npm, Homebrew, cargo, nix, image tag) is updated by a bot PR that references the manifest digest.
10. Post-publish verification: a clean machine installs from npm and from `install.sh`, runs `hzcode version --json` and `hzcode doctor`, and asserts the digests equal the manifest. A failure quarantines the release and publishes a rollback notice (R-ops-16, R-ops-17).
11. The release is announced on the channel; nightly and beta artifacts are built by the same pipeline with `channel` set accordingly (R-ops-14).

### F2 — Self-update

1. `hzcode update --check` reads `HZ_UPDATE_CHANNEL` (default `stable`) and prints current → candidate versions plus what will change (`HZ_PROTO`/`HZ_ABI`, kernel digest). Nothing is downloaded.
2. On a real update, the manifest is fetched and its signature verified before any payload is read (R-ops-62 step 3).
3. Artifacts for this platform are downloaded into the staging directory and each is digest- and signature-verified; a mismatch aborts with exit 3 and deletes staging (R-ops-63).
4. The command checks for an active execution claim; if one exists it reports `update_busy` and exits 1 without touching anything (R-ops-67).
5. `--staged` stops here and records the verified staging set; otherwise the swap proceeds.
6. Atomic swap of the version directory plus symlink flip, CLI and kernel together (R-ops-64).
7. Post-swap smoke: `hzcode version --json` (kernel digest matches), kernel handshake, and the fast doctor subset. On failure, automatic rollback (R-ops-65) and a journal entry.
8. On success the previous version is retained for rollback, stale staging is removed, and the install journal records `from`, `to`, `channel`, `manifestDigest`, `result`.
9. `--pin <version>` prevents auto-update from crossing that version; `--rollback` re-verifies and re-installs the retained previous version.

### F3 — `hzcode doctor` diagnosing a broken kernel

1. The operator reports "nothing works"; `hzcode doctor` starts and evaluates checks in the §2.6.1 order, reading `hzcode version --json` first so every later line can name the kernel digest (R-ops-9, R-ops-47).
2. `kernel.asset` resolves the kernel path and compares its digest to the CLI's pin. Three outcomes: missing → `kernel_asset_missing`; different → `kernel_digest_mismatch`; equal → continue.
3. `kernel.abi` compares `HZ_ABI`/`HZ_PROTO`; a mixed pair is reported as a compatibility failure with the supported set from `ops/kernel-compat.toml` (R-ops-12).
4. `kernel.exec` starts the kernel and performs the `ping`/`caps` handshake; a timeout or non-answer is `kernel_handshake_failed` (often a sandbox or exec-bit problem — the check reports the sandbox backend's verdict so the operator can tell them apart).
5. `sandbox.backends` reports the platform backend and the guarantee vector so a refusal caused by confinement is not misread as a broken binary.
6. `state.db` and `state.migrations` distinguish "kernel is fine but the database is not" from the kernel cases (RN-7).
7. The report prints one line per check plus the fix hint that names the relevant runbook (RN-1 for kernel cases). `--json` emits `DoctorReportV1` for a support ticket; `hzcode support-bundle` collects it with versions and redacted logs (R-ops-43).
8. Exit is `3` whenever a fail-closed check failed, so scripts and CI cannot mistake a broken kernel for a healthy install.

### F4 — Incident response for a security report

1. **Intake (day 0).** A report arrives through the private channel (R-ops-54). A single responder acknowledges within 3 working days, opens a restricted tracking item, and classifies: authority boundary (R-ops-60), supply chain (kernel/update path), sandbox escape, data exposure (redaction failure), or ordinary bug.
2. **Triage (day 0–3).** Reproduce on the earliest affected release; determine whether the issue is in the design or an implementation defect; identify affected `HZ_PROTO`/`HZ_ABI` revisions and versions.
3. **Contain (immediately, when authority is implicated).** Apply the kill-switch configuration for the affected capability (R-ops-60), publish an advisory stub without exploit detail, and — for supply chain — verify the pin, signature and attestation of every published artifact before anything else.
4. **Fix.** Land the fix behind the ordinary gates, with a regression test that fails on the old behaviour; the fix MUST NOT widen a capability, and any new capability need goes through an ADR.
5. **Release.** Cut a patch release on the supported minors (F1); the advisory links the fixed versions and the mitigation for unreleased deployments. Release notes MUST name the advisory id.
6. **Disclose.** Publish the advisory with CVE/GHSA where warranted; honour the 90-day clock or the agreed shorter window; credit the reporter unless they decline.
7. **Learn.** Within one release, revise the threat model if a change of the kinds named in R-ops-59 occurred, add the failure to the adversarial fixtures (`gate:adversarial`), and — for redaction or diagnostic leaks — extend the canary set of `gate:log-redaction`.

### F5 — Gate exception (waiver) flow

1. A contributor hits a failing waivable gate and determines it is unrelated to their change.
2. They open an issue describing the failure, then add `ops/gates/waivers/<gate>.toml` with `owner`, `reason`, `expires` ≤ 30 days, `issue` (R-ops-31).
3. CI prints `gate:<name> WAIVED` and requires the file to match the gate (a waiver for a non-waivable gate is `gate_misconfigured`, exit 2).
4. Reviewers MUST NOT approve a waiver whose reason restates the failure instead of explaining why the gate is wrong or temporarily unusable.
5. On expiry the gate fails again automatically, and renewal requires a new decision with new evidence (`waiver_expired`).

### F6 — Performance regression investigation

1. `gate:perf-regression` fails on the nightly lane and names the suite, metric, baseline value, candidate value and the run ids.
2. The owner reproduces locally with `hzcode bench --suite <name> --profile <preset>` on the same runner class; a local result that does not reproduce the delta is recorded as such and the CI runner class is investigated instead.
3. Bisect via the run history attached to the suite; the metric's four lines (R-ops-50) determine whether the regression is real (same population, same anchors) or a measurement artefact.
4. A real regression is either fixed or, if accepted deliberately, landed with `--update-baseline` and a rationale plus run id in the commit (R-ops-52).
5. Baseline changes appear in the release notes under "performance" with the metric definition, so the number is never quoted without its four lines.

---

## 7. Security & authority

### 7.1 Capability surface

Operations exposes almost no capability surface, deliberately. The kernel is the only effect authority, and the operations commands are host operations of origin `UserAction` (R-ops-61).

| Action | Capability ID | Origin | Narrowing |
|---|---|---|---|
| `hzcode update` (fetch manifest/artifacts) | `net.fetch` | `UserAction` only | Hosts restricted to the manifest-declared release host; mirrors allowed only because content is digest-verified (R-ops-58) |
| `hzcode update` (install/swap) | `files.write` | `UserAction` only | Writes only under the install prefix and the state root's `staging/` (R-ops-8) |
| `hzcode doctor` | none | `UserAction` | Read-only; no network without `--online` (R-ops-42) |
| `hzcode support-bundle` | none (host read) | `UserAction` | Reads only state/trace/log artifacts it owns; redaction applies (R-ops-43) |
| `hzcode bench` | none (host run) | `UserAction` | Runs local fixtures; no network in the default suites (R-ops-28) |
| OTLP export | `net.fetch` | operator setting | Only with `HZ_OTEL_EXPORT=otlp` and an explicit endpoint; one endpoint, allow-listed, never inferred (R-ops-34, R-ops-40) |
| Cost dashboard collection | `net.fetch` | `ManagedRun`/server config | Opt-in; endpoint from managed policy or explicit config; payload restricted to counts/tokens/micros (R-ops-72) |

Nothing in this table is reachable from a model batch. A session cannot update its own kernel, cannot change the OTEL endpoint, cannot raise telemetry consent, and cannot read the support bundle of another workspace. Those are properties of the authority split, not of prompt text.

### 7.2 Authority boundaries this document enforces

1. **The kernel cannot be replaced by anything in the session.** No tool, plugin, MCP server or workflow step has a path to `hzcode update`; the digest pin (R-ops-4) means even a substituted binary is refused rather than adopted.
2. **Release integrity is not waivable.** §2.3 and `gate:kernel-pin` are outside the exception mechanism (R-ops-25, R-ops-30, R-ops-58).
3. **Diagnostics cannot escalate.** `doctor` is read-only (R-ops-42) and never repairs implicitly; `--fix` names exactly one check.
4. **Redaction fails closed.** Unknown field types are dropped, not passed through (R-ops-38).
5. **Telemetry cannot be turned on by convenience.** No `--yes`, no CI variable, no default endpoint (R-ops-40).
6. **`UNKNOWN` cannot be eliminated by operations.** Reconciliation is kernel-owned; operations only reports it (RN-2) and the gate `gate:no-unknown-retry` forbids the shortcut.

### 7.3 Threat assumptions

The threat model itself belongs to the authority/safety document (R-ops-59); this document records only the operational assumptions it depends on: the build host is trusted at tag time and attested afterwards; the operator's machine may be compromised, which is why signature verification happens locally and offline (R-ops-18) and why the kernel digest is compared, not believed; the network is hostile, which is why mirrors are allowed only with digest equality; the price table and the doc set are reviewed artifacts, not runtime inputs.

---

## 8. Performance budgets

Every number below is a *citation* of a key in `/data/home/forge/hzcode/ops/budgets.toml` `[planned]` (R-ops-48). Because that file does not exist yet, this table is the design intent; when the file lands, the table's numbers MUST be generated from it, and any divergence is a `gate:lane-budget` failure. All figures are `[planned]` targets, not measurements — none has been observed.

### 8.1 CI wall-clock targets

| Lane | Trigger | Wall-clock target | Hard ceiling |
|---|---|---|---|
| PR fast lane | every PR | ≤ 12 min | 20 min |
| PR full lane | path-mapped (R-ops-32) | ≤ 45 min | 70 min |
| Nightly (incl. cross-platform and perf) | scheduled | ≤ 90 min | 150 min |
| Release (matrix + sign + SBOM + attestation + install smoke) | tag | ≤ 120 min | 180 min |
| Daily dependency/advisory lane | scheduled | ≤ 20 min | 40 min |

### 8.2 Gate timeouts

A gate exceeding its timeout is a FAIL (R-ops-29).

| Gate | Timeout | Gate | Timeout |
|---|---|---|---|
| `gate:unit` | 900 s | `gate:cross-platform-matrix` | 2700 s |
| `gate:integration` | 1800 s | `gate:kernel-abi-compat` | 600 s |
| `gate:boundary-test` | 300 s | `gate:perf-regression` (per suite) | 1200 s |
| `gate:adversarial` | 1500 s | `gate:install-smoke` | 1800 s |
| `gate:cache-guard` | 180 s | `gate:secret-scan` | 300 s |
| `gate:tool-declaration` | 120 s | `gate:dependency-policy` | 600 s |
| `gate:event-catalogue-parity` | 60 s | `gate:pricecheck` | 300 s |
| `gate:parity-ratchet` / `gate:frontend-parity` | 240 s | `gate:doc-status` / `gate:doc-names` / `gate:doc-template` | 60 s each |
| `gate:prompt-governance` | 120 s | `gate:release-integrity` | 600 s |
| `gate:import-boundary` / `gate:layering` | 240 s | `gate:attestation-subject` | 120 s |
| `gate:log-redaction` | 300 s | `gate:gate-selftest` | 600 s |
| `gate:reproducible` | 3600 s | `gate:lane-budget` | 30 s |
| `gate:changelog` / `gate:clean-build` | 60 s each | `gate:sbom` | 300 s |
| `gate:gate-hermeticity` | 600 s | `gate:notice` / `gate:provenance` | 120 s each |

### 8.3 Command budgets

| Command | Budget | Notes |
|---|---|---|
| `hzcode version` | ≤ 150 ms p95 | Must not start the kernel. |
| `hzcode doctor` (offline, warm) | ≤ 2.0 s p95 | Excludes `state.db` integrity check on a large database, which is capped at 10 s and reported separately. |
| `hzcode doctor` (cold, first run) | ≤ 8.0 s p95 | |
| `hzcode doctor --online` | ≤ 15 s total, 3 s per provider | Providers probed in parallel; a timeout is a `warn`, not a hang. |
| `hzcode update --check` | ≤ 2.0 s p95 | Manifest fetch plus signature verification only. |
| `hzcode update` (download) | ≤ 60 s at 10 Mbit/s | Measured for the CLI+kernel payload; verification adds ≤ 2 s. |
| `hzcode update` (swap + smoke) | ≤ 5.0 s | Fail-fast smoke subset only. |
| `hzcode support-bundle` | ≤ 20 s, ≤ 25 MiB raw, ≤ 8 MiB compressed | On a 30-day-old workspace with default retention. |
| Trace write overhead | ≤ 2 % of step wall-clock | Measured by `hzcode bench --profile stream-latency`. |
| Perf regression thresholds | baseline stability ≤ 3 % p50; fail on p50 +5 % / p95 +10 % | R-ops-51. |

### 8.4 Benchmarks

Suites (R-ops-49) cover: CLI cold start, TUI startup to first frame, step stream latency against a recorded provider, tool round-trip (read/edit/shell) against a local fixture repo, session replay of a 1 000-event log, `doctor` runtime, and release verification of a 4-artifact manifest. Each suite records the runner class; results are only comparable within a class. No number from this section may be published in user-facing documentation without its run id and the four metric lines of R-ops-50.

---

## 9. Tests

### 9.1 How the gates themselves are tested

| Test | What it proves | Status |
|---|---|---|
| `gate:gate-selftest` `[planned]` | Every registered gate has a pass fixture (PASS), a fail fixture (FAIL), emits the one-line verdict, has a timeout from §8.2, and a waiver-policy entry matching R-ops-30. | `[planned]` |
| `packages/testing/src/gates/timeout.test.ts` `[planned]` | A deliberately slow fixture gate fails on timeout and is never reported as skipped (R-ops-29). | `[planned]` |
| `packages/testing/src/gates/waiver.test.ts` `[planned]` | An expired waiver produces `waiver_expired`; a waiver for a non-waivable gate produces `gate_misconfigured` (R-ops-30, R-ops-31). | `[planned]` |
| `packages/testing/src/gates/hermeticity.test.ts` `[planned]` | A gate that opens a socket is detected and fails the network-off fast lane (R-ops-28). | `[planned]` |
| `gate:doc-status` fixtures `[planned]` | A fixture document claiming `VERIFIED` with no evidence fails; a row without an evidence column fails (R-ops-75). | `[planned]` |
| `gate:log-redaction` canaries `[planned]` | Canary secrets and canary prompt strings injected into a fixture session never appear in traces, logs, crash records or bundles (R-ops-35, R-ops-38, R-ops-43). | `[planned]` |
| `gate:lane-budget` `[planned]` | §8's numbers and `ops/budgets.toml` agree, and no document restates a budget without citing its key (R-ops-48). | `[planned]` |
| `gate:event-catalogue-parity` fixtures `[planned]` | An event emitted but not in `_conventions.md` §6 fails, and an operation's bookkeeping record is not mistaken for an event (RC-2, RC-3). | `[planned]` |
| `gate:import-boundary` fixtures `[planned]` | A deep import into another package's `src/` and an import of kernel internals from TS both fail. | `[planned]` |
| `gate:prompt-governance` fixtures `[planned]` | A template edit without a change record fails; a prompt assembled outside the embedding path fails. | `[planned]` |
| `gate:kernel-abi-compat` fixtures `[planned]` | Every pair in `ops/kernel-compat.toml` is exercised; out-of-set pairs fail closed with exit 3 (R-ops-12, ADR-002). | `[planned]` |

### 9.2 How the flows are tested

| Flow | Test | Status |
|---|---|---|
| F1 release | A dry-run release against a synthetic tag in a CI sandbox, asserting manifest contents, signatures, SBOM presence and install-smoke results `[planned]`. | `[planned]` |
| F2 self-update | `update-flow.test.ts`, `swap-crash.test.ts`, `update-rollback.test.ts`, `update-busy.test.ts`, `update-origin.test.ts` `[planned]`. | `[planned]` |
| F3 doctor | `doctor.test.ts` and `doctor-readonly.test.ts` against a matrix of broken fixtures: missing kernel, wrong digest, mixed ABI, unreadable database, non-local state root `[planned]`. | `[planned]` |
| F4 incident | A tabletop exercise against `ops/security/disclosure-checklist.md`; the kill-switch fixture of R-ops-60 asserts the capability is refused while disabled `[planned]`. | `[planned]` |
| F5 waiver | Covered by `waiver.test.ts` (F5 is the human half of the same mechanism) `[planned]`. | `[planned]` |
| F6 perf | A synthetic regression injected into a suite must be caught with the correct metric, baseline and run ids `[planned]`. | `[planned]` |

No test in this section has been written or run. There is no CI, no `ops/` directory and no `hzcode` binary in this repository today.

---

## 10. Status

Every capability described by this document is `DESIGNED`. The evidence column cites the design artifact, not a working implementation. Per `_conventions.md` §8, nothing here may be read as a claim above `DESIGNED`, and `UNKNOWN` is used where a fact is genuinely not yet known.

| Capability | Level | Evidence |
|---|---|---|
| Distribution channels (npm/bun, `install.sh`, Homebrew, cargo, nix, Docker, debug sidecars) | `DESIGNED` | §2.1, §3; channel inventory from `/data/home/forge/hzcode/README.md` §3.8 ("Distribution — single static binary; npm/brew/apt/scoop/nix/docker; auto-update with digest pinning; signed releases with debug sidecars") |
| Kernel asset co-delivery, digest pinning and signature | `DESIGNED` | R-ops-4, R-ops-18, R-ops-21, R-ops-58; `gate:kernel-pin` in `/data/home/forge/hzcode/docs/24-feature-catalog.md` §3.5 |
| Versioning policy, release trains, channels, rollback | `DESIGNED` | §2.2; `HZ_PROTO`/`HZ_ABI` naming from `/data/home/forge/hzcode/docs/_conventions.md` §1 |
| Release integrity (signing, SBOM, provenance, reproducibility) | `DESIGNED` | §2.3; reproducibility is deliberately left as a declared flag (R-ops-15) rather than an assumed property |
| Gate catalog, lanes, timeouts, waiver process | `DESIGNED` | §2.4, §8.2; catalog gates from `/data/home/forge/hzcode/docs/24-feature-catalog.md` §3.5 |
| Observability (OTel, redaction, local trace, opt-in telemetry) | `DESIGNED` | §2.5; README §3.8 ("OpenTelemetry traces/metrics/logs, GenAI semantic conventions, local dashboard") |
| Diagnostics (`doctor`, support bundle, crash handling, log levels) | `DESIGNED` | §2.6; README §3.8 ("opt-in crash reports"); `doctor` as an inherited ergonomic command in `/data/home/forge/hzcode/docs/24-feature-catalog.md` A.3 |
| Performance engineering (budgets registry, harness, thresholds, presets) | `DESIGNED` | §2.7, §8; metric-discipline requirement NF-041/NF-050 in `/data/home/forge/hzcode/docs/24-feature-catalog.md` A.4 |
| Security operations (disclosure, dependency policy, secret scanning, threat-model maintenance) | `DESIGNED` | §2.8; supply-chain pinning referenced in README §3.8 |
| Update mechanism (self-update, swap, rollback, offline/staged) | `DESIGNED` | §2.9; README §3.8 ("auto-update with digest pinning") |
| Cost and budget operations (`prices.json`, `pricecheck`, budgets, opt-in dashboard) | `DESIGNED` | §2.10; append-only price table + `pricecheck` in `/data/home/forge/hzcode/docs/24-feature-catalog.md` A.4; budgets in README §3.1 |
| Docs governance (authority order, names, status law, template) | `DESIGNED` | §2.11; `/data/home/forge/hzcode/docs/_conventions.md` §1, §8, §9, §10 |
| Runbooks RN-1…RN-8 | `DESIGNED` | §2.12 |
| Every gate named `[planned]` in this document | `DESIGNED` | §2.4.1; all are `[planned]` because no CI exists |
| Implementation of any command in §3.1 | `UNKNOWN` | No `hzcode` binary, no `ops/` tree, no CI configuration exists in `/data/home/forge/hzcode` at the time of writing |
| Reproducibility of any artifact | `UNKNOWN` | Not attempted; R-ops-15 requires the claim to be explicit either way, and until then `reproducible: false` would be the only honest value |
| Threat-model document path | `UNKNOWN` | R-ops-59 names it as `docs/18-*`-class; the exact filename is not confirmed in this document |
| Enterprise controls — managed policy, SSO/OIDC, audit export, quota/rate-limit, BYO gateway, air-gap, proxy interplay | `DESIGNED` | §12; README §3.8 ("Enterprise — managed policy, MDM, SSO, audit export, quota/rate-limit policy, bring-your-own-cloud") and §3.6 (server surfaces) |
| Profiling (CPU, heap, cgroup v2 sampling, leak procedure) | `DESIGNED` | §13; the cgroup v2 / resource-sampler approach is recorded in `/data/home/forge/hzcode/docs/24-feature-catalog.md` A.8 |
| OTel metrics catalog, span attributes, sampling, local dashboard | `DESIGNED` | §14; extends R-ops-36 and R-ops-39 |
| Product performance budgets and their enforcing suites | `DESIGNED` | §15; every number is a target, none measured |
| Deprecation, migration notes, LTS and the compatibility matrix | `DESIGNED` | §16 |
| Any measured number in this document | `UNKNOWN` | No benchmark, runner class or measurement has been taken; every figure above is a design target |

---



## 11. Related documents

| Document | Relationship |
|---|---|
| `/data/home/forge/hzcode/docs/_conventions.md` | Names (`hzcode`, `hzk`, `hz://`, `HZ_PROTO`/`HZ_ABI`, capability IDs, events), status levels, document template. Wins on every name conflict (R-ops-74). |
| `/data/home/forge/hzcode/docs/02-decisions.md` | ADRs this document implements operationally: ADR-002 (fail closed on ABI mismatch), ADR-009 (cache guard), ADR-012 (receipt coverage), ADR-014 (provenance), ADR-015 (tool declarations). |
| `/data/home/forge/hzcode/docs/14-surfaces.md` | Owner of the exit-code table §2.2 (S16, RC-5) and of the surface list this document ships. |
| `/data/home/forge/hzcode/docs/24-feature-catalog.md` | Owner of the gate table §3.5 and of the capability-parity rows that several gates here reference. New gate names MUST be registered there (R-ops-26). |
| `/data/home/forge/hzcode/docs/25-roadmap-and-glossary.md` | Owns glossary entries for the names this document introduces and the sequencing of the gates it marks `[planned]`. |
| `/data/home/forge/hzcode/docs/06-events-and-flows.md` | Owns the event vocabulary and the ratified rulings RC-1…RC-4 that restrict what operations may record. |
| `/data/home/forge/hzcode/docs/10-cognition.md` | Owns the cache-guard pin rule (R65) referenced by RN-3 and RC-8. |
| `/data/home/forge/hzcode/docs/01-vision-and-superset.md` | Source of the superset claim this document does not extend: operations ships capabilities, it does not invent them. |
| `/data/home/forge/hzcode/README.md` | Product-level claims this document makes operable (install, distribution, observability, security, self-improvement boundary). |
| The authority/safety, sessions/state and observability topic documents (`docs/18-*`-class, filename `UNKNOWN` here `[planned]`) | Own the kernel semantics, the receipt/reconciliation model and the trace schema that §2.5.1 and RN-2 reference. |
| The network/egress policy document (referred to as `docs/11-*`; exact filename `UNKNOWN` here `[planned]`) | Owns the network policy decisions that §12.5–§12.7 defer to (R-ops-93, R-ops-99, R-ops-101). Operations supplies the transport facts — proxy, gateway, air-gap — and never the decision. |
| `§12`–`§16` of this document | Reference sections appended after the template's last section (R-ops-76): enterprise features, profiling, OTel detail, product budgets, release engineering. |

---

## 12. Enterprise features

Enterprise features are **operator-side controls**, not new authority. Nothing in this section lets a deployment bypass Guard, receipts, `UNKNOWN` semantics or the kernel pin. Where an enterprise setting widens what a *user* may do, it does so because the machine or the tenancy is owned by the administrator who signed the setting — and the kernel still decides every effect.

### 12.1 Managed policy

| # | Rule | Test |
|---|---|---|
| **R-ops-78** | Managed policy is a single signed document `ManagedPolicyV1` `[planned]` (JSON), distributed by MDM, a provisioning profile, a domain policy, or an explicitly configured HTTPS endpoint. It MUST carry a signature that verifies against a key pinned in the distribution, and an unsigned or unverifiable policy MUST be ignored (never partially applied) with a `doctor` warning. `ManagedPolicyV1` is admitted to `@horizoncode/protocol` like any other schema (`gate:wire-parity`). | `packages/core/test/config/managed-policy-signature.test.ts` `[planned]`. |
| **R-ops-79** | Precedence, most specific last: `managed` > `user` (`~/.config/horizon/`) > workspace (`.hz/`). The workspace may only narrow the user layer; the managed layer may set floors, ceilings, defaults and required values, including values the user layer would deny. No layer may disable: receipts, the `UNKNOWN` terminal state, the kernel pin check, redaction, or the exit-code table. | `packages/core/test/config/precedence.test.ts` `[planned]`; a fixture that sets `receipts: off` in managed policy MUST fail validation. |
| **R-ops-80** | Managed policy is applied **before** sandbox start and before any user config is read, so a policy that flips a trust decision cannot be outrun by a workspace file; a policy file that fails validation leaves the previous revision in force and is reported. | `gate:dead-lane-fail-closed`; `packages/core/test/config/policy-heal.test.ts` `[planned]`. |
| **R-ops-81** | The effective configuration MUST be explainable: `hzcode config show --origin` `[planned]` prints each effective value with the layer and revision that set it. "Why is this denied?" MUST be answerable without reading three files. | `packages/cli/test/commands/config-origin.test.ts` `[planned]`. |

### 12.2 SSO / OIDC for server and web surfaces

| # | Rule | Test |
|---|---|---|
| **R-ops-82** | Identity for `@horizoncode/server` and `@horizoncode/web` is OIDC (authorization code + PKCE). There are no local passwords when OIDC is required; a local fallback account MUST NOT exist silently. CLI-hosted local sessions are unaffected — SSO governs the *server* surfaces only. | `packages/server/test/auth/oidc-required.test.ts` `[planned]`. |
| **R-ops-83** | Claims map to a principal and roles: `sub` → stable principal id, `groups`/`roles` → the server's role model, with an explicit allow-list mapping in configuration. Role changes take effect on token refresh, not on a cached session; token TTL and refresh are configured, and a logout or revocation MUST invalidate server sessions, not just the browser cookie. | `packages/server/test/auth/role-mapping.test.ts` `[planned]`; revocation test. |
| **R-ops-84** | Authentication events (sign-in, failure, token refresh, revocation) are recorded to the audit sink (§12.3) with the subject, tenant, and outcome. A failed sign-in MUST NOT leak whether the principal exists. | `packages/server/test/auth/audit-events.test.ts` `[planned]`. |

### 12.3 Audit export

| # | Rule | Test |
|---|---|---|
| **R-ops-85** | `hzcode audit export` `[planned]` exports the audit stream — effect decisions, receipts, OwnerLog references, policy revisions, authentication events, managed-policy versions — as an append-only bundle (JSONL plus a manifest) that a third party can verify without HorizonCode. Verification (`hzcode audit verify <bundle>` `[planned]`) recomputes the receipt chain and the OwnerLog hash chain; a gap, a re-order or a broken link MUST fail verification. | `packages/testing/src/ops/audit-verify.test.ts` `[planned]`; tamper fixtures in `gate:adversarial`. |
| **R-ops-86** | Export reads through the read-only capability `audit.read` `[planned]` (read-only effect class; name addition to `_conventions.md` §5 per R-ops-74). It MUST NOT be able to mutate state, and an export MUST NOT be blocked or rewritten by a policy rule — a deployment that wants to hide audit is a deployment that must not use the export. | `packages/cli/test/commands/audit-export.test.ts` `[planned]`; capability-class check in `gate:tool-declaration`. |
| **R-ops-87** | Export payloads follow the redaction rules of §2.5: prompts, tool bodies and file contents are exported as digests plus lengths unless the deployment explicitly configures `includePayloads` in managed policy. The manifest states the redaction level so a verifier never mistakes a redacted bundle for a complete one. | `gate:log-redaction` extended to exported bundles `[planned]`. |

### 12.4 Quota and rate-limit policy

| # | Rule | Test |
|---|---|---|
| **R-ops-88** | Quotas and rate limits are declared per principal and per team in managed policy (`quota`, `rateLimit` blocks with `perMinute`, `perHour`, `perDay`, token and cost ceilings), enforced at the server and at any shared provider gateway that the deployment configures. Limits are checked before dispatch, not after, and a rejection is recorded with the principal, the limit key and the observed value. | `packages/server/test/quota/enforcement.test.ts` `[planned]`. |
| **R-ops-89** | Rejection semantics are distinct and stable: a *quota* exhaustion surfaces as HTTP `429` with `Retry-After` on the server and as exit `5` (budget, RC-5) on the CLI; a *policy* denial is exit `4`; a *rate-limit* from a vendor is a provider error handled by RN-6 and MUST NOT be reported as a budget exhaustion. | `packages/server/test/quota/status-codes.test.ts` `[planned]`. |
| **R-ops-90** | Team limits never widen an individual principal's limits beyond the team ceiling, and per-user limits never apply to a different principal's traffic. Aggregation keys are declared in one table `ops/quota-keys.toml` `[planned]` so an operator can see every counted dimension. | `packages/server/test/quota/aggregation-keys.test.ts` `[planned]`. |

### 12.5 BYO cloud and model gateways

| # | Rule | Test |
|---|---|---|
| **R-ops-91** | Custom base URLs and gateway credentials are **configuration, not code** (README §3.3: "vendor endpoints are config, not code"). A gateway MUST be declared as a provider entry with a base URL, an auth scheme (header injection, mTLS, or OIDC client credentials), and a model-id mapping table; provider implementations MUST NOT hard-code a deployment's endpoint. | `packages/provider/test/gateway/config-only.test.ts` `[planned]`. |
| **R-ops-92** | Gateway credentials live in the secret vault and are referenced by name; tokens MUST NOT appear in configuration files, in traces, or in the model-id mapping. Rotation MUST NOT require an application restart for a *next request* to pick up the new secret value. | `gate:log-redaction`; vault fixture test `[planned]`. |
| **R-ops-93** | A configured gateway does not bypass egress policy: the destination MUST be evaluated by the network policy decisions of the network/egress document (referred to here as `docs/11-*`; filename `UNKNOWN` and to be confirmed `[planned]`) whether the connection is direct or through a proxy. A gateway host that is not on the egress allow-list is denied like any other host; a proxy MUST NOT be usable as a destination-policy bypass. | `packages/provider/test/gateway/egress-interplay.test.ts` `[planned]`; needed by NF-021. |
| **R-ops-94** | Model IDs offered through a gateway come from the `models.dev` snapshot (README §3.3) or from a deployment-declared mapping file with a digest recorded in the managed policy; a gateway MUST NOT silently introduce an unlisted model id, and an unknown model id fails closed at dispatch with a named reason code. | `packages/provider/test/gateway/model-id-allowlist.test.ts` `[planned]`. |

### 12.6 Air-gapped mode

| # | Rule | Test |
|---|---|---|
| **R-ops-95** | Air-gapped mode is one switch — `airgap: on` in managed policy, or `HZ_AIRGAP=1` — that forces: no telemetry, no OTLP export, no crash-report upload, no update fetch, and refusal of every tool whose effect class is `network` or `remote` (`web_fetch`, `web_search`, `browse`, `ssh`, `remote_trigger`, MCP servers with network transports). Refusals are `denied` with a reason code, never silent no-ops. | `packages/testing/src/ops/airgap-refusal.test.ts` `[planned]`; `gate:airgap-egress` `[planned]`: a run under air-gap that opens any socket fails. |
| **R-ops-96** | Air-gapped deployments MUST be installable and updatable offline: a signed **offline update bundle** (manifest + CLI + kernel + sidecars + SBOM + attestation, digest-pinned) installed via `hzcode update --offline --from <dir>`, verified exactly as in R-ops-63. An offline bundle MUST NOT require any network step to verify. | `packages/testing/src/ops/offline-bundle.test.ts` `[planned]`. |
| **R-ops-97** | Models come from offline servers (Ollama, LM Studio, vLLM, llama.cpp — README §3.3). The `models.dev` catalog is shipped as a pre-seeded snapshot with a recorded digest; in air-gapped mode the catalog is read-only, an attempted refresh is refused rather than silently failing, and a missing model entry fails closed at dispatch (R-ops-94). | `packages/provider/test/airgap/catalog-readonly.test.ts` `[planned]`; `doctor` check `airgap.catalog` `[planned]`. |
| **R-ops-98** | Requests MUST NOT leave the machine in air-gapped mode, and the mode is visible: `hzcode doctor` reports `airgap` as a posture line, session postures record it, and `hzcode session verify` shows it, so an audit never has to infer whether egress was possible. | `doctor` fixture `[planned]`; posture test. |

### 12.7 Proxies and egress control

| # | Rule | Test |
|---|---|---|
| **R-ops-99** | Proxy configuration is transport only: `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` (and the explicit config equivalents) select how a connection is made, never where a request is allowed to go. The destination policy of `docs/11-*` is evaluated on the **requested host**, before any proxy-specific handling, and on `CONNECT` targets for tunnelled traffic. | `packages/provider/test/proxy/destination-policy.test.ts` `[planned]`. |
| **R-ops-100** | Proxy credentials are vault-referenced (R-ops-92) and MUST NOT be logged; proxy failures are reported with the proxy host (redacted of credentials) so RN-6 can distinguish "provider down" from "proxy down". A proxy that injects headers or rewrites bodies MUST NOT be assumed: responses are parsed normally and a malformed response is a provider error, never a silent fallback. | `gate:log-redaction`; `packages/provider/test/proxy/failure-attribution.test.ts` `[planned]`. |
| **R-ops-101** | Every outbound decision in a proxied or gatewayed deployment is recorded as a network policy decision (allowed/denied, destination, reason code) and counts into `hz.tool.calls`/`hz.effect.terminal` (§14) so an operator can answer "what did this machine talk to?" from local data alone. | `packages/observe/test/egress-metrics.test.ts` `[planned]`; NF-021. |

---

## 13. Profiling

Profiling exists for engineers diagnosing their own runs and for the perf lane of F6. It is a host facility with no capability ID and no tool exposure; it can never be invoked by a model batch.

| # | Rule | Test |
|---|---|---|
| **R-ops-102** | Profiling is **off in default builds and default invocations**. The profilers are compiled behind a build feature (`hz_native` cargo feature `profiling`, TS `@horizoncode/observe` flag) and enabled per run by an explicit flag (`--cpu-profile=<file>`, `--heap-profile=<file>`) or `HZ_PROFILE`. `hzcode version --json` MUST report `profiling: on|off` for the build so a profile can never be mistaken for representative of a stock run. | `gate:clean-build` asserts a stock release build has `profiling: off` `[planned]`; `packages/testing/src/ops/profiling-off.test.ts` `[planned]`. |
| **R-ops-103** | A profiled run MUST produce the same authority outcomes as an unprofiled one: same decisions, same receipts, same terminal states. Profiling MUST NOT be a path to skip a decision, shorten a lease, hide an `UNKNOWN`, or disable redaction; the profiler writes its own artifacts and never replaces the trace. | `packages/testing/src/ops/profile-parity.test.ts` `[planned]` records the same fixture run with and without profiling and diffs decision/receipt output. |
| **R-ops-104** | The heap profiler captures a snapshot on `SIGUSR2` or after `--heap-profile-after=<n>` observed steps, with a configurable sampling interval. Snapshots are written to the state root `profiles/` — never into a workspace, never into a git tree. **A heap snapshot is classified as containing prompt text and file contents**: it MUST be opt-in, MUST print a confirmation naming the output file, MUST NOT be attached to a support bundle automatically, and MUST be deleted after 7 days by default. | `packages/testing/src/ops/heap-snapshot-policy.test.ts` `[planned]`; `gate:log-redaction`-adjacent check that no snapshot path appears in a default bundle manifest. |
| **R-ops-105** | Resource sampling follows the reference kernel's approach (`/data/home/forge/repo-tour/horizoncode/kernel/src/resource_sampler.rs`, `.../cgroup_v2.rs`, recorded in `/data/home/forge/hzcode/docs/24-feature-catalog.md` A.8): periodic samples of `memory.current`, `memory.peak`, `cpu.stat`, `io.stat` and `pids.current` per session and per worker, default interval 1 s (250 ms under a profiling preset). Samples are storage/kernel metadata (RC-3) and MUST NOT be written as session events; enforcement uses cgroup v2 limits where available, and where a dimension is unavailable the sampler reports a typed residual rather than a zero — an unmeasured value is never rendered as `0`. | `packages/testing/src/ops/resource-sampler.test.ts` `[planned]`; second test asserting no `hz.*` event is emitted by sampling. |
| **R-ops-106** | The CPU profiling workflow is fixed: capture a window (default 30 s, configurable) with the Rust side profiled by the built-in sampler (eBPF/`perf` are opt-in and only when the platform backend allows), the TS side profiled by the Bun/V8 profiler; artifacts land in the state root `profiles/`; flamegraphs are rendered offline by tooling that reads those artifacts and is not part of a release build. A capture MUST NOT run concurrently with a session that holds an execution claim on another workspace without naming the target workspace explicitly. | `packages/testing/src/ops/cpu-profile.test.ts` `[planned]`. |
| **R-ops-107** | Memory-leak hunting is a written procedure with thresholds: idle → warm → steady state RSS captured at checkpoints; a suspected leak is RSS growth > 10 % across 200 steps with no proportional context growth, or `memory.current` monotonic growth under a bounded workload. Diagnosis takes three heap snapshots (before, mid, after) and diffs retention paths; kernel-side growth is attributed with the sampler of R-ops-105; containment before root-cause is an explicit worker recycle ceiling, and a recycled worker's in-flight effects MUST settle or terminate as `UNKNOWN` — recycling is never allowed to manufacture a success. | `packages/testing/src/ops/leak-procedure.test.ts` `[planned]` runs the documented steps against a deliberately leaking fixture and asserts the leak is detected within the stated thresholds. |

Profile artifacts share the redaction classification of §2.5: metadata may be shared, contents may not. A profile artifact's metadata MUST state `redaction: unredacted` so nothing downstream assumes it was cleaned.

---

## 14. OTel detail

§2.5 states the rules; this section fixes the catalog so that two implementations cannot invent different numbers for the same fact. Everything here is `DESIGNED`; no metric has been emitted.

| # | Rule | Test |
|---|---|---|
| **R-ops-108** | The metrics catalog is **closed**. Every metric has exactly one definition, one unit and a declared cardinality cap (the maximum number of distinct label-value combinations the process will keep). A metric MUST NOT be emitted with labels outside its definition. When a cap is reached, the emitting side MUST collapse the excess dimension to `other` and increment `hz.metrics.cardinality.overflow{metric}` — silent label growth is a defect, not a feature. | `packages/observe/test/metrics-catalog.test.ts` `[planned]` diffs the registry against §14.1; `gate:event-catalogue-parity` covers the metric names. |
| **R-ops-109** | Span attributes are bounded and typed. Model, provider, capability and outcome attributes are enumerated (R-ops-36); identifiers that are unbounded in principle (workspace paths, session ids, tool arguments) MUST be hashed or dropped. No attribute may exceed 256 characters; a longer value is truncated to a digest plus length, never silently stored in full. | `packages/observe/test/attribute-bounds.test.ts` `[planned]`. |
| **R-ops-110** | Sampling defaults: the **local trace file is never sampled** (100 % of spans, bounded by retention — it is the substrate per R-ops-37); the OTLP exporter uses parent-based sampling at **10 %** by default with **error-forced 100 %** (any span whose `outcome` is `failed`, `denied`, `timeout`, `budget_exhausted` or `UNKNOWN` is exported regardless of ratio). The ratio is a managed/user policy value; tail-sampling is optional and MUST NOT be the only path by which an error span reaches an exporter. | `packages/observe/test/sampling.test.ts` `[planned]`; an error-forced fixture in `gate:log-redaction`'s harness. |
| **R-ops-111** | The local dashboard is `hzcode observe dashboard` `[planned]`: it binds `127.0.0.1` by default, serves only local data (trace file plus read-only database projections), ships its assets in-repo (no CDN, no external font, no analytics), is read-only, and MUST warn loudly when asked to bind a non-loopback address. It MUST function with `HZ_OTEL_EXPORT=off`. | `packages/observe/test/dashboard-bind.test.ts` `[planned]`; an assets test that fails on any external URL in the bundle. |
| **R-ops-112** | Export configuration: endpoint and protocol (`otlp/grpc` default, `http/protobuf` supported), headers sourced from the secret vault (never from a plain config value), batch defaults (512 spans or 5 s, whichever first), timeout 10 s, retry with exponential backoff capped at 60 s and a bounded queue that drops oldest first while incrementing `hz.otel.dropped{reason}`. **Offline behaviour**: with no reachable endpoint the run continues normally, nothing blocks, and the exporter reports the condition once per interval — telemetry failure is never a run failure, and never a retry storm. | `packages/observe/test/exporter-offline.test.ts` `[planned]`; a queue-overflow fixture asserting drop-oldest and the counter. |

### 14.1 Metrics catalog

| Metric | Type | Unit | Labels | Cardinality cap |
|---|---|---|---|---|
| `hz.session.duration` | histogram | seconds | `outcome`, `surface` | 5 × 8 = 40 |
| `hz.step.duration` | histogram | milliseconds | `provider`, `model`, `phase` (`llm`, `tools`, `context`) | 20 × 60 × 3 = 3 600 (catalog-bounded: providers and models come from the snapshot) |
| `hz.usage.tokens` | counter | tokens | `provider`, `model`, `kind` (`input`, `output`, `cache_read`, `cache_write`) | 20 × 60 × 4 = 4 800 |
| `hz.cost.micros` | counter | micro-USD | `provider`, `model` | 1 200 |
| `hz.tool.calls` | counter | calls | `tool`, `outcome` | 60 × 8 = 480 |
| `hz.tool.duration` | histogram | milliseconds | `tool`, `phase` (`dispatch`, `execute`) | 60 × 2 = 120 |
| `hz.effect.terminal` | counter | effects | `capability`, `outcome` (RC-7 vocabulary, incl. `unknown`), `effect_class` | 34 × 8 × 7 = 1 904 |
| `hz.lease.grant` | counter | leases | `capability`, `origin_kind` | 34 × 4 = 136 |
| `hz.lease.deny` | counter | leases | `capability`, `reason_code` | 34 × 30 = 1 020 |
| `hz.cache.prefix.hit` | gauge (ratio) | ratio 0–1 | `family`, `provider`, `model` | 10 × 20 × 60 = 12 000 (capped at 2 000 by policy; excess collapses to family-only)
| `hz.projection.write.duration` | histogram | milliseconds | `projection` | 20 |
| `hz.retrieval.duration` | histogram | milliseconds | `mode` (`bm25`, `vector`, `symbol`, `repo_map`, `graph`) | 5 |
| `hz.index.freshness.lag` | gauge | seconds | `index`, `workspace_hash` | 3 × 20 = 60 (workspace id is hashed, never a path) |
| `hz.metrics.cardinality.overflow` | counter | events | `metric` | 50 |
| `hz.otel.dropped` | counter | spans | `reason` (`queue_full`, `unreachable`, `bad_payload`) | 3 |

Global cap: 50 000 live series per process; beyond it, overflows collapse by the rule of R-ops-108. Session duration, step duration, token counts, cost, tool counts, effect terminal states (explicitly including the `UNKNOWN` count, which is the single most important operational number in this product), lease grant/deny, prefix-cache hit ratio, projection write latency, retrieval latency and index freshness lag are the minimum set; a metric outside this table does not exist for operators and MUST NOT appear in a dashboard, an alert or a release note.

### 14.2 Span attribute lists

| Span | GenAI attributes (semconv) | `hz.*` attributes |
|---|---|---|
| `hz.step` | — | `hz.session.id`, `hz.step.id`, `hz.plan.step.index`, `hz.model.role` (`planner`, `executor`) |
| `hz.llm.request` (child of `hz.step`) | `gen_ai.system`, `gen_ai.request.model`, `gen_ai.request.temperature`, `gen_ai.request.max_tokens`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read_input_tokens`, `gen_ai.usage.cache_creation_input_tokens` | `hz.provider.id`, `hz.thinking.level`, `hz.cache.prefix.family`, `hz.retry.attempt` |
| `hz.tool` | — | `hz.tool.name`, `hz.tool.call_id`, `hz.capability.id`, `hz.effect.class`, `hz.idempotency` |
| `hz.effect` | — | `hz.capability.id`, `hz.effect.class`, `hz.decision.reason_code`, `hz.lease.id`, `hz.receipt.digest`, `hz.effect.terminal` (set at end only) |
| `hz.context.compile` | — | `hz.context.strategy`, `hz.tokens.before`, `hz.tokens.after`, `hz.cache.prefix.family` |
| `hz.retrieval` | — | `hz.retrieval.mode`, `hz.retrieval.candidates`, `hz.index.freshness.lag` |
| `hz.update` / `hz.diagnostic` (host spans, no session) | — | `hz.install.channel`, `hz.install.from`, `hz.install.to`, `hz.doctor.check`, `hz.doctor.status` |

No span attribute carries prompt text, tool arguments, file paths or file contents (R-ops-35); a span whose semantics need those uses a digest attribute plus a length, and the local trace file — which is also redacted — is the only place where the digest can be resolved by an authorised reader.

### 14.3 Export configuration summary

| Setting | Default | Notes |
|---|---|---|
| `HZ_OTEL_EXPORT` | `local` | `off` suppresses file and exporter; `otlp` requires `HZ_OTLP_ENDPOINT` |
| `HZ_OTLP_ENDPOINT` | unset | Must be explicit; never inferred from another tool's environment |
| Protocol | `otlp/grpc` | `http/protobuf` opt-in |
| Sampling ratio (OTLP) | 0.10 | Parent-based; error-forced 1.0 (R-ops-110) |
| Batch | 512 spans / 5 s | whichever first |
| Queue ceiling | 8 192 spans | drop-oldest, counted |
| Retry | exp. backoff, cap 60 s | no unbounded retry |
| Offline | local only | run continues; condition reported once per interval |

---

## 15. Performance budgets table

§8 fixes CI lane budgets and gate timeouts. This section fixes the **product budgets**: what a user should be able to feel, with the anchor each number is measured at and the suite that enforces it. Every row cites a key in `/data/home/forge/hzcode/ops/budgets.toml` `[planned]`; every figure is a target, none has been measured.

| # | Rule | Test |
|---|---|---|
| **R-ops-113** | Every budget row names its **anchor** (the event from which the clock starts), its **population** (what is included and excluded), and its **enforcing gate or suite**. A budget without an enforcing suite MAY exist as an aspiration but MUST be labelled `UNENFORCED` and MUST NOT be quoted as a guarantee. | `gate:lane-budget` `[planned]`; `ops/bench/METRICS.md` `[planned]` generated from the suite definitions. |
| **R-ops-114** | Budgets are measured on a named reference machine class (`ref-linux-x64-4c8g`, `ref-macos-arm64`, `ref-win-x64` `[planned]`). A number measured on any other class MUST carry that class in its label, and cross-class comparisons MUST NOT be used to fail a gate. | `gate:perf-regression` header assertion `[planned]`. |
| **R-ops-115** | Each row distinguishes **target** (the point beyond which regressions fail the gate per R-ops-51) from **ceiling** (an absolute bound that fails regardless of baseline). A ceiling breach is always a FAIL; a target breach is a FAIL only when it exceeds the §2.7 thresholds. | `gate:perf-regression`. |

| Budget | Target | Ceiling | Anchor (population) | Enforced by |
|---|---|---|---|---|
| Cold start (first invocation after install, empty caches) | ≤ 250 ms p95 | 400 ms p95 | process spawn → `hzcode version --json` complete; excludes kernel start (CLI only) | `hzcode bench --suite cli-cold-start` → `gate:perf-regression` |
| Warm start | ≤ 60 ms p95 | 100 ms p95 | process spawn → command dispatch; same binary, warm filesystem | `cli-cold-start` suite (warm leg) |
| First-token overhead (client side) | ≤ 120 ms p95 | 250 ms p95 | step start → first streamed token received; excludes provider time-to-first-token and network | `stream-latency` suite |
| Tool dispatch overhead | ≤ 15 ms p95 | 40 ms p95 | admitted tool call → executor entry; excludes guard/lease time (measured separately in `hz.effect` spans) | `tool-roundtrip` suite |
| Context compile time | ≤ 300 ms p95 at ≤ 200 000-token budget | 1.5 s p95 | compile start → prefix + projected tail ready; excludes retrieval of cold index | `context-compile` suite |
| Projection write latency | ≤ 5 ms p95 per append batch | 20 ms p95 | event append transaction commit → projection updated; population: batches of ≤ 50 events | `session-replay` suite |
| Index query latency (lexical/symbol) | ≤ 50 ms p95 on a 100 000-file reference repo | 200 ms p95 | query dispatch → first result page; excludes cold index build | `index-query` suite |
| Index query latency (vector, warm) | ≤ 150 ms p95 for top-20 | 500 ms p95 | query dispatch → top-k ranked; excludes first-time model load | `index-query` suite |
| TUI repaint | ≤ 16 ms p95, ≤ 33 ms p99 | 50 ms (a single frame) | input event → frame presented; population: streaming and diff views | `tui-startup` + `stream-latency` suites |
| Memory ceiling per session | ≤ 1.5 GiB RSS target for CLI+TUI at default context | 3 GiB hard | peak RSS of the CLI/TUI process tree for the session; excludes kernel, worktree tooling and subagent processes (each subagent has its own ceiling) | resource sampler (R-ops-105) + `memory` suite; a ceiling breach is a `warn` in `doctor` and an alert metric, never a silent kill |
| Max concurrent sessions | 8 sessions per machine supported; 4 concurrently *active* runs | − | kernel worktree pool + scheduler; further sessions queue rather than degrade the active ones | kernel integration test on the worktree pool `[planned]` |

Budgets already fixed elsewhere: `doctor` 2.0 s / 8.0 s, `update --check` 2.0 s, update download 60 s at 10 Mbit/s, swap+smoke 5.0 s, `support-bundle` 20 s / 25 MiB / 8 MiB (§8.3); trace-write overhead ≤ 2 % of step wall-clock; gate timeouts (§8.2).

---

## 16. Release engineering

| # | Rule | Test |
|---|---|---|
| **R-ops-116** | **Deprecation.** A surface (CLI flag, environment variable, config key, plugin API, skill field, schema field) is retired in this order: (1) mark it deprecated in the schema/help with `deprecated since <version>` and a *stated* removal version; (2) emit a one-per-process runtime warning naming the replacement; (3) keep the surface working **exactly as before** until removal — deprecation is never a silent behaviour change; (4) wait a minimum of two minor releases or six months, whichever is longer; (5) remove only in a major release of the owning artifact; (6) for wire/protocol surfaces, removal additionally requires a `HZ_PROTO`/`HZ_ABI` bump (R-ops-10). The window is per artifact, not per repository. | `gate:deprecation-window` `[planned]` fails a removal whose deprecation release is inside the window, or that lacks a `deprecated since` marker. |
| **R-ops-117** | **Migration notes.** Any release containing a breaking change (major CLI, `HZ_PROTO`/`HZ_ABI` bump, schema removal, config key removal, behaviour change a user can observe) MUST ship a migration note `ops/migrations/<artifact>-<from>-to-<to>.md` `[planned]`, linked from the release notes, containing: what changed, who is affected, before/after examples, the automated check a user can run, and the rollback path. A breaking change without a migration note is a release blocker. | `gate:release-integrity` checks that every breaking-change marker in the changelog has a linked note `[planned]`. |
| **R-ops-118** | **LTS for the protocol revision.** Each `HZ_PROTO`/`HZ_ABI` major gets an LTS window: it is supported for **12 months after the next major ships**, and for the **last two stable CLI minor trains**. Security fixes are backported to the previous two stable CLI minors and to the latest LTS protocol revision. LTS artifacts stay downloadable and signed (R-ops-17); ending support requires an announcement one minor earlier and honours the compatibility window of R-ops-12. | `ops/lts.toml` `[planned]`; `gate:release-integrity` asserts LTS entries in the manifest `[planned]`. |
| **R-ops-119** | **Compatibility matrix.** The matrix below is **generated** from `ops/kernel-compat.toml` and exercised by `gate:kernel-abi-compat`; the copy here is a shape, not a second source of truth. A pair not in the matrix is a fail-closed refusal (exit 3), never a best-effort attempt. Version numbers shown are placeholders until the first release and are `UNKNOWN` today. | `gate:kernel-abi-compat`; `gate:kernel-pin`. |

### 16.1 Compatibility matrix (shape)

| `HZ_PROTO` / `HZ_ABI` | CLI trains | Kernel (`hzk`) | Mixed-pair behaviour | Status |
|---|---|---|---|---|
| 1 | `0.x` (current train) | `hzk 0.x` | Same revision: full support. | `[planned]` (numbers `UNKNOWN`) |
| 1 | `0.x` | `hzk 0.x−1` | Supported inside the declared compatibility set; refused outside it with `kernel_abi_incompatible`. | `[planned]` |
| 2 | `1.x` | `hzk 1.x` | New major: mixed pairs of `1.x` CLI with `hzk 0.x` are supported only during the R-ops-12 window, and only in fail-closed mode. | `[planned]` |
| 2 | `0.x` | `hzk 1.x` | Refused (`kernel_abi_incompatible`); the old CLI is told to update. | `[planned]` |

**Reading the matrix.** Columns: the protocol revision, the CLI trains that speak it, the kernel builds that speak it, and what happens when a pair from *different* cells is combined. The compatibility window (R-ops-12) is a *duration*, not a set of blessed pairs: during it both directions fail closed with a named reason code so an operator is never left guessing which side to update.
