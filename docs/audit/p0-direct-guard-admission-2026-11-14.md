# HorizonCode ruling 351 — Guard-bound direct Rust admission and launch-time workspace binding

**Date:** 2026-11-14. **Base:** ruling 350, pushed commit `86300dcd409012f1ffef08f89288e1abed22d4a1`.
**Verdict:** P0-1 direct-kernel authorization gap reduced. **P0-1, P0-2, P0-3, P0-4, full R170, R172, RC-18, patch parity and session/kernel consistency remain OPEN. Not release-ready.**

## Concrete boundary implemented

The direct `effect.execute` mutation path in `kernel/src/protocol.rs` now passes the actual `Guard` instance to `kernel/src/effect_owner.rs`. After acquiring the cross-process OwnerLog lock and checking for unpaired/UNKNOWN effects, duplicate IDs, receipt-chain integrity and the caller's file preimage pin, Rust calls `authorize_direct_effect`. A Guard refusal returns an error **before** `owner.prepare` is appended or any mutating primitive executes.

- `fs.write`, `fs.edit`, and `fs.delete` authorize the symlink-resolved target as `fs.write`, using the existing Guard policy class. The kernel does NOT invent unrecognized `fs.edit` or `fs.rename` rules.
- `fs.rename` independently authorizes both source and destination as `fs.write`. All effect targets must resolve within sandboxRoot; kernel state remains structurally protected. For an `ask` or `deny`, the old file remains intact, the destination is not written, and OwnerLog has no prepare row.
- `shell.exec` authorizes the argv-derived command string as `shell.exec`. Default policy `ask` now refuses even the existing safe output-only executable allowlist without a kernel Guard lease. **This is stricter than ruling 350.** Shell still rejects arbitrary unconfined interpreters/binaries; this is NOT network/FS sandbox enforcement.
- Guard decisions are made within the **same kernel process and OS OwnerLog lock** as execute→observe→receipt→settle. Rust records `guardDecision=allow`, optional consumed `guardLeaseId`, and a full `guardLeaseIds` array in the hashed `owner.prepare` and `owner.settled`. The receipt keeps its frozen one-lease `leaseId` field (last consumed lease for compatibility). `verify_settlement_receipt_links` cross-checks the same lease against prepare and settlement, and the complete lease list across OwnerLog rows. `effect.execute` output may include `ownerGuardLeaseId` and `ownerGuardLeaseIds`.
- Raw callers' supplied `leaseId` is **not authorization**: Rust takes the lease identifier only from a Guard decision, never from RPC payload claims. The existing per-process `guard.lease` and `guard.grant` interfaces are still callable without a separately authenticated human principal; see open gaps below.

### Workspace-root binding

The production `KernelClient.startBinary` now overrides inherited `HZ_KERNEL_WORKSPACE_ROOT` to the client's chosen workspace when launching the Rust child. The Rust process captures the binding once, at construction; for **mutating** `effect.execute` it independently resolves both the launch-time workspace and RPC `sandboxRoot`, refusing any mismatch **before OwnerLog admission**, including a raw RPC that claims another workspace. A denied effectId leaves no prepare row and can be reused for a later eligible request.

Standalone kernels without `HZ_KERNEL_WORKSPACE_ROOT` remain unbound for backwards compatibility with raw integration fixtures. The environment binding is protection **within the trusted parent/child runtime topology**, not protection from a malicious local process that controls its own kernel startup or from external symlink/TOCTOU races. Nonmutating `fs.read` keeps its previous sandboxRoot behavior.

### User-approved shell tool route compatibility

The ordinary loop completes its Guard check, user approval (if required), and pre-hook decision before attempting kernel routing. The `tryKernelShellRoute` helper accepts the private loop-admitted session context and, only for a trusted Rust client, mints a fresh exact-argv, session-owned, one-use kernel lease immediately before `effect.execute`; Rust consumes it under OwnerLog. Direct helper calls without that context do not mint leases and are independently denied by default Rust shell policy. This is a compatibility bridge, **not a cryptographic approval attestation**: the loop and existing `guard.lease` minting API remain outside a separately authenticated kernel human-approval channel.

## Evidence: real kernel subprocesses and TypeScript clients

**New/extended cases in `kernel/tests/integration.rs`:**

1. `owner_direct_file_effect_respects_guard_deny_and_ask_before_prepare`: both explicit deny and ask refuse without a mutation or durable prepare; policy allow can then execute using the same previously refused ID.
2. `owner_rename_checks_both_endpoints_against_guard_under_same_fence`: ask refuses before effect; two exact one-use leases allow rename and both IDs appear in the hashed OwnerLog; receipt's one leaseId remains tied to the last lease.
3. `owner_shell_guard_requires_authorization_even_for_output_only_argv`: raw echo refused under ask, then allowed after a kernel-minted lease; kernel-issued receipt and OwnerLog independently cross-verify that exact lease ID.
4. `bound_kernel_workspace_cannot_be_widened_by_raw_sandbox_root_argument`: a kernel launched with a workspace binding refuses a different root with no prepare, and admits the same effectId with the correct root.
5. The existing `owner_shell_receipt_binds_observed_streams_and_does_not_poison_next_effect`, `owner_terminal_rc7_distinguishes_settled_failure_from_unknown`, `effect_execute_shell_exec_under_sandbox_root`, and `cli_selftest_and_version` cases now explicitly mint an exact single-use authorization before expecting an output-only shell to run.

**TypeScript tests:** `app/tests/core/effect-owner-kernel.test.ts` tests raw root-widen denial, default ASK refusal without a loop approval ticket, and a valid session-scoped shell route. `app/tests/core/effect-execute-kernel.test.ts` ensures trusted file mutations address a subpath under their **kernel-bound workspace** and direct trusted shell requires an issued lease.

This tests the directly participating Rust EffectHost only. It is **not** a proof that all Bun/SQLite/MCP/hooks and tools execute under the same admission transaction.

## Exit-criteria assessment — remain OPEN

| Gate | New evidence | What prevents closure |
|---|---|---|
| P0-1 | Direct kernel fs write/edit/delete/rename and output-only shell now have Guard allow checks under OwnerLog; product child bound to workspace; no authorize/prepare on deny or ask | Any Bun-owned mutating entrypoint, hooks, MCP, code mode, child processes, shell network, directory operations, atomic fs.batch and unsupported edit/patch/AST parity; standalone unbound kernel and unauthenticated lease-mint RPC remain |
| P0-2 | 350's latest-file replay still available; direct receipt now cross-checks kernel-selected consumed lease IDs | Historical snapshots; every effect class, shell/net effects, external filesystem races and independent non-file execution postimages |
| P0-3 / R170 | Direct Rust authorization participates in the existing process flock; cross-ledger checks bind the selected authorization | Bun/SQLite cross-process admission/recovery, global principal identity, per-resource alias/collision, executed UNKNOWN resolution, multi-process grant/lease ownership |
| P0-4 | Output-only shell still explicitly refuses unsafe binaries | Product netns parent/child, proxy/CONNECT/TLS enforcement and actual in-product shell-created outbound TCP escape tests |
| R172 | Kernel-issued direct effect receipt gets a hashed Guard lease; partial 350 RC-7 terminal facts remain | Full `EffectReceiptV1` (origin/capability/policy revision/observation), nested event streaming, all entrypoint terminal outcomes |
| RC-18 | No new canonical event kind | Recorded 23/44; 21 unimplemented canonical event emitters |
| Patch parity | Strict multi-operation patch still refuses before mutation | Atomic kernel multi-file/multi-hunk transaction, first-hit fuzzy/ambiguity/AST parity |
| Session/kernel consistency | Direct kernel effect admission remains atomic under OwnerLog | SQLite↔kernel OwnerLog coordinated atomic commit, independent app crash reconciliation, background/worker ownership fencing |

## Exact residual authorization limitations

- `guard.lease` and `guard.grant` are currently raw RPCs capable of minting authorizations. Their caller is **not independently authenticated to a human approval principal**. Do not represent minted leases alone as proof that a human approved the effect. That requires a separately attested approval source and capability/intent binding.
- `sessionId` is optional and caller-supplied on `effect.execute`; session ownership is **not cryptographically tied** to an OS process or session claim. The user-level approval bridge is a compatibility measure, not the final authority boundary.
- Shell argv target construction uses a whitespace-joined representation, not a canonical lossless argv digest bound to the lease. Output-only command allowlist reduces but does not eliminate the design limitation.
- A rename can consume one source lease then be denied at destination without mutating files; the consumed lease is not rolled back. Both endpoint IDs are durably recorded **only when the whole effect is admitted**. Atomic multi-resource permit reservation is unfinished.
- Policy files, workspace symlink layouts and the Bun ambient mutators can change independently of the OwnerLog OS lock. A same-lock Guard check reduces a kernel internal race but is not a global transactional isolation mechanism.
- A caller with full local file/kernel-launch control can still operate outside the bound product process; this is not an OS security boundary against the machine owner.

## Commands and verification

```bash
cd kernel && cargo test --offline --test integration
cargo test --offline --bin hz-kernel -- --skip eventlog::tests::tail_cache_keeps_a_20k_chain_verifiable
cd ../app && bun run typecheck
bun test tests/core/effect-owner-kernel.test.ts tests/core/effect-execute-kernel.test.ts
cd .. && python3 ops/generate-backlog-traceability.py
git -c core.whitespace=cr-at-eol diff --check
```

**Verified final-tree evidence:** Rust integration **78 PASS / 0 FAIL**, including policy denial/no-prepare, dual-lease rename, source/destination checks and kernel-bound root refusal; Rust unit **115 PASS / 0 FAIL** with one existing 20k-chain stress case filtered; TypeScript `bun run typecheck` PASS; targeted Bun **296 PASS / 0 FAIL** across 38 files; full Bun suite **2,746 PASS / 43 FAIL / 3 SKIP** across 391 files (2,792 tests). This is **NOT a green suite**. Previous ruling 350 full Bun: **2,743 PASS / 43 FAIL / 3 SKIP**, so **all 43 failures remain** (parallel batch, code mode/approvals, skills/config, TUI/PTY/style, netns host fixtures, multi-file apply_patch eval and other cases). No failure is automatically presumed pre-existing without specific evidence. `git -c core.whitespace=cr-at-eol diff --check` PASS, scoped `rustfmt --check --edition 2021 kernel/src/effect_owner.rs` PASS, and generated traceability is reproducible (47 primary, 16 RT, 44 source-specific and 15 checklist). Project-wide `cargo fmt --check` **FAIL** from known unchanged formatting drift beginning in `kernel/src/bin/../sandbox_veth_netlink.rs`. Disposable netns TCP-denial evidence from ruling 350 still does **NOT** prove HorizonCode product shell egress enforcement.

**Release gate:** no merge/release, no P0 item closed from this slice. Implement a true kernel approval principal, resource-bound atomic admission across Bun/SQLite and all effect-producing entrypoints, atomic file batches and default-deny product shell networking before any P0 closure claim.
