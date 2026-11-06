# Audit reports — 2026-11-06 final audit

> **Document class: historical evidence** (per `_conventions.md`). These six reports are the raw, file-cited source material for `29-final-audit.md` (Parts A–C and the B.1 register append). They carry no normative force; where a report and the spec set disagree, the spec set wins and the disagreement is a defect to report.

## What is here

Six delta audits over all twelve reference clones under `/data/home/forge/repo-tour/`, dispatched and delivered during the final audit. Each report states its own coverage stats (directories walked, files opened, explicit NOT-READ list) and every claim is tied to a file path in the clone.

| Report | Repos | Finding count | Highlights |
|---|---|---|---|
| `audit-forgecode-report.md` | forgecode (first full report) | 16 uniques | policy DSL; patch fallback ladder; hook-enforced stop guards; snapshot `undo`; resumable subagents; request-asserting evals |
| `audit-horizoncode-report.md` | horizoncode (ancestor; first full report) | 28 uniques | ToolBatch admission; guarded checkpoint restore; UNKNOWN discipline; ContextLedgerV2; sandbox guarantee vector; 942 KB implementation journal |
| `audit-opencode-delta.md` | opencode + opencode-v2 | 27 missed, 25 uniques | TUI plugin host; shell scanner + arity dictionary; goal loops; cache-TTL warming; staged undo/redo; three real v2 defects |
| `audit-claude-codex-delta.md` | claude-code + codex | 26 missed | 27-event hook taxonomy ×4 types; managed-settings schema; fail-closed shell AST; `/btw`; guardian/auto-review; Starlark policy self-tests |
| `audit-grok-ds-ompi-delta.md` | grok-build + DeepSeek-Reasonix + oh-my-pi | 131 deltas | encrypted prompts; PTY scenario DSL; session inbox/steer; projection debt; KDL compat cascade; local MLX; `/ratchet` |
| `audit-oh-swe-wsh-delta.md` | OpenHands + SWE-agent + wshobson-agents | 42 blocks (~150 findings) | in-band control tokens; best-of-N scoring; verify-openhands harness; ship-mate FSM; team protocol |

## How these reports are used

1. **`29-final-audit.md` §A.1** — delivery record and per-cluster results.
2. **`29-final-audit.md` §B.1** — the merged/appended/queued classification; the eight appended rows are `24-feature-catalog.md` NF-063…NF-070.
3. **`29-final-audit.md` §B.1(c)** — the queue of Section-A-level findings awaiting per-row disposition in the next catalog revision.

## Caveats

- Reports were written against the clones as of 2026-11-06; the clones are reference material and drift independently of this repo.
- Each report's NOT-READ list is part of its honesty record — notably horizoncode's `kernel/src/host_kernel.rs` (48,214 lines) was read at interface level (module and test names), not line-by-line, and the report says so.
- Upstream defects recorded in the reports (e.g. opencode-v2's skill-version refresh gap, claude-code's missing sandbox-runtime dependency) belong to the reference repos; they are observations, not claims about HorizonCode.

## Pass-2 reports (`pass2/`)

The fifteen reports from the earlier deep-dive passes, preserved 2026-11-06 for durability (they lived only in `/tmp`). They are the sources for docs 26/27 and for `29-final-audit.md` Part D.

| File | Repo | Note |
|---|---|---|
| `deep-codemode-report.md` | opencode + codex code-mode family | Source of CM-1…CM-14 (Part D §09) |
| `deep-sweagent-aci-report.md` | SWE-agent | Source of the ACI rules R-read-window-1…4 etc. (Part D §09) |
| `deep-wshobson-report.md` | wshobson-agents | 202-agent inventory + P1–P10 |
| `claude-code-report.md` | claude-code | 650 lines |
| `codex-report.md` | codex | 450 lines |
| `deep-opencode-v2-report.md` | opencode-v2 | 235 lines |
| `deep-openhands-report.md` | OpenHands | 173 lines |
| `DeepSeek-Reasonix-report.md` | DeepSeek-Reasonix | **truncated original** — ends mid-sentence; superseded by the delta report |
| `grok-build-report.md` | grok-build | 608 lines (the thorough one) |
| `grok-report.md` | grok-build | **truncated original** — ends mid-table; superseded |
| `oh-my-pi-report.md` | oh-my-pi | 413 lines |
| `opencode-report.part1.md` … `part3.md` | opencode | 556 lines combined |
| `opencode-report.part4.md` | opencode | **empty (2 bytes)** — the historical gap that triggered the opencode delta pass |

Truncations and the empty part are preserved exactly as found: they are the defects the final audit's delta passes exist to compensate for, and the honesty record is the point.
