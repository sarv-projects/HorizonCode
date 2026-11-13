# P0 owner / recovery security audit — ruling 348

**Source of truth:** `kernel/src/effect_owner.rs`, `kernel/src/protocol.rs`,
`kernel/src/effect_host.rs`, `app/src/core/kernel.ts`, `app/src/contracts.ts`.
**Previous baseline:** [P0 matrix and full test log](p0-effecthost-baseline-2026-11-13.md).
**State:** **PARTIAL; NOT RELEASE-READY**. P0-1, P0-2, P0-3, P0-4, R172 and RC-18 remain open.

## Implemented security slice (real code, not design)

The Rust process now holds a persistent OS POSIX `flock` on `owner-admission.lock` for a participating
`effect.execute` mutation from admission through the independently observed result and issuance of a
kernel receipt. The lock is never unlinked by normal kernel operation; it has a bounded wait, fails
closed if the file is a symlink/hardlink or changed during acquisition, and **does not** use a
time-based stale-lock takeover. Two different kernel processes use the same file inode.

A kernel-only, hash-chained, fsynced `events/owner__effects.jsonl` plus `.head` record the
`owner.prepare` → `owner.settled` or `owner.unknown` transitions. Caller `log.append` to any
`owner:` stream is refused. Every participating kernel mutation rebuilds and verifies the owner
chain under the lock, refuses duplicate `effectId` replay, refuses if a prepared or UNKNOWN row
is unresolved, verifies the receipt chain, executes inside the lock, independently observes
the direct result and issues its OWN receipt before settling. A crash after durable prepare
cannot be silently treated as a settled effect at next admission. A failed direct kernel edit
is conservatively UNKNOWN even if the tool claims it did nothing.

Read-only `effect.owner.status` exposes blocked/unresolved counts; `effect.owner.verify`
verifies both owner and receipt chains. The TS `KernelClient` has additive typed methods;
when the trusted kernel is unavailable the LocalKernel refuses owner-status claims rather than
fabricating an empty clean OwnerLog.

The raw Rust `effect.execute` path also refuses file effects that overlap its own kernel state
directory, including existing/dangling symlink aliases and **both** rename endpoints; it refuses
if a target cannot be resolved. Until actual routed network + filesystem sandbox denial proofs
exist, raw `shell.exec` only admits `echo`, `true`, `false`, `pwd` and fixed system paths,
never interpreters, arbitrary binaries or network clients. These are *explicit refusals*,
NOT demonstrated netns confinement.

## Proof and injection coverage

| Scenario | Named test / proof | Expected security behavior |
|---|---|---|
| Two separate Rust processes on same stateDir | `kernel/tests/integration.rs::owner_effects_serialise_and_block_unknown_across_processes` | failed edit is durable UNKNOWN; second process cannot write |
| Distinct concurrent kernel clients | `app/tests/core/effect-owner-kernel.test.ts` | serialized two owner receipts and four owner events |
| Replayed effectId | `owner_effect_id_replay_cannot_write_twice` | second invocation denied; disk unchanged |
| Case-variant bypass | `mixed_case_dispatch_cannot_evade_kernel_owner_fence` | `FS.WRITE` and `Fs.WrItE` use same owner lock and replay refusal; observed RED before fix |
| Crash after durable prepare | `owner_crash_after_durable_prepare_blocks_replay_in_new_kernel_process` | debug-only fault injection exits 86 after fsync; new Rust process observes unpaired prepare and blocks replay; observed RED then GREEN |
| Receipt-sidecar tamper with valid receipt chain | `owner_verification_cross_checks_receipt_identity_sidecar_even_when_receipt_chain_is_valid` | owner verifies matching prepare argsDigest/dispatch kind, settlement receipt id/seq/hash, result digest and effectId sidecar; observed RED then GREEN |
| Caller-forged settlement | `owner_event_stream_is_not_caller_appendable` | owner stream rejects public log.append |
| Owner chain one-byte tamper | `tampered_owner_chain_refuses_inspection_and_mutation` | status and future effects both refuse |
| Stale/unpaired/duplicate transitions | `kernel/src/effect_owner.rs` unit | unresolved blocks; malformed transition fails close |
| Kernel state alias and rename destination | `raw_effect_execute_never_mutates_its_own_kernel_state_through_alias_or_rename` | fs.write / alias / rename refused pre-execution |
| Raw interpreter with redirection | `unconfined_shell_interpreter_is_explicitly_refused_before_spawn` | no shell child and no output file |
| Kernel-issued receipt after successful shell | `owner_shell_receipt_binds_observed_streams_and_does_not_poison_next_effect` | accepted safe echo, verifiable receipt, next file write proceeds |
| No trusted Rust kernel | TS owner suite | refusal, not optimistic local verification |

## Fresh verification, limitations and reproducibility

- Rust integration, after owner/crash/receipt cases: **68 passed, 0 failed** (`cargo test --offline --test integration`).
- Rust kernel unit: **115 passed, 0 failed; one pre-existing slow 20k-chain test filtered** (`cargo test --offline --bin hz-kernel -- --skip eventlog::tests::tail_cache_keeps_a_20k_chain_verifiable`).
- TypeScript `bun run typecheck`: **PASS**. Final broader targeted Bun suite: **290 passed, 0 failed** across 38 files (includes Rust-backed OwnerLog, EffectHost, R170, batch selection, doctor, rewind, admission, config/schemas and TUI status); local `.scratch/p0-owner-final-targeted.log`.
- **Full Bun** `bun test`, run this iteration before the final receipt-sidecar verification code: **2,739 pass, 44 fail, 3 skip, 2 errors** across 391 files. Prior baseline was 2,723 pass/49 fail; these 44 failures include real test failures and environment/TTY/skills/netns failures and are **NOT** dismissed as pre-existing without isolation. The full suite was not rerun after the final Rust-only receipt-link change.
- Standalone disposable user+network namespace TCP-denial smoke: **PASS**, direct TCP to 1.1.1.1:443 failed with `ENETUNREACH` (errno 101). Product-level routable network isolation **NOT tested**.
- Whole-project `cargo fmt --check` **FAIL** because of existing formatting drift (starts with unchanged `kernel/src/sandbox_veth_netlink.rs`); scoped `rustfmt --check --edition 2021 kernel/src/effect_owner.rs kernel/src/receipts.rs` **PASS**. Local `.scratch/p0-owner-format-overall.log` contains the exact diff.
- `git -c core.whitespace=cr-at-eol diff --check` **PASS**; final staged diff and remote SHA must also be checked before claiming a clean push. The ignored `.scratch/` logs are local evidence, not artifacts published in the repository.

## What is NOT established (blocks P0 exit)

1. **P0-1:** No universal kernel execution provider owns every mutation. Legacy Bun write/edit/shell,
   process/hook/MCP/code mode/subagent/rewind and direct facades do not enter this lock by default.
   Kernel `sandboxRoot` remains caller-supplied: path containment and OwnerLog are not the same as a
   complete kernel-side authority/approval proof. Patch fuzz and full AST/dir effects remain partial.
2. **P0-2:** Owner-issued receipts bind Rust-observed result digests on supported effects; there is
   no default independent replay of each historic file postimage, no full RC-7 terminal proof for
   nested runs, and no independent observation of ambient Bun effect classes. Shell output digests
   are **not** proof that all its effects or network actions were confined.
3. **P0-3:** The OwnerLog is default-on for the *direct Rust* mutation classes, not universal.
   The TypeScript R170 latch remains opt-in, unpaired SQLite ↔ kernel ledger and unknown
   commands are not part of the same transaction, and **clean release/recovery of UNKNOWN is
   not implemented**. A local actor able to rewrite state-dir files or replace the lock inode
   is outside the present proof; secure file descriptors and full resource alias/race coverage OPEN.
4. **P0-4:** This WSL host can run `ops/usernetns-direct-tcp-denial-smoke.sh`:
   a disposable `unshare -Urn` child has no default route and its real TCP connect
   to `1.1.1.1:443` failed with `ENETUNREACH` (errno 101, probe exit 0).
   This tests **only an isolated test process**, not HorizonCode's product child
   spawn, proxy CONNECT, TLS MITM or production default. Direct `unshare -n`
   fails EPERM and Docker daemon is unavailable. No product-routed netns/proxy/TLS
   E2E proof; absolutely no shell-network `enforced` claim.
5. **R172/RC-18:** `owner.*` events are kernel INTERNAL, not a counterfeit increase to the
   44 canonical `hz.*` event types (recorded 23/44). Receipt verification chain, nested event
   stream and RC-7 terminal lifecycle remain incomplete.
6. **Tests/format:** Existing full Bun-suite failures and project-wide `cargo fmt --check`
   formatting drift must stay visible; passing targeted Rust/TS suites is insufficient to close
   full gates.

## Requirements index for the next implementation slice

The active source TAKE/index is generated by
`ops/generate-backlog-traceability.py` into
`docs/BACKLOG-TRACEABILITY-2026-11-13.md`: 47 primary OPEN, 16 repo-take
partial, 44 upstream-specific partial, 15 unchecked pack entries, with overlap.
This ruling advances **006** (owned five-phase seam), **008** (existing kernel fs operations),
**013** (raw RPC kernel-state and shell bypass), **014** (owner receipt linkage) and
**015** (explicit refusals) but closes **none** of the universal exit bars.
Next must couple kernel guard authorization/intent to the admission lock, bring the
remaining effect-producing entrypoints into that transaction, implement safe
independent UNKNOWN replay/release, and test production network namespace
confinement on a capable Linux host.
