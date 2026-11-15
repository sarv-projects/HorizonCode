# Doc honesty register (line-by-line vs code) — started 2026-11-14

**Status: IN PROGRESS** — not a completion certificate. Use with `docs/28` rulings and [`p0-eight-requirements-2026-11-14.md`](p0-eight-requirements-2026-11-14.md).

## Method

For each doc or backlog row: state the claim, the code/test evidence, verdict (`MATCH` | `STALE` | `PARTIAL` | `OPEN` | `SKIP`).

## P0 / Wave 0 gates (audited)

| Claim | Evidence | Verdict |
|---|---|---|
| Eight P0 acceptance bars closed | `p0-eight-requirements-2026-11-14.md` | **OPEN** (all eight) |
| RC-18 counts | `event-catalogue.test.ts` (**34/34** shipped rows mapped, **16/44** literal; rulings **439**–**440**) | **MATCH** partial (**16** canonical without emitters; claim reduced) |
| C-13 not wired into loop | `loop.ts` `admissionToolDispatchRefusal` + ruling **363** | **STALE** → wired at executeTool |
| C-8 tail re-exec not built | ruling **364**, `HZ_REEXECUTE_UNPAIRED_TOOL_TAIL=1` | **PARTIAL** (opt-in; default repair) |
| Bash split “parser does not exist” | `shell-split.ts` + **365** Guard + **396** saved grants | **MATCH** partial — per-segment Guard + saved rows; **OPEN**: AST, execpolicy |
| §8 #3 handoffs + durable todos | **419**–**425** SQLite + MMR + merge + auto-merge | **MATCH** partial; **OPEN**: embeddings |
| §8 #3 `todo_write` alias | ruling **395** | **MATCH** partial (`merge` batch open) |
| §8 #4 “no remember/forget tools” | `memory-write.ts` + `store.ts` | **MATCH** partial (**367**, **375** opt-in MEMORY.md sync); **OPEN**: embeddings, graph/triples |
| §8 #10 filename-only topic rank | `manifest.ts` rank + prefetch (**368**, **381**) | **MATCH** partial; **OPEN**: embeddings |
| §8 #8 interrupt on abort | steer cut + wire JSON guard (**377**, **389**) | **PARTIAL** — omfp parity open |
| §8 #8 mid-stream provider steer | **373** + `interjection-stream.test.ts` + **426** backlog | **MATCH** partial — stream cut + tool-call drop; **OPEN**: omp `response.steer` |
| §8 #8 serve interject | **415** `server.test.ts` f1/f2 | **MATCH** partial |
| §8 #6 “durable saved rows still open” | `saved-allows.ts` + `hydrateSavedGrants` + ruling **370** | **MATCH** partial — file persist + hydrate + unattended copy; **OPEN**: grant-expiry UX |
| folder-trust “full UX still open” | startup notice + `/trust` + doctor **438** `workspace.trust` | **MATCH** partial — bind cards + diagnose gate; **OPEN**: Grok source-identity |
| §8 #7 “true-noop template still open” | `ActionStationarityTracker` + **372**, **408**, **417** max_tokens partial dispatch | **MATCH** partial — partial batches reset stationarity; borderline repaired args still open |
| RC-18 / subagent message.sent | **413** digest-only parent stream | **PARTIAL** (`bodyRef` open) |
| `session.interject` serve | **415** `SERVER_METHODS` + non-blocking transport | **PARTIAL** (omp parity open) |
| session↔kernel doctor | **416** `session.kernel` line | **MATCH** partial (R170 settle open) |
| Full backlog / goal complete | `FULL-BACKLOG-2026-11-13.md` §C (47 OPEN), `GOAL-PROGRESS.md` | **OPEN** — goal **NOT DONE** |

## Corpus sweep (started — not complete)

| Doc range | Last spot-check | Verdict |
|---|---|---|
| `docs/01`–`16` design | — | **NOT AUDITED** |
| Wave 0 subagent wording | `sections.ts` + **400** (`hz.agent.*` on parent stream) | **MATCH** partial |
| Wave 0 F10 JSONL | fsync default + **432** probe script | **PARTIAL** (no power-loss measure) |
| Wave 0 RC-18 hooks | `hook.*` + `run.unverified_completion` subset map (**432**–**434**) | **MATCH** partial (**30/30** shipped rows mapped; no literal hook hz yet) |
| RC-18 literal emitters | `event-catalogue.test.ts` 7 literal (**385** agent, **386** todo) | **PARTIAL** (21/44 unmapped) |
| §8 #3 todo_write batch | `todo` `merge` action (**387**), not separate tool name | **PARTIAL** |
| §8 #6 grant expiry | TTL + stale footnote (**388**, **390**) | **PARTIAL** (no live countdown) |
| §8 #4 memory banks | doctor `memory.banks` (**391**) | **PARTIAL** |
| §8 #6 saved allows | per-segment shell rows (**396**) + doctor (**392**) | **PARTIAL** |
| RC-18 skill invoke | literal `hz.skill.invoked` (**399**) | **MATCH** partial |
| RC-18 permission | literal `hz.permission.*` (**393**) | **MATCH** partial |
| Handoff todo kernel | non-todo bump → `hz.todo.updated` (**394**) | **MATCH** partial |
| RC-18 doctor | `events.rc18` line (**397**) | **MATCH** partial |
| §8 #6 grant TTL UI | SQL store (**437**) + tick + `guard.grant.query` (**436**) + `{action,resource}` (**428**) | **PARTIAL** (multi-resource projector) |
| §8 #10 memory topics | doctor topic summary (**402**) + prefetch (**381**) | **PARTIAL** |
| §8 #12 failure codes | doctor **403** + classify/retry | **PARTIAL** |
| §8 #7 max_tokens batch | fail-all notice **404** | **PARTIAL** |
| Catalog poll + precedence | **420**–**421** | **MATCH** partial |
| `docs/24`–`33` implementation | `28` rulings through **426** (local) | **PARTIAL** |
| `33-handoff` RC-18 counts | **418** vs `event-catalogue.test.ts` | **MATCH** (was STALE at 23/7) |
| `07-apis` serve method count | **418** 8 methods | **MATCH** |
| `docs/30` §7 OPEN rows | manual vs **366–368** | **PARTIAL** |
| `FULL-BACKLOG` §A P0 | `p0-eight-requirements` | **OPEN** (4/4 bars) |
| `docs/33` §5 deferrals | spot **5.4/5.17** only | **PARTIAL** |

Next pass: §7 row-by-row vs `test`/`28` ruling; fix stale RC-18 prose in older docs still saying “23 shipped”.