# License status (owner decision OPEN)

HorizonCode does **not** ship a root `LICENSE` file. No license is granted for
the project source until the owner adds one. This is intentional hygiene — we do
not invent Apache-2.0, MIT, or other SPDX ids on behalf of the owner.

## What exists today

| Artifact | Role |
|---|---|
| Root `NOTICE` | Third-party attribution hygiene only (models.dev snapshot, upstream refs). **Not a license grant.** Refresh when Provenance tables change — doctor `repo.license` mentions NOTICE presence only. |
| `README.md` | Points here and at `NOTICE`; states that distribution terms are unset. |
| `hzcode doctor` → `repo.license` | Reports whether a root `LICENSE` is present; **WARN** when absent. |

## Still open

- Owner-chosen project `LICENSE` (tracked in `docs/MASTER-BACKLOG-ALL.md` P0).
- Release-grade `NOTICE` rows keyed to full Provenance tables (`docs/33` §5.11).

Third-party code we adapt remains subject to **its** upstream licenses; see Provenance
tables in design docs and the summary in `NOTICE`.

## Provenance pointer table (upstream license rows — not a project grant)

| Doc | Section | What it lists |
|---|---|---|
| [`08-runtime.md`](08-runtime.md) | Provenance | Runtime loop, subagents, spawn patterns |
| [`09-tools.md`](09-tools.md) | Provenance | Per-tool upstream paths and relations |
| [`16-operations.md`](16-operations.md) | Provenance | ops/doctor/gates upstream refs |
| [`24-feature-catalog.md`](24-feature-catalog.md) | §A clusters | Reference-repo capability sources |
| [`30-steal-list.md`](30-steal-list.md) | §5–§7 | Ranked take list with upstream URLs |
| [`33-handoff.md`](33-handoff.md) | §6 hygiene | Owner LICENSE / NOTICE expectations |

Full release-grade rows keyed to those tables remain **open** (`33-handoff.md` §6).
