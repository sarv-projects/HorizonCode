# AUDIT — re-audit of the HorizonCode specification set

Date: 2026-11-06. Scope: `README.md` + `docs/` (00–16, 24, 25, `_conventions.md`) — 21 files, ~19k lines.

Five audits were run after the documents were written: requirements traceability, cross-document consistency, competitive-parity completeness, and two adversarial technical hole-hunts. Where a sub-agent died (provider failures), the audit was completed directly with scripted checks; raw outputs are kept outside the repo (per-audit reports under `/tmp/audit-*.md` at the time of writing).

## 1. Requirements traceability — PASS

Every capability family in the original brief maps to a document section: providers/models.dev (10 §3), tools (09 + README §3.2), TUI fullscreen+mouse and headless (13, 14), MCP client with OAuth (07 §2.5, 15), sessions/resume/compaction/checkpoints/rewind (12), subagents/skills/commands/plugins/hooks (08, 15), permission postures (11; `--yolo` arguments are refused by design — 09 §, D-8), sandboxing (11 §S5 + matrix), auth/OAuth + keychain (10 R17–R20), config merge lattice (ADR-008), LSP/DAP (NF-042 broker), ACP (07 §4.5, 15), OTel + instruction files (16, 10 R121/R125), web/desktop (14), self-improvement (08, 24 NF-010), and each reference's signature capability (24 Section A).

Earlier draft flags resolved by inspection: **guardian / gRPC index / coordinator / Computer Hub / autolearn / prewalk / embedded bash / repolint / leader fencing** are all present (24 A.2/A.5/A.6/A.7 rows; 15 Rhai/plugins; 11 `tools/repolint`; 12 §leader arbitration + 14 S37). **AGENTS.md/ZH.md** instruction hierarchy is specced at 10 R121 (most-specific-last, untrusted-content rules).

## 2. Cross-document consistency — PASS after fixes

Scripted checks over all files found and fixed 5 real inconsistencies plus 1 gap:

| # | Finding | Fix |
|---|---|---|
| C-1 | Three distinct `hz.` namespaces (RPC methods in 07, OTel attribute names in 16, BLAKE3 digest domains in 11, storage/manifest keys) were undocumented next to event names | `_conventions.md` §1 gains the **five-namespace register** (only §6 names are events) |
| C-2 | 15 event names coined by DESIGNED features in doc 24 were unregistered | 13 registered as **Reserved names** (`_conventions.md` §6; RC-11); 2 withdrawn |
| C-3 | `hz.receipt.unknown` / `hz.receipt.reconciled` (doc 24) collided with the canonical `hz.effect.unknown` / `hz.effect.reconciled` | Doc 24 §3.4 corrected; the retired names are marked withdrawn (RC-11) |
| C-4 | 14 proposed capability IDs were unregistered | Registered as **Reserved capability IDs** (`_conventions.md` §5; RC-11) |
| C-5 | Physical path `…/state/hz.db::events` (doc 05) disagreed with the owned layout `hzcode.db` (doc 12) | Doc 05 corrected to `hzcode.db`; logical `hz.db::` table prefix retained per 12 §naming |
| C-6 | Scheduler had timezone but no DST edge semantics (doc 08 R-85) | R-85 extended: wall-clock occurrences, explicit `on_absent`/`on_repeat` policy recorded in `ScheduleJobV1` |

Verified clean: product name/binary/aliases everywhere; no lingering `P0–P7` phase names; event count fixed at **44** and consistent across `_conventions` §6, doc 06 (all three count claims) and doc 24; NF range `NF-001…NF-050`; ADR range `ADR-001…ADR-016`; status vocabulary confined to the ladder; docs `17–23` cited only as `[planned]`; no unresolved cross-references among existing documents.

## 3. Competitive-parity completeness — PASS

Doc 24 Section A carries **117 rows across all eight references** (36 Inherit / 79 Supersede / 2 Reject) with upstream paths; Section B carries **NF-001…NF-050**; Section D records 20 rejected techniques and 2 rejected upstream features with replacements. Name-resolution sweep (this audit) confirmed the signature capabilities of every reference — including those the traceability audit could not locate by name — are mapped in Section A.

## 4. Technical hole-hunt — PASS on spot-check

The two adversarial agents for this dimension died mid-run; the checklist was then verified directly against the documents. All checked points are specced:

| Check | Where it is answered |
|---|---|
| Lease TTL, one-use binding, crash between issue and settle | 12 (lease expires by TTL, tree inspected, `UNKNOWN` quarantined); 11 lease rules |
| Unanswered `ask` | 09 R-tools-30 + failure table: `permission.expired` ⇒ denial for settlement (never auto-yes) |
| Scheduler catch-up, double-fire, jitter, DST | 08 R-85…R-92 (occurrence journal before run; deterministic jitter; bounded `max_catch_up`) |
| Compaction overflow / checkpoint bounds | 12 S-47 (≤ 32 checkpoints, 64 MiB/snapshot, 512 MiB/session; refusal, not eviction); 10 single provider-visible checkpoint rule |
| Truncation / binary / huge files / pagination | 09 R-tools-42 (16 KiB model-facing cap, 1 MiB pane, 64 MiB stream cap, `OutputTooLarge`); read tool line ranges |
| Paste, resize, no-alt-screen, narrow terminal | 13 R7/R10/R23 + NF-029 (both renderers, restore on panic) |
| Cancel / partial write | 03 (batch settles as a unit); 14 S48 (cancellation ⇒ terminal or `UNKNOWN`, never unreported) |
| Budget exhaustion mid-tree | 06 flow 6.13 (child terminal `budget_exhausted`; no borrowing); 08 budget rules |
| Team deadlock | 06 flow (quiescence-with-no-progress ⇒ `status:'deadlock'` with wait graph); 08 R-runtime-80 (acyclic by construction; timeout the younger wait) |
| Reconciliation owner & deadline | 11 (explicit reconciliation procedure; `UNKNOWN` never auto-retried); 06 flow 6.8 |
| Sandbox residual: deny vs degrade | 11 (caller states minimum per dimension; fail-closed) + NF-016 |
| Worktree pool exhaustion | 06 flow 6.13 (no new node launches; graph state returned for resume) |

## 5. Verdict

**No blockers. The spec set is internally consistent, traceable and complete as a design baseline.** The only thing “missing” is the one thing a specification cannot contain: implementation evidence. Every capability is `DESIGNED`; documents `17–23` are reserved-but-unwritten proposals tracked in `25-roadmap-and-glossary.md` §8; MCP/ACP revision pinning and similar items are recorded as open questions per document rather than hidden.
