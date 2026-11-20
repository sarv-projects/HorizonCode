# Stop of day — 2026-11-20 (rechecked)

> **Goal: NOT COMPLETE.** LICENSE deferred ([`LICENSE-STATUS.md`](LICENSE-STATUS.md)). Never claim shell-net egress **`enforced`**. Nothing is **RELEASED**.
>
> **Authoritative status:** [`28-implementation-status.md`](28-implementation-status.md) §3 through ruling **734**. Live queue: [`FULL-BACKLOG-2026-11-13.md`](FULL-BACKLOG-2026-11-13.md). Progress: [`GOAL-PROGRESS.md`](GOAL-PROGRESS.md). Build/test: [`33-handoff.md`](33-handoff.md). Snapshot: [`../CURRENT_RUN.md`](../CURRENT_RUN.md).
>
> **Recheck:** working tree tip + uncommitted 733/734 folded into this inventory before push. Prior tip `aa09567` covered through **732**; this stop-of-day revision adds **733** (`fs.delete` observe-settle) + **734** (Bun H-31 workspace identity).

## Session outcome

Finish-all /goal work **paused for the day** after owner request. Inventory + implementation through **734** committed to `main`. Gates **8/8** last re-verified 2026-11-19 after **648** — gates-green ≠ release / ≠ P0 closed.

---

## 1. Done so far (landed / TESTED partial — not done-bars)

High-water since prior `main` docs tip (**537**-era). Full text in `docs/28` §3.

### 1.1 P0 spine reductions

| Rulings | What landed | Still not the done-bar |
|---|---|---|
| **649–653**, **666–667**, **685**, **687**, **702**, **721** | EffectHost require preflight, hooks suppress, shape honesty, first-hit refuse under require, MCP spawn refuse, mutating `mcp.invoke` fail-closed under EffectHost-on | Ambient Bun under `=default`; hooks/MCP OwnerLog route; shape-ineligible Bun under non-require |
| **669**, **686**, **693**, **698**, **700**, **706**, **709** | Shell argv FS postimages (reduced), nested observe, absent-path classify, shell side-effect class, legacy unverifiable rows | Arbitrary shell FS/net; deleted-byte reconstruction; deep universal nested observe |
| **655**, **673**, **683**, **690–691**, **695**, **699**, **714**, **718**, **722**, **733** | R170 Bun fence / MCP+SQLite gates / hook barriers / `(dev,ino)` + dangling symlink / observe-settle for **fs.write + fs.edit + fs.delete** | Kernel-owned Bun/hooks barrier; alias TOCTOU; shell/batch/rename observe-settle |
| **656**, **672**, **715** | Product netns prove / default-on when capable / WSL·CAP honesty | TLS MITM product E2E; never `enforced` |

### 1.2 Wave-0 / trust reductions

| Rulings | What landed | Residual |
|---|---|---|
| **657**, **688**, **725** | `parentReceiptId` + kernel `issuerStamp` + TS keyed verify/doctor | Human issuer; unbound parity; universal verify lock |
| **637**, **680**, **716**, **719** | G1 additive + opt-in + doctor + trusted product default-on | Frozen `allow` removal (breaking); untrusted-path default-on |
| **682**, **712**, **717**, **720** | Human principal honesty / Bun+kernel strict / `principal:"parent"` | Crypto human identity; UI attestation |
| **696**, **703**, **710**, **724** | Windows detach honesty, host lease, binary seal, Windows `LockFileEx` | Windows `--socket` / SO_PEERCRED detach |
| **623**, **629**, **636**, **674**, **734** | H-31 kernel bind + Guard digest + held-lease remount + fd verify + **Bun file-tool capture/drift refuse** | Full intermediate-component TOCTOU |
| **670**, **730** | Speculation opt-in + prep-discard doctor | Segment ordering; hook parity; default-on |
| **675**, **732** | `hz-sandbox-exec` wrap + require-wrap doctor | Wider allowlist; never shell-net `enforced` |

### 1.3 Agent caps / product reductions

| Rulings | What landed | Residual |
|---|---|---|
| **665**, **671**, **676–681**, **689**, **701**, **711**, **713**, **723**, **726–729**, **731** | Catalog growth, ask_user, vision ChatMsg, autonomy envelopes, Code Mode kv, LLM compact opt-in, best-of-n→**728** racing, ACP caps, symbol-graph, web_search, structured ask_user, Eng Brain structural impact, token-fit, multimodal product path | See §2.3–2.4 |

### 1.4 §7 steal reductions (PARTIAL where live residual remains)

| ID | Landed | Live residual |
|---|---|---|
| **B-4** | **692** hermetic cache-hit doctor | Product-loop live cache-hit — **run** (spend granted §3.1) |
| **C-7** | Auto-bg ↔ steer race | Real Responses steer (see C-9) |
| **C-9** | **697** hermetic steer doctor + product wrap | Live GPT-6 session |
| **C-11** | **694** opt-in live difficulty judge | Empirical corpus calibration |
| **C-12** | **704** macOS reduced ancestor + Windows honesty | Windows parent-walk prove; full R170 / live D-6 over pipe |
| **C-13** | SQLite cross-process admission fence | Kernel-owned R170 |
| **D-3** | **707** non-Linux birth honesty | Sleep-wake re-anchor; Windows births |
| **F-4 / G-1 / H-2 / I-2** | Cost/usage scaffolding | Live invoice / billing truth |
| **G-9** | Fixture corpus | Full if-bench corpus |
| **H-7** | Many CLI metric contracts | Misc remaining contracts |
| **J-1 / J-3 / J-4** | preds/submit/sandbox seams | Harness credentials; OS proxy; live omp metaharness |

---

## 2. Left until v1 / trust release (honest)

Gates alone do **not** ship. Until the owner lowers the bar, this is the release backlog.

### 2.1 Hard P0 done-bars — still OPEN (status: PARTIAL vs done-bar)

| # | Area | Status | Done-bar unmet residual |
|---:|---|---|---|
| **P0-1** | Universal EffectHost | **PARTIAL** | Ambient Bun under `=default`; shape-ineligible write/edit Bun under non-require; hooks/MCP not OwnerLog-admitted; kernel `mcp.invoke` OwnerLog route OPEN; first-hit fuzz Bun-only under require |
| **P0-2** | Full postimage / Rust observe | **PARTIAL** | Arbitrary shell FS/net observe; deleted-byte reconstruction; deep universal nested observe |
| **P0-3** | Full R170 | **PARTIAL** | Kernel-owned Bun/SQLite/MCP/hooks barrier; alias-race TOCTOU; UNKNOWN beyond prepare-only / abandon / write+edit+delete observe-settle; shell/`fs.batch`/`fs.rename` observe-settle OPEN |
| **P0-4** | Product routed egress | **PARTIAL** | WSL/CAP/TLS MITM product E2E; **never** claim shell-net **`enforced`** |

### 2.2 Wave-0 / trust — OPEN / PARTIAL / DEFERRED

| Item | Status | Residual |
|---|---|---|
| **R172** | **PARTIAL** | Human issuer principal; standalone unbound parity; universal cross-process verify lock |
| **G1** | **PARTIAL** | Remove frozen `decision:"allow"` from `contracts.ts` (breaking V2); untrusted-path default-on |
| **Human approval principal** | **PARTIAL** | Cryptographic human identity; kernel-bound UI attestation; policy-allow internal mint stamps |
| **H-29 / H-30 / CB-6** | **PARTIAL** | Windows `--socket` / SO_PEERCRED detach; hot-swap without orphan teardown |
| **H-31** | **PARTIAL** | Intermediate-component / non-Linux TOCTOU beyond **734** |
| **Speculation** | **PARTIAL** | Segment ordering; hook parity; default-on |
| **Multimodal / vision** | **PARTIAL** | Gemini/Ollama multipart; live provider E2E; mid-turn images |
| **web_search** | **PARTIAL** | Kernel `net.search`; routed egress; budget metering |
| **Token / LLM compaction** | **PARTIAL** | Per-message token trim; default-on LLM compact; invoice truth for `/tokens` |
| **ask_user** | **PARTIAL** | Multi-select; timeout; dedicated clarify frame |
| **Autonomy envelopes** | **PARTIAL** | OS blast-radius confinement (tiers exist **678**) |
| **Symbol graph** | **PARTIAL** | Tree-sitter / semantic edges; default-on durable graph |
| **Eng Brain / AST (640)** | **PARTIAL** | Full AST call-graph; isolated cross-model critic session |
| **Code Mode 2.0 (641)** | **PARTIAL** | WSL netns prove; full tool set; kernel route |
| **Best-of-N** | **PARTIAL** | Kernel pool leases; reset-before-reuse; chooser variance; product UI |
| **shell.exec / hz-sandbox-exec (660)** | **PARTIAL** | Wider unconfined allowlist; product shell-net never `enforced` |
| **LICENSE** | **DEFERRED** | No root `LICENSE` — owner decision ([`LICENSE-STATUS.md`](LICENSE-STATUS.md)) |

### 2.3 §7 FULL-BACKLOG §C — live PARTIAL residuals only

| ID | Status | Live residual |
|---|---|---|
| **B-4** | PARTIAL | Product-loop live cache-hit measure — **run** (spend granted §3.1) |
| **C-7** | PARTIAL | Depends on live C-9 Responses steer |
| **C-9** | PARTIAL | Live OpenAI GPT-6 `response.steer` session |
| **C-11** | PARTIAL | Empirical difficulty-corpus calibration |
| **C-12** | PARTIAL | Windows parent-walk prove; full R170 / live D-6 over pipe |
| **C-13** | PARTIAL | Kernel-owned R170 (not SQLite fence alone) |
| **D-3** | PARTIAL | Monotonic sleep-wake re-anchor; Windows births |
| **F-4** | PARTIAL | Live invoice truth (+ shell-net egress) |
| **G-1** | PARTIAL | Live-provider cost capture / invoice reconciliation |
| **G-9** | PARTIAL | Full external if-bench corpus |
| **H-2** | PARTIAL | Live billing truth |
| **H-7** | PARTIAL | Misc remaining CLI metric contracts |
| **I-2** | PARTIAL | Live invoice / billing truth for `/tokens` |
| **J-1** | PARTIAL | Official harness credentials |
| **J-3** | PARTIAL | OS-enforced proxy |
| **J-4** | PARTIAL | Live omp metaharness |

§C **SKIP/DEFER (owner):** **H-6** (KDL cascade — ruling **513**).  
§C **DONE** rows (not release blockers): B-2, B-5, B-7, C-5, C-8, C-10, D-5, D-6, E-1…E-4, F-1…F-3, G-4…G-8, H-1, H-3…H-5, I-4, I-5, I-7, I-8, J-2, J-5.

### 2.4 Also PARTIAL (caps / extras)

| ID | Residual |
|---|---|
| **640** | Tree-sitter AST + fresh-context critic isolation (beyond **727**) |
| **641** | Code Mode kernel route |
| **642** | Full ACP (`session/load`, MCP-from-client, …) |
| **643** | Verify-artifact bundled browser / default-on every turn |
| **644** | Live H2H SWE-bench matrix |
| **577** | Atomic multi-resource leases (single decision **563** landed; leases residual) |
| Handoff / memory | Embeddings path still OPEN |

### 2.5 Process / ops (release hygiene)

| Item | Note |
|---|---|
| Gates | `ops/gates.sh` **8/8** ≠ trust product / ≠ RELEASED |
| docs/24 §3.5 | 18 rows remain `declared-gap` in `ops/gate-catalogue.md` |
| NOTICE / provenance | Release-grade NOTICE rows (`33-handoff` §6) still OPEN |
| Never claim | Shell-net egress **`enforced`** |

---

## 3. Owner authorizations (recorded 2026-11-20)

### 3.1 Live provider spend — **GRANTED (unlimited)**

Owner confirmation (this session): live API keys are already provisioned on this host (`OPENAI_API_KEY`, `NVIDIA_API_KEY`, and `~/.config/horizon/env`). Owner authorizes **unlimited usage** and **no holding back** on permission to spend.

**Agent rule:** for B-4 / C-9 / F-4 / G-1 / H-2 / I-2 / vision / other live provider residuals, **run the live path**. Do not skip, defer, or ask again for spend permission because of cost. Primary posture: **run**, and **fix whatever breaks along the way** (auth errors, schema drift, flaky WS, empty responses, **rate limits**, retries/backoff, provider outages, env/key wiring). Rate-limit ≠ stop: back off, retry, narrow the call, record honesty, continue.

Still separate from spend: harness-only secrets (J-1/J-3/J-4 official credentials / OS proxy policy) if not already on the host; Brave/other optional backends only if that provider is required for the residual under test.

### 3.2 Owner input still needed (non-spend)

| Topic | Why | Blocking? |
|---|---|---|
| **Release bar** | Strict P0-1…4 done-bars vs lowered “honesty product” bar | **Yes** for calling v1 |
| **LICENSE** | Choose SPDX / distribution terms | Deferred; needed for distribution |
| **G1 breaking change** | Approve removing frozen `decision:"allow"` from `contracts.ts` | Needed for G1 done-bar |
| **Human crypto principal** | Scope / UX for real human attestation (not Bun fd-3) | Needed for human-principal done-bar |
| **Live provider spend** | ~~Ask for keys / SKIP~~ → **GRANTED unlimited** (§3.1) | **Not blocking** |
| **J-1 / J-3 / J-4** | Official harness credentials + OS proxy policy (if absent on host) | Needed for those §7 rows only |
| **WSL / CAP** | Host capability for product netns prove (this WSL often EPERM) | Needed for P0-4 prove |
| **NOTICE / provenance** | Release-grade NOTICE rows | Release hygiene |

---

## 4. Explicit non-claims

- Not RELEASED / not v1 closed / Goal **NOT COMPLETE**.
- Gates 8/8 ≠ trust product.
- Shell-net never **`enforced`**.
- fd-3 ≠ human.
- Speculative execution default-off.
- Observe-settle is never silent auto-settle.
- §7 PARTIAL ≠ P0 done-bar.
- Unlimited spend authorization ≠ done-bar closed — live rows still need evidence.

---

## 5. Next agent first hour

1. Read [`../AGENTS.md`](../AGENTS.md) → this file (§3.1 spend grant) → [`FULL-BACKLOG-2026-11-13.md`](FULL-BACKLOG-2026-11-13.md) §Z / §A / §C.
2. `git log -1` — confirm tip includes this stop-of-day sync.
3. **Run** live residuals when they are the next backlog item (B-4 / C-9 / invoice / vision / …). Fix errors and rate limits in place; do not hold back for cost.
4. Also advance P0 spine (hooks/MCP OwnerLog, alias-race, shell observe-settle) in §Z order when not blocked on live keys.
5. Never claim shell-net **`enforced`**. Do not invent root `LICENSE`.
6. On ship: add §3 ruling, bump GOAL/FULL/AGENTS/CURRENT_RUN/this file in the **same** change.
