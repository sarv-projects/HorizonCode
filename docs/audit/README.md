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
