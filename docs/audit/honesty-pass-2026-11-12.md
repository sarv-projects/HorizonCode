# Honesty pass + principal audit — 2026-11-12

> Snapshot: `main` at `6f321c3` (backlog wave) + follow-up doc/header edits in this pass.
> Scope: re-read live design docs vs code; do **not** rewrite frozen historical audit reports under `docs/audit/pass*`.

## Verdict

The vertical slice is real and gates-green. Several **live** design docs still claimed “no OS confinement” / “no trust gate” after those slices shipped. That is a documentation defect, not a missing feature. The **real** prototype trust spine remains: EffectHost, independent receipt postimage, session↔kernel reconciliation, MITM egress.

## Critical stale claims fixed this pass

| Location | Was | Now |
|---|---|---|
| `docs/11` Implementation reality + §10 + honesty statement | `kernel_applied_mechanisms` all false; no trust; OS confinement DESIGN ONLY | PARTIAL Linux `hz-sandbox-exec`; trust digests TESTED; EffectHost/MITM still open |
| `docs/15` Implementation reality + H1 + provenance table | no trust gate / H7 still open / H1 greenfield | digest trust PARTIAL/TESTED; Grok parity residual |
| `docs/33` kernel map + invariant 8 + priority overview + 5.7 | all false; 5.7 commit pending | helper path; snapshot committed in `6f321c3` |
| `README` quality + Partial/Not started | snapshot staged; FS “not applied” | committed; confinement via helper |
| `kernel/src/sandbox.rs` module header | “NO OS confinement backend” | points at `hz-sandbox-exec` + rulings 140–150 |

## Principal findings (code + docs) — ranked

### P0 — prototype lies if overclaimed

1. **No EffectHost.** Guard in Rust; effects in Bun (`app/src/tools/*`, `loop.ts`). Compromised/buggy TS can mutate after allow.
2. **Receipts ≠ observation.** Digests largely caller-supplied; no independent postimage (triage finding 3 still OPEN).
3. **Two durability domains.** SQLite session journal vs kernel JSONL; no `effectId` reconciliation protocol.
4. **JSONL without fsync.** Process-crash OK; power-loss not durable (docs/33 §6.5).
5. **Egress bypass.** `net.fetch` decider; shell `curl` unconstrained after `shell.exec` allow.
6. **Shell → kernel state.** Tool writes blocked; raw shell redirects into `.hz/state/kernel` remain a residual.

### P1 — partial on the live path

7. Linux confinement TESTED; macOS/Windows missing; SandboxMode→FS wiring must stay consistent.
8. Trust digests TESTED; Grok `trust.rs` parity open.
9. 20 shipped events vs 44 `hz.*` — needs owner RC.
10. `hzcode serve` single-attach; no durable replay cursor.
11. Evidence gate = cheap `unverified_completion` rail only.
12. NVIDIA live; Anthropic/OpenAI native not live-proven.
13. Hosted CI green on `main` not confirmed in this pass.
14. `setsid` descendant escape; credential scrub incomplete for arbitrary shell.

### P2/P3 — product depth (not thin-prototype blockers)

TaskRun ledger, worktree pool/merge, repo-fact CAS, pricing/tree cost, fullscreen alt-screen, ACP/MCP server, plugins, speculation wiring, model guardian, DAP live e2e, memory embeddings, OAuth IdP e2e, toolconv stream/history rewrite, head-to-head evals, 18 declared-gap gates, grow library consumption.

## Still correctly DESIGNED (do not “fix” by claiming shipped)

EffectHost five-phase settlement · independent postimage · MITM proxy · TaskRunV1 · ACP · plugins/marketplace · fullscreen alt-screen renderer · Starlark · secrets vault · Trusted Host State · full evidence gate.

## Historical docs left alone

`docs/audit/pass2|pass3|pass4|pass5/*`, dated triage/reaudit reports, and research steal notes remain **point-in-time**. Their “no Landlock” / “no trust” lines describe the past; live status is `docs/28`, `docs/33`, `CURRENT_RUN`, and the refreshed headers of `docs/11` / `docs/15`.

## Suggested next engineering slice

1. Keep docs honest (this pass + follow-up sweep).
2. EffectHost + receipt settlement + effectId bridge (P0).
3. MITM or explicit “shell net unconstrained” product warning in doctor.
4. Owner: LICENSE + alt-screen product decision.

## Follow-up from parallel audits (same day)

Agents: [Docs honesty audit](388ecfd9-7226-4996-9d51-5453c2da9c81), [Principal code audit](a3de8833-4bc3-4117-8e9c-458fb3605fa1).

Additional live-doc/header fixes applied after those reports: `docs/11` §7.12/§7.7/E1/trust provenance; README status; `docs/07`/`09`/`13`/`16` reality headers + I6/I9; `config.ts` / `mcp/index.ts` comments.

### Extra code findings (not doc-only) — track for prototype

| Sev | Finding | Status (reaudit) |
|---|---|---|
| P0 | Shell under workspace-write Landlock can still rewrite `.hz/state/kernel` (state dir inside workspace; `scopeFor` ignores `shell.exec`) | **Mitigated**: `protectedPathRefusal` + Rust guard deny `shell.exec` naming kernel state; wrapped spawns set `HZ_SANDBOX_FS_RO_PATHS` and Landlock carves RO under workspace-write. Residual: obfuscated shell (vars, multi-step `cd`) without marker strings; unwrapped local fallback. |
| P1 | Trust first-bind TOFU + `DIR_DIGEST_CAP=200` silent truncate | **Fixed**: first bind requires approval; empty home fail-closed; truncate → sentinel, never binds. |
| P1 | `AdmissionQueue` recover-only — `admit` not on `send` path | **Fixed**: `runSend` admits → begin → settle (`done`/`failed`/`unknown`). |
| P1 | Sandbox wrap conditional (`untrusted` / `HZ_SANDBOX_EXEC=0` → no wrap) | **Honest + optional fail-closed**: `HZ_SANDBOX_REQUIRE=1` / `sandboxWrap:true` / `HZ_SANDBOX_EXEC=1` refuse when wrap unavailable; auto remains best-effort. |
| P2 | `resultDigest` of non-string output collapses to `""` | **Fixed**: canonical JSON of `{ok,output,error}` when output is non-string. |

### Still open (larger than this slice)

EffectHost · independent receipt postimage · session↔kernel ledger reconciliation · MITM egress · LICENSE / §5.17 owner decisions.
