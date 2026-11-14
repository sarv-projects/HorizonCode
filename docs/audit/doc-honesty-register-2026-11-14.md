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
| Bash split “parser does not exist” | `shell-split.ts` + ruling **365** `guardActionsForShellCommand` | **MATCH** partial — reduced lexer split + per-segment Guard; **OPEN**: AST, saved grants, execpolicy |
| §8 #3 “no todos section” | `handoff.ts` todos column + `todos_snapshot`; tool still refuses `todos` args | **MATCH** partial (**366**); **OPEN**: auto-link, hook capture, live todo rehydrate |
| §8 #4 “no remember/forget tools” | `memory-write.ts` + `store.ts` | **MATCH** partial (**367**); **OPEN**: embeddings, MEMORY.md sync |
| §8 #10 filename-only topic rank | `manifest.ts` `scoreMemoryTopics` + excerpts | **MATCH** partial (**368**); **OPEN**: embeddings, memdir prefetch |
| §8 #8 interrupt on abort | `formatStrandedInterjections` + `Runtime` flush (**369**) | **PARTIAL** — interrupt envelope on stranded; **OPEN**: mid-stream provider cancel |
| Full backlog / goal complete | `FULL-BACKLOG-2026-11-13.md` §C (47 OPEN), `GOAL-PROGRESS.md` | **OPEN** — goal **NOT DONE** |

## Corpus sweep (started — not complete)

| Doc range | Last spot-check | Verdict |
|---|---|---|
| `docs/01`–`16` design | — | **NOT AUDITED** |
| `docs/24`–`33` implementation | `28` rulings through **368** (local) | **PARTIAL** |
| `docs/30` §7 OPEN rows | manual vs **366–368** | **PARTIAL** |
| `FULL-BACKLOG` §A P0 | `p0-eight-requirements` | **OPEN** (4/4 bars) |
| `docs/33` §5 deferrals | spot **5.4/5.17** only | **PARTIAL** |

Next pass: §7 row-by-row vs `test`/`28` ruling; fix stale RC-18 prose in older docs still saying “23 shipped”.