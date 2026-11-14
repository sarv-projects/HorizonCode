# Doc honesty register (line-by-line vs code) — started 2026-11-14

**Status: IN PROGRESS** — not a completion certificate. Use with `docs/28` rulings and [`p0-eight-requirements-2026-11-14.md`](p0-eight-requirements-2026-11-14.md).

## Method

For each doc or backlog row: state the claim, the code/test evidence, verdict (`MATCH` | `STALE` | `PARTIAL` | `OPEN` | `SKIP`).

## P0 / Wave 0 gates (audited)

| Claim | Evidence | Verdict |
|---|---|---|
| Eight P0 acceptance bars closed | `p0-eight-requirements-2026-11-14.md` | **OPEN** (all eight) |
| RC-18 = 23/44 shipped | `event-catalogue.ts::hzEventCoverageReport` | **STALE** → **4/44 literal emitted**, 23 unmapped |
| C-13 not wired into loop | `loop.ts` `admissionToolDispatchRefusal` + ruling **363** | **STALE** → wired at executeTool |
| C-8 tail re-exec not built | ruling **364**, `HZ_REEXECUTE_UNPAIRED_TOOL_TAIL=1` | **PARTIAL** (opt-in; default repair) |
| Bash split “parser does not exist” | `shell-split.ts` + ruling **365** per-segment Guard | **STALE** (reduced split exists; not full AST/saved grants) |

## Corpus sweep (not started)

| Doc range | Last spot-check | Verdict |
|---|---|---|
| `docs/01`–`16` design | — | **NOT AUDITED** |
| `docs/24`–`33` implementation | `28` rulings through **364** | **PARTIAL** |
| `docs/30` §7 OPEN rows | traceability script + manual | **PARTIAL** |

Next pass: automate stale §7 status strings against `28` ruling ids.