# Stop of day — 2026-11-20

> **Goal: NOT COMPLETE.** LICENSE deferred ([`LICENSE-STATUS.md`](LICENSE-STATUS.md)). Never claim shell-net egress **`enforced`**. Nothing is **RELEASED**.
>
> **Authoritative status:** [`28-implementation-status.md`](28-implementation-status.md) §3 through ruling **732**. Live queue: [`FULL-BACKLOG-2026-11-13.md`](FULL-BACKLOG-2026-11-13.md). Progress narrative: [`GOAL-PROGRESS.md`](GOAL-PROGRESS.md). Build/test: [`33-handoff.md`](33-handoff.md). Repo snapshot entry: [`../CURRENT_RUN.md`](../CURRENT_RUN.md).

## Session outcome

Finish-all /goal work **paused for the day**. Large local slice (rulings **538–732**) is being committed to `main`. Gates **8/8** last re-verified 2026-11-19 after **648** — gates-green ≠ release / ≠ P0 closed.

## Done this wave (landed / TESTED partial — not done-bars)

High-water rulings since the prior `main` tip (**537**-era docs verify). Grouped for humans; see `docs/28` §3 for full text.

### P0 spine reductions

| Ruling | Slice |
|---:|---|
| **649–653**, **666–667**, **685**, **687**, **702**, **721** | EffectHost require preflight, hooks suppress, shape honesty, first-hit refuse, MCP spawn refuse, mutating `mcp.invoke` fail-closed under EffectHost-on |
| **669**, **686**, **693**, **698**, **700**, **706**, **709** | Shell argv FS postimages, nested observe, absent-path classify, shell side-effect class, legacy unverifiable rows |
| **655**, **673**, **683**, **690–691**, **695**, **699**, **714**, **718**, **722** | R170 Bun fence / MCP+SQLite gates / hook barriers / `(dev,ino)` + dangling symlink / fs.write+fs.edit observe-settle |
| **656**, **672**, **715** | Product netns prove / default-on when capable / WSL·CAP honesty — still never `enforced` |

### Wave-0 / trust

| Ruling | Slice |
|---:|---|
| **657**, **688**, **725** | `parentReceiptId` + kernel `issuerStamp` + TS keyed verify/doctor |
| **637**, **680**, **716**, **719** | G1 additive + opt-in wire + doctor + trusted product default-on |
| **682**, **712**, **717**, **720** | Human principal honesty / Bun strict / kernel `principal:"parent"` + strict mint |
| **696**, **703**, **710**, **724** | Windows detach honesty, host supervisor lease, binary seal, Windows `LockFileEx` |
| **623**/**629**/**636** | H-31 workspace bind (file-tool TOCTOU still OPEN) |
| **670**, **730** | Speculation opt-in wire + prep-discard doctor |
| **675**, **732** | `hz-sandbox-exec` wrap + require-wrap doctor |

### Agent caps / product

| Ruling | Slice |
|---:|---|
| **665**, **671**, **676–681**, **689**, **701**, **711**, **713**, **723**, **726–729**, **731** | Tool catalog growth, ask_user, vision ChatMsg, autonomy envelopes, Code Mode kv, LLM compact opt-in, best-of-n parallel→**728** racing, ACP caps, symbol-graph, web_search, ask_user structured, Eng Brain structural impact, token-fit compaction, multimodal product path |

### §7 steal reductions (still PARTIAL where noted)

**B-4** **692**, **C-9** **697**, **C-11** **694**, **C-12** **704**, **D-3** **707**, plus earlier C-7/C-13/F-4/G-1/… reductions — live residuals remain (below).

## Left until v1 / trust release (honest)

Gates alone do **not** ship. Until the owner lowers the bar, treat the tables below as the release backlog.

### Hard P0 done-bars — still OPEN

| # | Area | Status | Residual (done-bar unmet) |
|---:|---|---|---|
| **P0-1** | Universal EffectHost | **PARTIAL** | Ambient Bun under `=default`; shape-ineligible write/edit Bun under non-require; hooks/MCP not OwnerLog-admitted; kernel `mcp.invoke` route OPEN; first-hit fuzz Bun-only under require |
| **P0-2** | Full postimage / Rust observe | **PARTIAL** | Arbitrary shell FS/net observe; deleted-byte reconstruction; deep universal nested observe |
| **P0-3** | Full R170 | **PARTIAL** | Kernel-owned Bun/SQLite/MCP/hooks barrier; alias-race TOCTOU; UNKNOWN beyond prepare-only / abandon / fs.write+edit observe-settle |
| **P0-4** | Product routed egress | **PARTIAL** | WSL/CAP/TLS MITM product E2E; **never** claim shell-net **`enforced`** |

### Wave-0 / trust — OPEN / PARTIAL

| Item | Status | Residual |
|---|---|---|
| **R172** | **PARTIAL** | Human issuer principal; standalone unbound parity; universal cross-process verify lock |
| **G1** | **PARTIAL** | Remove frozen `decision:"allow"` from `contracts.ts` (breaking V2); untrusted-path default-on |
| **Human approval principal** | **PARTIAL** | Cryptographic human identity; kernel-bound UI attestation; policy-allow internal mint stamps |
| **H-29 / H-30 / CB-6** | **PARTIAL** | Windows `--socket` / SO_PEERCRED detach; hot-swap without orphan teardown |
| **H-31** | **PARTIAL** | File-tool TOCTOU beyond workspace bind |
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
| **LICENSE** | **DEFERRED** | No root `LICENSE` — owner decision |

### §7 OPEN / PARTIAL live residuals

| ID | Status | Live residual |
|---|---|---|
| **B-4** | PARTIAL | Product-loop live cache-hit measure (API keys) |
| **C-7 / C-9** | PARTIAL | Live OpenAI GPT-6 `response.steer` session |
| **C-11** | PARTIAL | Empirical difficulty-corpus calibration |
| **C-12** | PARTIAL | Windows parent-walk prove; full R170 / live D-6 over pipe |
| **C-13** | PARTIAL | Kernel-owned R170 (not SQLite fence alone) |
| **D-3** | PARTIAL | Monotonic sleep-wake re-anchor; Windows births |
| **F-4 / G-1 / H-2 / I-2** | PARTIAL | Live invoice / billing truth |
| **G-9** | PARTIAL | Full if-bench corpus |
| **H-7** | PARTIAL | Misc CLI metric contracts |
| **J-1 / J-3 / J-4** | PARTIAL | Harness credentials; OS-enforced proxy; live omp metaharness |

### Also PARTIAL (caps / extras)

| ID | Residual |
|---|---|
| **640** | Tree-sitter AST + fresh-context critic isolation |
| **641** | Code Mode kernel route |
| **642** | Full ACP (`session/load`, MCP-from-client, …) |
| **643** | Verify-artifact bundled browser / default-on every turn |
| **644** | Live H2H SWE-bench matrix |
| **577** | Atomic multi-resource leases (single decision **563** landed; leases residual) |
| Handoff / memory | Embeddings path still OPEN |

## Owner input needed

| Topic | Why |
|---|---|
| **Release bar** | Confirm whether v1 ships only after P0-1…4 done-bars, or a lowered “honesty product” bar |
| **LICENSE** | Choose SPDX / distribution terms ([`LICENSE-STATUS.md`](LICENSE-STATUS.md)) — intentionally deferred |
| **G1 breaking change** | Approve removing frozen `decision:"allow"` from `contracts.ts` |
| **Human crypto principal** | Approve scope / UX for real human attestation (not Bun fd-3) |
| **Live provider keys** | B-4 / C-9 / F-4 / I-2 / vision E2E need owner credentials or explicit SKIP |
| **J-1 / J-3 / J-4** | Official harness credentials + OS proxy policy |
| **WSL / CAP** | Host capability for product netns prove (this WSL often EPERM) |
| **NOTICE / provenance** | Release-grade NOTICE rows (`33-handoff` §6) |
| **Working-tree merge policy** | This commit lands a large uncommitted slice onto `main` |

## Next agent first hour

1. Read [`../AGENTS.md`](../AGENTS.md) → this file → [`FULL-BACKLOG-2026-11-13.md`](FULL-BACKLOG-2026-11-13.md) §Z / §A / §C.
2. `git status` / `git log -5` — confirm tip includes stop-of-day sync.
3. Prefer P0-1 hooks/MCP OwnerLog **or** P0-3 alias-race / UNKNOWN beyond edit — not §7 live-key work without owner keys.
4. Never claim shell-net **`enforced`**. Do not invent root `LICENSE`.
5. On ship: add §3 ruling, bump GOAL/FULL/AGENTS headers in the **same** change.

## Explicit non-claims

- Not RELEASED / not v1 closed.
- Gates 8/8 ≠ trust product.
- Shell-net never **`enforced`**.
- fd-3 ≠ human.
- Speculative execution default-off.
