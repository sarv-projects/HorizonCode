# Line-by-line reaudit — docs 17–30 + `_conventions.md` (report only, no files modified)

**Scope note:** `docs/17`–`docs/23` **do not exist** (`ls docs/` → 00–16, 24–30, `_conventions.md`, `audit/`). The set audited here is therefore **24, 25, 26, 27, 28, 29, 30, `_conventions.md`**, each read in full.

**Ground truth used (current state):**
- `docs/24` — 75 NF rows NF-001…NF-075 (verified: 75 `### NF-` headers, no duplicates, first NF-001 / last NF-075), 67 test items in §12.2 (verified by count), §6.3 = 50 `none` + 3 `narrows` + 12 `grant-bearing` + 10 `kernel` = 75, Section A.9 present with 6 rows, A.1–A.8 = 117, grand total 123.
- `docs/25` §4.2a — 25 rows NF-051…NF-075 (verified).
- `docs/_conventions.md` — RC-1…RC-15; 44 canonical events (verified count); 34 canonical capability IDs; 16 reserved capability IDs; 17 reserved event names.
- `docs/28` — implementation truth: 285 TS / 0 fail / 27 files; 17 Rust (14 integration + 3 unit); built = kernel, contracts, runtime core, providers, tools, TUI, skills, subagents, code mode (NF-015/NF-051), preview (NF-055). Everything else DESIGNED.
- `docs/29`/`docs/30` are historical-class (RC-14) — superseded numbers inside their own narrative are tolerated; statements that read as *current* are not.

**Classes:** STALE · DUPLICATE · SUPERSET · CONTRADICTION · DEAD REF.

---

## Cross-document duplication (the dup-hunt result, stated once here instead of per file)

This set overlaps by design (RC-14 assigns each document a class). The audit found **eight** families of repeated content. Only three need an edit; the rest are correctly pointed and should be left alone.

| Family | Where it appears | Verdict | One-line fix |
|---|---|---|---|
| **The NF register (id + name + authority impact)** | `24` §5 (definitions) · `25` §4.2 + §4.2a (index) · `26` §4 (adoption ledger NF-051…062) · `29` §B.1(b) (NF-063…070) · `30` §3 (NF-071…075) | **Correctly layered** — 24 owns, 25 indexes (names only, no authority impact), 26/29/30 record *how each row entered* with sources doc 24's Dependencies blocks do not carry | Keep. Only `30:210` (says the rows "will land") is wrong — see below. No doc restates §6.3's impact counts, which is the right split. |
| **Authority-impact counts (50/3/12/10)** | `24` §6.3 (owner) · `29` Part G (70-era copy) · `29` Part G.2 (75-era copy) | 29's two copies are audit evidence, not restatements | Add one "(superseded by G.2)" marker to Part G — finding below. Owner stays 24 §6.3. |
| **The sixteen Part D insertions** | `26` §5 (the queue) · `29` Part D (verbatim text) · `29` G.2 (fold record) · `_conventions` RC-13(b) + RC-15(a) | **Four restatements of one fact.** RC-15(a) adds nothing RC-13(b) lacks | Trim RC-15(a)(a) to "as RC-13(b) states, the sixteen insertions are folded; Part D remains the historical copy." Owner: 29 Part D (text) + RC-15 (ruling). |
| **Status ladder** | `_conventions` §8 (owner, "mandatory") · `25` §2.1/§2.2 · `00` :55 · `24` §1/§3.1 · `28` :5 | 25/24/00 restate correctly; **28 invents a different ladder** | Fix `28:5` — finding below. |
| **"What is built"** | `00` :57 · `24` :18/:1340/:1344 · `25` :3/:902 · `27` §13 · `28` (owner) | 00/24/25 carry dated RC-13 notes; **27 carries none** | Replace `27` §13 with a pointer — finding below. |
| **CM-1…CM-14** | `26` §2.5 (prose decision) · `24` NF-051 ("preview of the rules") · `29` Part D §09 (verbatim table) · `27` §7.3 (pointer) | Correct after adoption — doc 09 is the contract owner, 29 Part D the historical copy | Add "rule text lives in `docs/09`; this is the historical copy" to `24` NF-051 and `26` §2.5. |
| **Gate catalogue** | `24` §3.5 (names, owner) · `25` §3 (per-phase subsets) · `27` §3.2 ("summary", points at 16 §2.4) · `16` §2.4 (full catalogue) | Correctly layered | None. |
| **A.9 second-wave six** | `24` §4.9 · `30` :3/:177 · `_conventions` RC-15(c) · `00` :30 | Correct except two wrong "§4.1" pointers | Findings on `24:1083`, `24:1340`, `30:177`. |

**Only one true duplicate needs collapsing:** RC-13(b) vs RC-15(a) in `_conventions.md` (below). Everything else is a class-appropriate pointer chain and should not be "de-duplicated" further.

---

## docs/24-feature-catalog.md (1360 lines; §1–§13, A.1–A.9, NF-001…NF-075)

`docs/24-feature-catalog.md:20` — **CONTRADICTION (internal) + STALE** — The document-ownership paragraph says the set numbers documents `00`–`25`, that only `00`–`16`, `24`, `25` "exist at this revision", that `_conventions.md` §11 carries "eight ratified cross-document rulings (`RC-1` … `RC-8`)", and that the §3 capability IDs/events/gates "are **not** registered". All four are false today: docs `26`–`30` exist (§3.6 :133 itself says "fifteen"), `_conventions` §11 holds RC-1…RC-15, and §3.4 :99/:1348 say the very names in §3 *are* registered as Reserved (RC-11). — **Fix:** replace with: "The set is documents `00`–`30`; `00`–`16` and `24`–`30` exist, `17`–`23` remain unassigned (§13 gap 1). `_conventions.md` §5 carries 34 canonical + 16 Reserved capability IDs, §6 44 canonical + 17 Reserved event names, §11 **RC-1…RC-15**. The §3.3/§3.4 lists are Registered as Reserved (RC-11) and are promoted on first implementation."

`docs/24-feature-catalog.md:76` — **STALE** — §3.3's lead-in still says "Not registered by this change (see §1)", which is the pre-RC-11 state §13 :1348 has already corrected to "Both lists are now registered as **Reserved**". — **Fix:** "Registered as Reserved in `_conventions.md` §5 (RC-11); promoted to canonical in the change that first implements each feature."

`docs/24-feature-catalog.md:292` — **STALE / DEAD REF** — A.6's source line says forgecode has "no separate report; every path below was read from the tree", but a full first-pass report exists at `docs/audit/audit-forgecode-report.md` (348 lines) and `29` §A.1 declares the "NO REPORT" gap closed. — **Fix:** "`source: /data/home/forge/repo-tour/forgecode`; full first-pass report `docs/audit/audit-forgecode-report.md` (`29-final-audit.md` §A.1 cluster 1)."

`docs/24-feature-catalog.md:166,189,219,244,268` — **DEAD REF (latent)** — A.1–A.5 cite `/tmp/opencode-report.part1.md`…`part3.md`, `/tmp/codex-report.md`, `/tmp/grok-build-report.md`, `/tmp/DeepSeek-Reasonix-report.md`, `/tmp/oh-my-pi-report.md`. `/tmp` is non-durable (the same set already lost `opencode-report.part4.md`'s content and `29` :28/:56 records the migration). — **Fix:** cite the in-repo copies: `docs/audit/pass2/<same-name>.md` (all five verified present).

`docs/24-feature-catalog.md:361` — **DEAD REF** — A.9.1's home lists the ACI rule ids as "`R-tools-56/57`", but at adoption the rendering/state-line rules were renumbered to **`R-tools-57`** and **`R-tools-58`** (`29` :161; `docs/09-tools.md:208,220,221`), because `R-tools-56` is doc 09's own workspace-write rule. The cited ids name the wrong rules. — **Fix:** "`R-read-window-1…4`, `R-edit-window-1/2`, `R-edit-lint-1`, `R-grep-summary-1`, `R-tools-57/58`".

`docs/24-feature-catalog.md:857` — **DEAD REF (registry violation)** — NF-053 declares capability IDs `verify.run`, `test.run`, `lint.run`. None of the three exists in `_conventions.md` §5 (34 canonical), §5's Reserved block (16), or this document's §3.3 (16) — they appear only in the upstream wshobson source report (`docs/audit/pass2/deep-wshobson-report.md:865`). Rule R4 requires a home to name a registered ID, and §1/RC-11 forbid unregistered coinages. — **Fix:** either (a) "`terminal.run` (test/lint/repro execution), `files.patch` (restore), `receipt.read` `[planned]`", or (b) add `verify.run`, `test.run`, `lint.run` as three more §3.3 rows + `_conventions.md` §5 Reserved, and bump §6.3's "16" to 19.

`docs/24-feature-catalog.md:1052` — **DEAD REF** — NF-074's dependency line cites "`R-tools-56`" for output spilling/truncation hints; that id is doc 09's *no-write-outside-workspace* rule. The rule NF-074 depends on is the rendering rule, now `R-tools-57`. — **Fix:** "`R-tools-57`".

`docs/24-feature-catalog.md:1083` — **DEAD REF** — §6.1's table row says "A.9 addendum (§4.1, six sources)". `§4.1` is A.1 opencode; the addendum is **§4.9** (`:355`). — **Fix:** "(§4.9, six sources)".

`docs/24-feature-catalog.md:1111` — **STALE (count, R12 violation)** — §6.3 says "CI gate rows named (§3.5) | **18 rows, 19 distinct gates**". §3.5 `:111`–`:127` contains **17** rows and **18** distinct gate names (`gate:file-size` / `gate:function-size` share one row). Counts must be derived, not typed (R12). — **Fix:** "17 rows, 18 distinct gates".

`docs/24-feature-catalog.md:1223` — **CONTRADICTION (internal)** — §10 item 4 says "The **five** learning-loop features (`NF-008`, `NF-010`, `NF-033`, `NF-034`, `NF-035`) are `none`". §5's lead-in `:379` says six and names **NF-075**; §6.3 `:1108` says six; `_conventions` RC-15(b) adds NF-075 to the set. Omitting NF-075 here leaves the newest learning feature outside the fence that §10 item 4 exists to state. — **Fix:** "the six learning-loop features (`NF-008`, `NF-010`, `NF-033`, `NF-034`, `NF-035`, `NF-075`)".

`docs/24-feature-catalog.md:1340` — **DEAD REF** — §13's evidence sentence cites "the second-wave six in **§4.1** A.9". Same wrong section as `:1083`; A.9 is §4.9. — **Fix:** "in §4.9 A.9".

`docs/24-feature-catalog.md:1344` — **STALE (reads as current)** — §13's first status row gives evidence "Upstream citations per row; **no HorizonCode code exists**". Code does exist (285 TS + 17 Rust, `28` §1) — the true statement is the narrower one §1357 makes. — **Fix:** "no HorizonCode code implements a Section A row; built slices are owned by `28-implementation-status.md`."

`docs/24-feature-catalog.md:1266-1334` — **CONTRADICTION (completeness)** — §12.2 promises "tests that prove the new features once they exist" and carries 67 items, but **eight** NF rows have no item: **NF-015, NF-027, NF-037, NF-041, NF-043, NF-046, NF-047, NF-048** (verified by extracting every `**NF-###` from the list). R7/§8.1 make an unsupported row a spec defect, and `gate:doc-status` has no test to point at for those eight. — **Fix:** add one line under the §12.2 heading: "NF-015, NF-027, NF-037, NF-041, NF-043, NF-046, NF-047, NF-048 are proven by the §12.1 gates (`gate:cross-plane-abi`, `gate:receipt-coverage`, `gate:frontend-parity`, `gate:doc-status`, `gate:provenance`, `gate:kernel-pin`) rather than by a dedicated item", or add eight items and bump §6.3/§13 to 75.

*Verified clean in doc 24 (no action):* §6.1 row counts recomputed per agent and in total (117 / 36 / 79 / 2 / 123); §6.3 feature count 75 and the `none`=50 split (46 strict + 4 bold); §3.3 = 16 rows; §3.4 = 17 reserved names; §3.6 lists RC-1…RC-15; §7.1's two rejects match §6.1's `Reject` total; §12.2 numeric continuity 1→67.

---

## docs/25-roadmap-and-glossary.md (942 lines)

`docs/25-roadmap-and-glossary.md:20` — **STALE + DEAD REF** — "the **current** `00-index.md` still describes this document as a '`P0`–`P7` roadmap'" is false: `00-index.md:31` reads "M0–M8 roadmap (Foundation → Self-improvement)". The same sentence points at "§8 (OQ-R4)" for the mapping; OQ-R4 is the docs-17–23 gap — the mapping lives in **OQ-R1**, which is marked **Closed** at `:892` and repeated in §10 `:925`. — **Fix:** replace the paragraph with: "**Phase-id reconciliation (closed).** Earlier drafts used `P0`–`P7`; the plan of record is `M0`–`M8`. The mapping (P0→M0 · P1+P3→M2 · P2→M1 · P4→M4 · P5→M5 · P6→M3 and M6 · P7→M7 and M8) is recorded in §8.2 OQ-R1, and `00-index.md` now describes this document as the `M0`–`M8` roadmap."

`docs/25-roadmap-and-glossary.md:55` — **STALE** — role table: "`spec-owner` | Documents `01`–`25`". The set runs `00`–`30`. — **Fix:** "Documents `00`–`30` (the class of each per RC-14)".

`docs/25-roadmap-and-glossary.md:478` — **STALE** — §4.1 says "Documents `00`–`16`, `24` and `25` **exist at this revision**". Six more exist (`26`–`30`) and are listed in `00-index`. — **Fix:** "Documents `00`–`16` and `24`–`30` exist; the `17`–`23` rows below are proposals."

`docs/25-roadmap-and-glossary.md:509` — **DEAD REF** — §4.2's lead-in says the partial-scope rule is "see §8 **OQ-R7**". §8.2 defines only OQ-R1…OQ-R5; there is no OQ-R6 or OQ-R7. The rule is **OQ-R3**. — **Fix:** "see §8.2 OQ-R3".

`docs/25-roadmap-and-glossary.md:894` — **CONTRADICTION (internal)** — OQ-R3 enumerates the partial-claim features as NF-015, 019, 023, 026, 031, 033, 039, 041, 042, 046, 048, 049, and calls that the set that "each have a partial phase and a completion phase". §4.2's phase column shows **three more** two-phase rows: NF-006 (`M1 (TUI, headless) → M3`), NF-009 (`M1 (read) → M2 (dry-run)`) and NF-011 (`M0 (scheme) → M1 (resolution)`), and NF-026/NF-027 are single-phase (`M1`) while OQ-R3 lists NF-026 as partial. A register that under-counts is the defect it exists to prevent. — **Fix:** add NF-006, NF-009, NF-011 to OQ-R3's list and drop NF-026 (or change §4.2's NF-026 cell to `M1 → M2`); state the count ("fifteen features").

`docs/25-roadmap-and-glossary.md:908` — **STALE** — §9's status row: "Feature index (`NF-001`…`NF-050`) | `DESIGNED` | §4.2". The index now runs to NF-075 across §4.2 + §4.2a. — **Fix:** "Feature index (`NF-001`…`NF-075`) | `DESIGNED` | §4.2 + §4.2a; definitions owned by `24` §5".

`docs/25-roadmap-and-glossary.md:929` — **STALE** — §10's related-docs row describes doc 24 as "new features (Section B, `NF-001`–`NF-050`)". — **Fix:** "`NF-001`–`NF-075`". (The same table also has no row for `30-steal-list.md` although 28/29 are listed — add "`/data/home/forge/hzcode/docs/30-steal-list.md` | the adoption queue RC-15(d) makes live".)

`docs/25-roadmap-and-glossary.md:940` — **STALE** — the derivation line cites "`_conventions.md` (names, status ladder, **RC-1…RC-8**)". — **Fix:** "RC-1…RC-15 (RC-5, RC-7, RC-8, RC-10, RC-14 and RC-15 are load-bearing here)".

`docs/25-roadmap-and-glossary.md:267-281` — **CONTRADICTION (with doc 27)** — §3.5 M4's deliverable list (M4-D1…M4-D11) is provider/compiler/memory/compaction/vault/pricing/observability. `27` §3.1 assigns **V4 = M4** and puts `Code Mode v2` (NF-051), `ACI windowed terminal` (NF-052), `preview environments` (NF-055), `debug recorder` (NF-054) and the governance loop (NF-053) in it. §4.2a has no phase column, so **the only sequencing statement for NF-051…NF-055/062 is doc 27's**, which doc 25 — the document that owns "the delivery order" (§1 item 1) — does not carry. — **Fix:** add `M4-D12 | Code Mode v2, ACI reading modes, preview environments, execution recorder, pre-submit governance (NF-051…NF-055) | 27 §3.1 (V4); docs 09/11/14` and `M4-D13 | Composer/review UX, tool-result dual output, instruction epochs (NF-059…NF-062) | docs 05/10/13/14`, or add a "Phase" column to §4.2a.

*Verified clean in doc 25 (no action):* §4.2a has exactly 25 rows NF-051…NF-075 with no gaps or duplicates; §4.2's 50 rows NF-001…NF-050 are contiguous; §2.1's ladder matches `_conventions` §8 verbatim; §4.3's 16 ADRs match §1's ADR-001–ADR-016 claim; the `[planned]` doc-18/21/22 references are honestly marked.

---

## docs/26-learning-synthesis-2.md (206 lines — historical class, RC-14)

`docs/26-learning-synthesis-2.md:3` — **CONTRADICTION (reads as current)** — the status line reads "**Learning record + adoption ledger.** Every claim below was read out of a cloned repository … **nothing in this document is implemented**". That blanket negative is no longer true as a current statement. Two of the features this document *is* the learning record for now have built, TESTED+VERIFIED slices: NF-051 code mode and NF-055 preview (`28` :22–23, "VERIFIED (NF-015, NF-051)" / "VERIFIED (NF-055)"), which `24` §13 :1345 and `25` :564 both acknowledge as "reduced forms". Doc 26 carries no RC-13 reconciliation note — the queue note at :170 addresses the *insertions*, not the status ceiling. — **Fix:** append to the status line: "**Implementation status (RC-13):** this record's claims are design-level; the only features here with built slices are NF-051 (code mode) and NF-055 (preview), whose levels are owned by `28-implementation-status.md`."

`docs/26-learning-synthesis-2.md:164` — **CONTRADICTION (falsified "Applied" row)** — the §5 "Applied in this pass" ledger claims `13-tui.md` received "Composer queue edit/reorder, **bulk Keep All/Undo All, code-language detection, attachment chip previews**". `docs/13-tui.md` contains exactly one NF-062 row (R197, `:390`, queue edit/reorder) and **zero** occurrences of "Keep All", "Undo All", "Undo" or "language detection". Three of those four items landed in **`14-surfaces.md` §2.12** (`:277`–`:282`) via the D-14 insertion, not in doc 13. — **Fix:** split the row: "`13-tui.md` | Composer queue edit/reorder (R197). **Correction (adoption):** bulk Keep All/Undo All, compaction UX and preview surface landed in `14-surfaces.md` §2.12 (D-14, RC-15) — not in doc 13."

`docs/26-learning-synthesis-2.md:162` — **STALE (historical, tolerated)** — "Section C counts recomputed (50 → 62)". Current is 75 (`24` §6.3). This row is past-tense ("Applied in this pass") and RC-14 gives it no normative force, so it may stand — but a reader landing here has no forward pointer. — **Fix (one clause only):** "Section C counts recomputed (50 → 62 at this pass; 75 today — `24` §6.3)".

`docs/26-learning-synthesis-2.md:198` — **CONTRADICTION (same family as :3)** — §7 says "everything above is DESIGNED or VERIFIED (facts read from sources / measured installs) — nothing claims implementation". True of the *document's* claims, false as a reader would apply it to NF-051/NF-055. — **Fix:** add "(see the RC-13 note at the head of this document for the two features that now have built slices)".

`docs/26-learning-synthesis-2.md:11` — **DEAD REF (latent)** — the five report paths are `/tmp/deep-*-report.md`; all five still resolve today, but they are volatile by construction (the same pass's `opencode-report.part4.md` is already empty). `29` :56 records that these were copied into `docs/audit/`. — **Fix:** cite `docs/audit/pass2/deep-wshobson-report.md`, `…/deep-openhands-report.md`, `…/deep-sweagent-aci-report.md`, `…/deep-codemode-report.md`, `…/deep-opencode-v2-report.md` (all verified present, 5,115 lines total).

*Verified clean in doc 26 (no action):* §4's NF-051…NF-062 authority impacts agree with `24` §6.3 (5 `none`, 2 `kernel` = NF-051/NF-053, 4 `grant-bearing` = NF-054/NF-055/NF-058 is kernel… see note); §4's target-doc column matches `25` §4.2a's owning-doc column row for row; NF-051's dependencies match `24` NF-051; the reserved-name list at :154 matches `_conventions` §5/§6 exactly (2 IDs + 4 events).

> Note on the one row worth a second look: `26` :148 gives NF-058 the impact "authority (merge lattice extension; never widens)" while `24` NF-058 `:903` says `kernel` — consistent. `26` :143 gives NF-053 "kernel-visible" and `24` :858 says `kernel` — consistent. No number in §4 contradicts §6.3.

---

## docs/27-implementation-plan.md (416 lines)

`docs/27-implementation-plan.md:402-409` — **CONTRADICTION (with RC-13 and doc 28) — the largest single defect in this set.** §13 states "**All spec-level capabilities remain DESIGNED**; the following are the only items this plan claims above DESIGNED" and its last row says "Everything else in this document | DESIGNED". Doc 28 — which RC-13(a) makes "the only place a level above `DESIGNED` may be claimed" — records ten areas above DESIGNED (kernel VERIFIED, contracts VERIFIED, runtime core TESTED+VERIFIED, providers VERIFIED, tools TESTED+VERIFIED, TUI VERIFIED, launcher VERIFIED, skills VERIFIED, subagents VERIFIED, code mode VERIFIED, preview VERIFIED) with 285 TS + 17 Rust tests green. Doc 27 also *plans* V4 work (§3.1 :84) that doc 28 says shipped. `29` Part E :323 marked doc 27 "none found / checked clean", so this ceiling was never reconciled. — **Fix:** replace §13's preamble with: "Implementation levels are owned by `28-implementation-status.md` (RC-13); this plan claims no level itself. §6.2's toolchain viability and §6.3's clone availability are the only items this document evidences, and both are recorded there." Keep the three-row table, delete the "Everything else … DESIGNED" row.

`docs/27-implementation-plan.md:84` — **CONTRADICTION (with doc 28)** — V4's goal line lists "**Code Mode v2**, ACI windowed terminal, plan/goals/todos, fleets v1, teams v1, **preview environments v1**, debug recorder v1" as work to be done at V4, but `28` :22–23 mark code mode (NF-015/NF-051) and preview (NF-055) **VERIFIED** today, and `24` §13 / `25` :564 call them "reduced v1 slices". — **Fix:** append to the V4 cell: "(NF-051 code mode and NF-055 preview have reduced v1 slices shipped — `28` §1; V4 completes them)".

`docs/27-implementation-plan.md:131-142` — **CONTRADICTION (internal, naming)** — the §4.1 layout names crates `hz-core/`, `hz-receipt/`, `hz-effect/` and directory `crates/hzk/`, then :142 asserts "Package and crate **names** are frozen by `docs/_conventions.md` §3/§4". §4 of `_conventions.md` defines none of those three: it has `hz_kernel`, `hz_abi`, `hz_sandbox`, `hz_policy`, `hz_native`, `hz_shell`, `hz_edit`, `hz_diff`, `hz_ast`, `hz_vcs`, `hz_walker`, `hz_index`, `hz_pty`, `hz_voice`, `hz_sdk`, `hz_codegen` (and `_conventions` §1 says the kernel *process/asset* is `hzk`, not a crate). Three of the four named crates are inventable names that `_conventions` §1 forbids. — **Fix:** `crates/hz_kernel/` (binary target `hzk`), `crates/hz_abi/` ("shared types"), `crates/hz_sandbox/`, and fold "receipt ledger + effect host" into `hz_kernel` (which §4 already says owns "receipts, effect host").

`docs/27-implementation-plan.md:12` — **STALE** — "The spec set (`docs/00`–`docs/25`) defines *what* HorizonCode is." — **Fix:** "`docs/00`–`docs/30` (the design corpus is `00`–`25`; `26`–`30` are the learning, plan, status, audit and queue documents — RC-14)".

`docs/27-implementation-plan.md:34` — **DEAD REF** — IP-8 says "see §12 doc-update ledger in `docs/26-learning-synthesis-2.md`". Doc 26 has no §12; its doc-update ledger is **§5** (:156). Doc 27's own §12 is the open-questions/ADR table. — **Fix:** "see the doc-update ledger in `docs/26-learning-synthesis-2.md` §5".

`docs/27-implementation-plan.md:207` — **STALE (arithmetic + count)** — "all **ten** reference clones completed (eight earlier + OpenHands, SWE-agent, wshobson/agents, opencode-v2)" lists **12** repositories and calls them ten; `/data/home/forge/repo-tour/` today holds **15** (the twelve of doc 29 §0 plus aider, mini-swe-agent, hermes-agent from the pass-3 dives). — **Fix:** "all fifteen reference clones completed (the eight of the first tour + OpenHands, SWE-agent, wshobson/agents, opencode-v2 + aider, mini-swe-agent, hermes-agent)".

`docs/27-implementation-plan.md:407` — **STALE** — §13 row: "Source availability of all **ten** reference repositories | **VERIFIED**". — **Fix:** "all fifteen reference repositories (see §6.2)".

`docs/27-implementation-plan.md:270` — **DEAD REF** — "adopt with the CM-1…CM-14 rules from the deep-dive (`docs/26` **§Code Mode**)": doc 26's section is **§2.5** ("Code Mode (opencode … ) — decision: ADOPT, DEEPEN, CHANGE three things"); no section is titled "Code Mode". Since adoption (RC-15) the normative text is doc 09. — **Fix:** "the CM-1…CM-14 rules now owned by `docs/09-tools.md` (source: `docs/26` §2.5; verbatim copy `docs/29` Part D §09)".

`docs/27-implementation-plan.md:390-396` — **DEAD REF (id collision)** — §12 opens `OQ-I1`…`OQ-I7` for the plan's own questions (code-mode engine, preview runtime, recorder, workflow config, tier parity, speculative decoding, container abstraction). `docs/25` §8.1 already owns `OQ-I1`…`OQ-I5` as *inherited* open questions (universal read receipts, doc 05/06/07/12 items) and `25` :895 depends on those ids. Two registers now disagree about what `OQ-I1` means, and both are cited elsewhere ("blocking for M2", "blocks V4"). — **Fix:** renumber doc 27's set to `OQ-P1`…`OQ-P7` (plan-created) and add one line to §12: "`OQ-I1`…`OQ-I5` in `25-roadmap-and-glossary.md` §8.1 are a different register (inherited questions); these are plan-created."

*Verified clean in doc 27 (no action):* R-impl-1…R-impl-24 numbering is contiguous; §3.2's gate schedule is declared a summary that defers to `16` §2.4 (correct layering); §9.1's 202-agent census (14 allowlists ⇒ 93 % declare none) agrees with `26` §2.1; V0–V7 → M0–M8 mapping matches `25` §3.0.

---

## docs/28-implementation-status.md (77 lines — implementation-status owner, RC-13)

`docs/28-implementation-status.md:5` — **CONTRADICTION (with `_conventions` §8, which is "mandatory on every capability")** — doc 28 defines its own ladder: "**DESIGNED** → **IMPLEMENTED** (code exists and builds) → **TESTED** → **VERIFIED**". `_conventions` §8 fixes six levels — `DESIGNED → CODE_PRESENT → WIRED → TESTED → VERIFIED → RELEASED` — and RC-14 assigns "status levels" to `_conventions` as the authority. Doc 28 invents a synonym (`IMPLEMENTED` for `CODE_PRESENT`) and silently drops `WIRED` and `RELEASED`; its rows then claim `TESTED + VERIFIED` for capabilities that also satisfy §8's `WIRED` criterion (a real call path), so the two documents cannot be mechanically reconciled by `gate:doc-status`. — **Fix:** "Status ladder per `_conventions.md` §8: `DESIGNED` → `CODE_PRESENT` (named below as **IMPLEMENTED** where the row's evidence is 'code exists and builds') → `WIRED` → `TESTED` → `VERIFIED` → `RELEASED`. Only `TESTED` and `VERIFIED` are claimed below."

`docs/28-implementation-status.md:3` — **STALE** — "the single map from the design corpus (**docs 01–27**) to implementation reality". The corpus is 01–30; 29 (the audit) and 30 (the queue) both post-date the snapshot and both cite this file. — **Fix:** "(docs 01–30; the design corpus proper is 01–25)". Optionally add a related-docs line pointing at `29` (audit of record) and `30` (adoption queue), which this file currently does not mention at all.

`docs/28-implementation-status.md:24` — **STALE** — the catch-all row is titled "**Everything else in docs 01–27**". — **Fix:** "docs 01–30". (The row's *content* is correct and is exactly what `27` §13 contradicts: it lists "execution recorder, ACI windowing" as DESIGNED ONLY, matching `24` NF-052/NF-054.)

*Verified clean in doc 28 (no action):* 285 pass / 0 fail / 27 files (:35) and 14 integration + 3 unit (:13, :70) reproduce the ground truth exactly; :22–23's NF-015/NF-051 and NF-055 attributions match `24` §13 and `25` :564; :70–73's "keep this file honest" rule is the RC-13 mechanism itself.

---

## docs/29-final-audit.md (386 lines — audit of record, historical class; Parts A–G)

`docs/29-final-audit.md:338-353` — **STALE (a superseded table with no marker)** — Part G ("Re-audit (verification round)") presents six result rows that a reader will take as current verification, and four of them are pre-adoption numbers: "Register integrity … **70 ids, NF-001…NF-070**" (:347), "docs/25 index … **20 rows (NF-051…NF-070)**" (:349), "Recount gate … **46 `none` + 3 + 12 + 9 = 70**" (:348), "Stale-number sweep … doc 24 §6.4 '117 rows and 62 features' → **70 features**" (:350). Current: 75 ids (NF-001…NF-075), 25 rows in §4.2a, 50 `none` (46 strict + 4 bold) + 3 + 12 + 10 = 75. **Part G.2 in the same document** (2026-11-07) states the correct values at :373, so the doc contradicts itself across two dated sections with nothing marking the earlier one dead. — **Fix:** insert one line under the Part G heading: "**Superseded by Part G.2 (2026-11-07 adoption round).** The register/index/recount rows below are the 2026-11-06 pre-adoption state — 70 ids, 20 index rows, 70 features. Current values: 75 ids (NF-001…NF-075), 25 rows in `25` §4.2a, impacts 50 `none` + 3 + 12 + 10 = 75 (`24` §6.3)."

`docs/29-final-audit.md:94` — **STALE (present tense)** — §B.1(b) closes with "All eight are now written into `24-feature-catalog.md` §5 … **counted in §6.3 (70 features), tested in §12.2 (tests 55–62)**, and indexed in `25-roadmap-and-glossary.md` §4.2a." The counts are current-tense claims and are wrong today (75 features; §12.2 items 55–62 are now 63–70 after the NF-071…075 insertions shifted nothing but the totals — i.e. items 55–62 are still NF-063…NF-070, but the *totals* quoted are stale). — **Fix:** "…counted in §6.3 (70 features at this audit; **75 today**), tested in §12.2 (items 55–62, now 55–62 of 67), and indexed in `25-roadmap-and-glossary.md` §4.2a (20 rows at this audit; **25 today**)."

`docs/29-final-audit.md:121` — **STALE (low)** — Part C.2 C-7: "The **NF-051…062** range is the capability increment of this cycle". Since RC-15 the capability increment of this cycle is NF-051…NF-075. — **Fix:** "The NF-051…NF-075 range is the capability increment of this cycle (NF-051…062 here, NF-063…070 §B.1(b), NF-071…075 `30` §3)."

*Verified clean in doc 29 (no action — these were checked by command, not assumed):* clone inventory 67,083 files; six delta reports' line counts 348/846/377/500/524/810 = 3,405 (:346 reproduces exactly); pass-2 preservation 5,115 lines (:351 reproduces exactly); §A.1's 270 = 16+28+27+26+131+42; Part D :161's R-tools remap agrees with `09-tools.md:208`; Part D §09's `R-tools-56`/`R-tools-57` labels are correct *within Part D* because :161 states the remap in place; Part G.2 :373's 75-id count matches `24` §6.3 exactly; :385–386's pointers to `30` and `AUDIT.md` both resolve.

---

## docs/30-steal-list.md (211 lines — adoption queue, historical class)

`docs/30-steal-list.md:210` — **STALE** — the related-documents row reads "`24-feature-catalog.md` — Section B, where **NF-071… candidates will land**". They landed on 2026-11-07: `24` §5 carries NF-071…NF-075 (`:1019`–`:1062`), RC-15(b) ratifies them, and :3/:165 of this document already say "adopted". Three sentences in one file disagree. — **Fix:** "`24-feature-catalog.md` — Section B rows `NF-071`…`NF-075` (adopted; RC-15(b)) and the `A.9` addendum these sources are recorded in."

`docs/30-steal-list.md:177` — **DEAD REF** — "the six second-wave sources are recorded in the **A.9 addendum** (doc 24 **§4.1**; RC-15)". `§4.1` is A.1 opencode; the addendum is **§4.9** (`24` :355). — **Fix:** "(doc 24 **§4.9**; RC-15)". (Same wrong pointer also at `24` :1083 and `24` :1340 — three occurrences of one error.)

`docs/30-steal-list.md:53,70,72,78,115` — **CONTRADICTION (unresolved placeholder ids)** — §2's disposition column still carries the pre-adoption candidates:
- `:53` B-1 "…(algorithm upgrade; proposes NF candidate **N-1**)",
- `:70` C-4 "extends doc 08 (loop rails; proposes NF candidate **N-2**)",
- `:72` C-6 "**new capability** (proposes NF candidate **N-3**)",
- `:78` C-12 "**new capability** (proposes NF candidate **N-4**)",
- `:115` G-1 "**new capability** (proposes NF candidate **N-5**); extends NF-010/033",

while §3 (`:167`–`:173`) adopts those same five as **NF-071 (C-12/D-…), NF-072 (C-6), NF-073 (C-2/C-4/C-5/B-8), NF-074 (B-6/B-7/C-7), NF-075 (G-1…G-4)**, and `:175` says the extend-only notes (including the repo-map algorithm, i.e. B-1) were "folded into the owner documents". A reader following a row's own cross-reference lands on an id that exists nowhere. — **Fix:** one line under the §2 heading: "**Candidate resolution (RC-15):** `N-1` → folded as an extend-note into `docs/09` (`repo_map` ranking); `N-2` → **NF-073**; `N-3` → **NF-072**; `N-4` → **NF-071**; `N-5` → **NF-075**. The `N-*` ids are historical and resolve nowhere else." Optionally also rewrite the five cells to name the NF id.

*Verified clean in doc 30 (no action):* :3's "items 1–8 and 11 remain the live work plan" matches RC-15(d) and the §4 numbering (:185–:195 has 11 items, 9 and 10 struck as done); the four `docs/audit/pass3/*.md` report paths and all four clone directories (`aider`, `mini-swe-agent`, `hermes-agent`, `oh-my-pi`) exist; §1's four oh-my-pi verdicts are internally consistent with §2 C-6's "claim-verified" note; :169–:173's per-row `(§2 item)` citations all resolve to real rows in §2.

---

## docs/_conventions.md (165 lines)

`docs/_conventions.md:162,164` — **SUPERSET (one fact, two rulings)** — RC-13(b) states the full sequence: the sixteen insertions were "carried **in full** in `docs/29` Part D; they were folded into their owner documents by the adoption revision of 2026-11-07 (RC-15), and Part D remains the historical verbatim copy". RC-15(a) then states it again: "the sixteen Part D insertions are folded into their owner documents … Part D remains in `docs/29` as the historical copy." RC-15 is the later ratification and should inherit, not repeat. — **Fix:** shorten RC-15(a) to "**(a) As RC-13(b) records,** the sixteen Part D insertions are folded; Part D remains the historical copy." (Keeps one owner of the fact and stops the pair drifting apart on a future edit.)

`docs/_conventions.md:162` — **CONTRADICTION (scope of RC-13(a))** — RC-13(a) names the documents that carry stale blanket claims as "documents `01`–`16`, `24`, `25`" and says "Status notes dated 2026-11-06 in those documents carry this reconciliation." Doc `26` (:3/:198) and doc `27` (§13 :402) carry the same defect with **no** reconciliation note, and `29` Part E explicitly cleared doc 27 ("none found"). The scope clause therefore under-describes the problem it exists to close. — **Fix:** append to RC-13(a): "The same reconciliation applies to `26` (learning record) and `27` (plan), whose blanket 'nothing is implemented / all DESIGNED' statements are historical; neither may state an implementation level — that is `28`'s alone."

`docs/_conventions.md:95` — **DEAD REF (cross-document)** — the Reserved capability-ID list is 16 names and does not include `verify.run`, `test.run`, `lint.run`, which `24` NF-053 (:857) presents as its capability IDs. This is the receiving end of the `24:857` finding above: either the list grows by three or NF-053 is rewritten. — **Fix (if the IDs are kept):** add `verify.run`, `test.run`, `lint.run` to §5's Reserved block, bump `24` §3.3 to 19 and `24` §6.3's "16" accordingly.

*Verified clean in `_conventions.md` (no action):* §6's canonical event list is exactly **44** names and the stated count matches; the Reserved event block is exactly **17**; §5's canonical list is exactly **34** IDs and `24` :20's "34" is correct; §3/§4 package and crate tables are the authority the other docs' contradictions were measured against; RC-1…RC-15 are contiguous, each with a rationale and a target doc; §8's six-level ladder is the one doc 25 restates correctly and doc 28 diverges from.

---

## Summary

**Documents audited:** `_conventions.md`, `24`, `25`, `26`, `27`, `28`, `29`, `30` — all read in full (2,325 lines). `docs/17`–`docs/23` do not exist: they are marked `[planned]`/unratified in `24` §13 and `25` §4.1, and no document claims otherwise, so nothing in this set depends on a dead file link.

**48 findings** (three carry two class labels; the duplicate is filed under its contradiction):

| Class | Count | Findings |
|---|---|---|
| **CONTRADICTION** | 14 | `24` :20, :1223, :1266-1334 · `25` :894, :267-281 · `26` :3, :164, :198 · `27` :402, :84, :131-142 · `28` :5 · `30` :53…115 · `_conventions` :162 |
| **STALE** | 20 | `24` :76, :292, :1111, :1344 · `25` :20, :55, :478, :908, :929, :940 · `26` :162 · `27` :12, :207, :407 · `28` :3, :24 · `29` :338-353, :94, :121 · `30` :210 |
| **DEAD REF** | 13 | `24` :166/:189/:219/:244/:268, :361, :857, :1052, :1083, :1340 · `25` :509 · `26` :11 · `27` :34, :270, :390-396 · `30` :177 · `_conventions` :95 |
| **SUPERSET** | 1 | `_conventions` :162,164 (RC-13(b) vs RC-15(a)) |
| **DUPLICATE** | 1 (folded into the `26` :164 contradiction) | `26` :164 assigns doc 13 content that landed in doc 14 §2.12 |

**Per document:** `24` 13 · `25` 9 · `27` 9 · `26` 5 · `28` 3 · `29` 3 · `30` 3 · `_conventions` 3 · `23`–`17` n/a.

**Cleanest:** `docs/28` and `docs/_conventions.md` — every count in both reproduces exactly (285/0/27, 17 Rust, 44 events, 34 IDs, 16 Reserved IDs, 17 Reserved events, RC-1…RC-15), and their only defects are a status-ladder divergence (28) and one duplicated ruling (`_conventions`).

**Most defective:** `docs/27` — the only document that (a) claims a status ceiling RC-13 forbids, (b) invents crate names two sentences after saying the names are frozen elsewhere, and (c) reuses another document's open-question ids.

**Highest-value single fix:** `27` §13 → a pointer to `28`. It is the one place in the set where a reader is told "nothing is built" while a sibling document, a sibling status table and 302 green tests say otherwise. Second: `24` :361/:1052's `R-tools-56/57` → `R-tools-57/58`, because those two ids currently resolve to a *different* rule (workspace-write) rather than to nothing.

**Confirmed correct (checked by command, not by eye):** 75 NF rows with no duplicate or skipped ids; 67 §12.2 items, numbered 1→67; `25` §4.2a = 25 rows NF-051…NF-075; `24` §6.1 counts 117/36/79/2/123 recomputed row by row; `24` §6.3 impacts 50+3+12+10 = 75 and 46 strict `none` + 4 bolded `**none**`; `_conventions` §6 = 44 canonical + 17 Reserved events, §5 = 34 canonical + 16 Reserved IDs; `29`'s clone inventory, report line counts (3,405) and pass-2 preservation (5,115) all reproduce; all ten `file://` document links in the eight audited files resolve to existing files.
