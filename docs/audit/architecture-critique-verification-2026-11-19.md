# Architecture / competitive critique — claim verification (2026-11-19)

> **Method:** every material claim from the user-supplied master critique was checked against the live tree on this host (`DESKTOP-SARV` / WSL checkout under `…/horizoncode`). Evidence is code, docs, or measured counts — not memory. Goal remains **NOT COMPLETE**. LICENSE remains deferred (`docs/LICENSE-STATUS.md`). Never claim shell-net egress **`enforced`**.
>
> **Verdict on the critique overall:** directionally right on the trust-spine holes and the designed-vs-shipped topology split; **wrong or stale** on several numeric / inventory details; **strategically wrong** where it recommends abandoning honesty discipline or shrinking capability ambition to “slim down.” HorizonCode must keep the cryptographic execution moat **and** ship envelope autonomy + harness intelligence — not trade one for the other.

---

## A. Inspection-scope claims

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| A1 | `docs/` has **100** Markdown files | **TRUE** | `find docs -name '*.md' \| wc -l` → `100` |
| A2 | Those files total **44,377** lines | **NEAR-TRUE** | Measured **44,375** lines (Δ −2; normal churn). Treat as ±0.01% |
| A3 | `28-implementation-status.md` is **1,054** lines / rulings **1–620** | **STALE** | Live frontier through **646**; line count churned with rulings |
| A4 | Automated scan: 318 schema tokens / 215 `hz.*` tokens | **STALE (low)** | Remeasured **324** `*V1`/`*V2`-like tokens, **250** `hz.*` tokens |
| A5 | **621** “not cloned” occurrences | **UNDERCOUNT** | Remeasured **811** case-insensitive `not cloned` hits |
| A6 | **15** broken relative links, all in `audit/` / research | **TRUE (shape)** | 15 non-resolving relative targets; mostly audit/passN + one research `url` stub. Core `00`–`33` clean |
| A7 | Canonical events: **0** stale counts; **50** shipped / **32** literal / **44** mapped | **TRUE (live)** | `hzEventCoverageReport()` → shipped **50**, canonical **44**, mapped **44**, literal **32**, unmapped **0** |
| A8 | Partials on `08`/`10`/`11` size claims | **TRUE** | `11-authority-safety.md` is **2,114** lines; `08`/`10` large |

---

## B. Executive verdict claims

| # | Claim | Verdict | Evidence / correction |
|---|---|---|---|
| B1 | Architecturally differentiated; viable for high-trust / regulated **prototype**, **not** general-purpose release / strict-superset product yet | **TRUE** | P0 bars OPEN; LICENSE deferred; gates≠release (`00-index`, `GOAL-PROGRESS`, `FULL-BACKLOG` §0) |
| B2 | Real Rust authority kernel + OwnerLog + receipts + fail-closed UNKNOWN | **TRUE (partial product)** | `kernel/`, OwnerLog, receipts, UNKNOWN latch — but universal EffectHost still OPEN |
| B3 | Exceptional engineering honesty / refuse fake `enforced` | **TRUE** | `LICENSE-STATUS`, doctor honesty, AGENTS.md, many rulings |
| B4 | All **8** P0 acceptance bars remain OPEN | **TRUE** | `docs/audit/p0-eight-requirements-2026-11-14.md` disposition; RC-18 **counts** updated 2026-11-19 but bar still OPEN |
| B5 | Designed architecture and shipped tree have structurally diverged | **TRUE** | `03`/`04` still specify `packages/@horizoncode/*`, `hz_native`, `hz_codegen`, `pnpm gate:*`; tree is `app/` + `kernel/` |
| B6 | Zero live head-to-head competitor benchmark | **WAS TRUE; PARTIAL FIX (644)** | `hzcode h2h` dry-run 25-task matrix + PATH discovery; live SWE-bench Verified competitor pass rates still OPEN (needs dataset/keys/adapters) |
| B7 | No root `LICENSE` blocks external adoption | **TRUE** | No `LICENSE` file; `LICENSE-STATUS.md` explicit deferral |
| B8 | 620 rulings / 100 docs / micro-rulings “consume velocity” instead of closing load-bearing holes | **PARTIAL** | Sequencing tension is real; **FALSE** that honesty/under-admission/H-7 work is worthless — it is load-bearing for the moat. Wrong sequencing ≠ wrong work |
| B9 | Gates **8/8** with **3,655+** Bun / **229+** Rust at rulings 535–537 | **UNVERIFIED THIS TURN** | Doc claims gates 8/8 at 537 exist; full suite not re-run in this verification pass. Do not inflate |

---

## C. “What is missing / broken” claims

| # | Claim | Verdict | Evidence / correction |
|---|---|---|---|
| C1 | HLD/LLD specify 24-package TS monorepo + 16 Rust crates + `hz_native`/`hz_codegen` | **TRUE (as DESIGNED)** | `03-hld.md` / `04-lld.md` |
| C2 | Shipped = flat `app/src` Bun + single `kernel/` crate; no `packages/`/`crates/` | **TRUE** | No `packages/` or `crates/` dirs; `app/package.json` has **`dependencies: null`** (devDeps only) |
| C3 | `loop.ts` ~2,580+ lines / **197 KB** | **TRUE (bytes)** | **199,803** bytes; **4,496** lines (critique understated line count) |
| C4 | Missing ADR: ratify Bun+Rust vs monorepo target | **TRUE gap** | Needs ADR (see §F). Must **not** erase designed capability layers — ratify *topology*, keep *capability ambition* |
| C5 | P0-1: fd3 parent credential ≠ authenticated human principal | **TRUE** | `p0-eight-requirements` P0-1 text; ruling 352 residual |
| C6 | Docs say Guard has no `Allow` / every mutation needs one-use lease; shipped `allow` without lease | **WAS TRUE; PARTIAL FIX (624+637)** | H-4 lease-on-allow (**624**); additive `g1:"ask"|"deny"` Ask/Deny-only projection (**637**); frozen `decision:"allow"` retained until protocol V2. Residual: ambient Bun paths outside kernel Guard still bypass |
| C7 | Non-universal EffectHost; ambient Bun / hooks / MCP / fuzzy patch bypass outside `=require` | **TRUE (PARTIAL FIX)** | **630**/**631** batch rename+delete + regulated→require; **633** doctor names `code_mode`/MCP refuse-under-require; fuzzy/default ambient still OPEN |
| C8 | Split-brain SQLite ↔ OwnerLog; no 2PC | **TRUE** | P0 session/kernel consistency OPEN; R170 residual |
| C9 | `hzk` dies with parent (H-29/H-30 unmet) | **WAS TRUE; PARTIAL FIX (625–628+632+634+635+638)** | Socket serve + detach orphan + reattach + control seal + **634** epoch + **635**/**638** exclusive `hzk.supervisor.lock` for stdio **and** socket (second live owner → `supervisor.lease_held`). Residual: human principal OPEN; Windows / cross-state-dir / binary-upgrade durability OPEN |
| C10 | Workspace binding is path string, not `(dev,ino)` in Guard digest (H-31) | **WAS TRUE; PARTIAL FIX (623+629+636)** | Execute-time `(dev,ino)` bind (**623**) + Guard digest (**629**) + held-lease remount burn (**636**). Residual: file-tool TOCTOU remains separate |
| C11 | WSL2 `unshare(CLONE_NEWNET)` → EPERM; shell net unconfined; Code Mode refuses without sandbox | **TRUE** | Zero-trust remediation host limitation; Code Mode sandbox gate |
| C12 | macOS Seatbelt / Windows AppContainer unbuilt | **TRUE** | docs/11 + LLD UNKNOWN rows |
| C13 | Routed MITM/CONNECT egress still prototype / OPEN | **TRUE** | P0-4; never claim `enforced` |
| C14 | Zero-dep dogma blocks tree-sitter / YAML / etc. | **PARTIAL** | Zero runtime deps in `app/package.json` is **TRUE**; tree-sitter can still land in **Rust/kernel or WASM** without breaking that invariant — critique’s “dogma vs intelligence” tension is real but solvable without abandoning zero-dep TS |
| C15 | Hashline / toolconv / Code Mode / LSP / DAP / worktree pool exist | **TRUE with path fixes** | `app/src/tools/hashline.ts` (not `core/`); `providers/toolconv/*` has DeepSeek/Gemma/GLM/Harmony/Hermes/Kimi/MiniMax/Qwen3/XML + Anthropic/Gemini wraps; `codemode*.ts`; LSP/DAP modules present |
| C16 | ACP shipped | **WAS FALSE; PARTIAL FIX (642)** | `hzcode acp` ACP v2 initialize + session/new|list|close|prompt; full auth/elicitation/MCP-from-client / IDE marketplace install still OPEN |
| C17 | Speculation UNWIRED | **TRUE** | Ruling **65**; AGENTS.md |
| C18 | Autonomy presets already exist but are permission-mode aliases, not OS envelopes | **WAS TRUE; PARTIAL FIX (622+630)** | Additive envelope aliases; **regulated** now composes `HZ_EFFECT_HOST_KERNEL=require` when env unset. OS blast-radius confinement still not claimed |

---

## D. Cross-analysis table claims

| # | Claim | Verdict | Fix |
|---|---|---|---|
| D1 | `00-index` cites rulings through **549** / RC-17 | **WAS TRUE; FIXED** | Updated `00-index.md` → rulings **648** (2026-11-19), RC-18 |
| D2 | `_conventions` defines RC-18 while index lagged | **TRUE** | Index table row updated to RC-1…RC-18 |
| D3 | FULL-BACKLOG header/§0 inconsistency (539 vs 538–620) | **WAS TRUE; FIXED** | Live §0 now **538–644** |
| D4 | GOAL cites **621** | **WAS TRUE; UPDATED** | Live GOAL through **644** |
| D5 | Out-of-order ruling log in `28` | **TRUE (structure)** | Newest rulings prepend; older blocks follow — intentional append-front, painful for readers |
| D6 | `04-lld` `pnpm gate:*` / `config.jsonc` / `models.toml` vs Bun + `config.json` | **TRUE mismatch** | Shipped: `ops/gates.sh`, `config.json` |
| D7 | Guard G1 vs shipped allow | **TRUE** | See C6 |
| D8 | Flag proliferation **25+** `HZ_*` | **TRUE (understated)** | **151** distinct `HZ_*` tokens across app/kernel/handoff scan |
| D9 | Event hygiene strong | **TRUE** | Live RC-18 counts healthy; P0 audit row was stale — **updated** |

---

## E. Strategic recommendations — accept / reject / upgrade

| Recommendation | Position |
|---|---|
| Freeze **all** H-7 / under-admission forever | **REJECT** — honesty wrappers are part of the moat; freeze *only* as a temporary sequencing choice while a P0 slice is in flight |
| Close independent `hzk` daemon + `(dev,ino)` binding + universal EffectHost | **ACCEPT — P0 first** |
| Collapse 151 flags into 4 envelopes (`pilot` / `autonomous` / `unattended` / `regulated`) | **ACCEPT as additive product profiles** that *compose* flags; do not delete capabilities those flags unlock |
| Ratify Bun `app/` + Rust `kernel/` topology (ADR) while keeping designed capability surface | **ACCEPT** — topology ratification ≠ capability deletion. Heavy AST/search/sandbox can live in Rust without a 24-package TS monorepo |
| Add root `LICENSE` | **OWNER-GATED** — do not invent; `LICENSE-STATUS.md` |
| Live head-to-head benchmarks | **ACCEPT** |
| Envelope autonomy (zero nag inside blast radius) | **ACCEPT** — complements receipts; does not replace them |
| Code Mode 2.0 + outputSchema + KV + skill crystallizer | **ACCEPT** |
| Engineering Brain (viability gate + adversarial critic) | **ACCEPT** |
| Role routing + Best-of-N worktrees | **ACCEPT** |
| ACP + browser verification artifacts | **ACCEPT** |
| “Stop developing / slim down / kill ambition” framing | **REJECT** |

---

## F. Immediate honesty fixes + load-bearing slices shipped this verification pass

1. `docs/00-index.md` / `AGENTS.md` / `GOAL-PROGRESS` / `FULL-BACKLOG` — rulings through **644**, RC-18.
2. `docs/audit/p0-eight-requirements-2026-11-14.md` — RC-18 live counts (bar remains OPEN).
3. ADR-017 + envelope aliases (**622**); regulated composes EffectHost require (**630**).
4. H-31 execute-time `(dev,ino)` bind (**623**) + Guard `intentDigest` (**629**).
5. H-4 lease-on-allow citations (**624**).
6. H-29/H-30/CB-6 socket serve (**625**) + `--socket` (**626**) + reattach (**628**) + control seal (**632**) + supervisor epoch (**634**) + exclusive supervisor lease flock (**635**) + held-lease remount revalidate (**636**); `kernel.sha256` refreshed.
7. EffectHost `fs.batch` mid-commit rollback (**627**) + exact rename (**630**) + exact delete (**631**) + doctor ambient honesty (**633**).
8. This file — claim ledger (C6/C7/C9/C10/C18 updated to PARTIAL FIX where shipped).

## G. Next load-bearing implementation order (capability-preserving)

1. **ADR-017 (topology):** Ratify shipped `app/` + `kernel/` as the *build* topology; keep `03`/`04` capability targets as DESIGNED planes mapped onto that topology (Rust owns AST/index/sandbox/authority; Bun owns orchestration/cognition/surfaces).
2. **Envelope profiles:** `pilot` / `autonomous` / `unattended` / `regulated` shipped (**622**/**630**); keep granular `HZ_*` escape hatches; next: OS blast-radius composition + unattended stage-and-exit.
3. **Kernel spine next:** Windows/cross-state-dir CB-6 residual; protocol-V2 remove frozen `allow` (637 residual); ambient Bun/MCP/codemode EffectHost. Control remint (**632**) + epoch (**634**) + lease flock (**635**/**638**) + lease remount burn (**636**) + G1 `g1` wire (**637**) shipped.
4. **Universal EffectHost** (Bun ambient / hooks / MCP / codemode / fuzzy still bypass or refuse; **627**/**630**/**631** closed rollback + rename + delete batch).
5. **Code Mode 2.0 + cross-platform sandbox fallback honesty** (WSL badge ≠ silent unconfined).
6. **Harness intelligence:** model-aware edit ladder default, Critic pass, Best-of-N worktrees.
7. **Surfaces:** ACP bridge; Verification Artifact binder to receipt chain.
8. **Benchmark pack:** keyed 20–50 task harness with cost/interrupt metrics.

---

## H. Competitive matrix spot-checks

| Claim | Verdict |
|---|---|
| OMP-style hashline present | **TRUE** (`tools/hashline.ts`) |
| 12-family toolconv present | **TRUE** (family set matches; XML + Anthropic/Gemini wraps) |
| Strongest differentiator = cryptographic constitution | **TRUE** among open agents surveyed in docs |
| Fatal weakness = approval friction / platform sandbox gaps / no LICENSE / no live bench | **TRUE** |
| HorizonCode already beats Claude Code on long-horizon autonomy | **FALSE / UNPROVEN** — no live head-to-head |

---

## I. Ten-layer blueprint gap check (critique §7) — live tree 2026-11-19

| Layer | Critique requirement | HorizonCode today | Gap |
|---|---|---|---|
| 1 Authority Kernel | Independent hzk + (dev,ino) + universal EffectHost + atomic multi-file rollback | **PARTIAL** — OwnerLog/receipts; **623/629/636** bind+digest+lease remount; **625–628+632+634+635** socket detach/reattach/control seal/epoch/lease flock; **627/630/631** batch rollback+rename+delete. Residuals: Windows/cross-dir CB-6, human principal, Bun ambient/MCP/codemode EffectHost | **HIGH** |
| 2 Envelope & Sandbox | Zero-config OS sandbox Linux/WSL/macOS/Windows; net-off + CONNECT | Linux Landlock/seccomp partial; WSL2 net unconfined; macOS/Windows unbuilt; P0-4 OPEN | **CRITICAL** |
| 3 Deterministic Tools | Hashline/AST/LSP/DAP/Browser/MCP + auto-diag | Hashline/AST/LSP/DAP/MCP + **643** CDP screenshot (needs live Chromium); Rust tree-sitter repo-map missing | **MEDIUM** |
| 4 Code Mode 2.0 | Typed stubs in+out schema, KV, skills, kernel receipts | **PARTIAL** — **641**+**645** compact live-schema stubs (≤1024; edit `old`/`new`) + in-run `tools.kv`; skill crystallizer / kernel OwnerLog route / cross-platform sandbox still OPEN | **HIGH** |
| 5 Model Abstraction | Role router + 12 toolconv + repair + OAuth | Strong — toolconv/json-repair/catalog; auto Architect/Editor/Critic + Best-of-N OPEN | **LOW–MEDIUM** |
| 6 Context Compiler | Byte-stable prefix, AST PageRank repo-map, procedural memory | Cache discipline + dream memory; lexical repo-map (not AST PageRank) | **MEDIUM** |
| 7 Orchestration | /goal, DAG subagents, Best-of-N worktrees | `agent-graph`/`worktree-pool`/`subagent` exist; loop monolith; Best-of-N + /goal incomplete | **MEDIUM–HIGH** |
| 8 Engineering Brain | Viability Gate + Adversarial Critic | **PARTIAL** — **639**/**640**+**645**+**661**+**685**+**727** (lexical + structural call-site reach on mutated paths; not tree-sitter call-graph); **705** cross-model LLM (`HZ_ENG_CRITIC_MODEL`); **713** lexical symbol graph | **HIGH** |
| 9 Verification Artifacts | Human proof bundle + receipts | **PARTIAL** — receipts + **643** `hz.verification.artifact.v1` binder + optional CDP shots; auto-emit every turn OPEN | **MEDIUM** |
| 10 Surfaces | TUI + Headless + ACP + daemon | **PARTIAL** — TUI/headless/`server.ts` + **642** `hzcode acp`; full IDE marketplace ACP surface OPEN | **MEDIUM–HIGH** |

## J. Competitive “unfair superset” claims — accept / defer

| Claim | Verdict |
|---|---|
| Common floor (MCP, skills/hooks, worktrees, multi-provider) mostly absorbed | **PARTIAL TRUE** — MCP/hooks/worktrees/providers present; skills marketplace + ACP incomplete |
| Absorb OMP hashline+LSP+DAP + Aider repo-map + Codex sandbox + Antigravity artifacts + Claude /goal + Grok ACP | **DIRECTIONALLY RIGHT** — pieces present or DESIGNED; none fully productized as a unified default path |
| Exclusive moat = envelope-confined autonomy + adversarial engineering brain + harness-compensated intelligence | **ACCEPT as target** — receipts/kernel are the unique base; envelope + Critic + Code Mode 2.0 are the productization path; do **not** trade the kernel for autonomy UX |
| “Kill phantom monorepo / stop micro-rulings / stop per-tool nagging” | **ACCEPT topology ratification + sequencing**; **REJECT** killing honesty/under-admission or shrinking capability ambition |

---

*End of verification ledger. Do not treat this document as P0 closure. Goal **NOT COMPLETE**.*
