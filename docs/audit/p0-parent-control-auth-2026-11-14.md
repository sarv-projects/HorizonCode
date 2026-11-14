# HorizonCode ruling 352 — private parent-control authorization channel

**Date:** 2026-11-14. **Base:** ruling 351, pushed commit `5c08df4696e34a1257f592a51228a9cacd3618f8`.
**Scope:** P0-1 / R170 narrower authorization provenance for direct kernel approval-mint operations. **Not P0 completion.**

## Defect closed for the product-launched Rust kernel

Ruling 351 made direct Rust `effect.execute` check Guard under the OwnerLog lock, but raw
`guard.lease`, `guard.grant`, and `guard.allowlist.amend` were still callable through the
same unprotected NDJSON request interface. A caller could therefore mint a lease and make
a previously `ask`-gated command run without supplying evidence from the trusted parent
process. The Guard decision was real, but the permission **origin** was unauthenticated.

Ruling 352 adds a launch-scoped, 32-byte random credential between the Bun parent and its
Rust child, delivered as 64 lowercase hex characters through a private fourth child stdio
endpoint (fd 3). The credential is generated using Node `randomBytes`, is **not** placed
in environment variables, process arguments, state files, receipts or log events, and is
held in an ECMAScript hard-private `#controlSecret` field (not an enumerable property).
The child bootstrap reads exactly this inherited descriptor via Rust's `FromRawFd`
(on Unix, Bun uses a Unix socket; reopening `/proc/self/fd/3` would fail). Malformed, missing, or unsupported pipe credentials are refused **before** serving NDJSON.
Rust checks that inherited fd 3 is open with `fcntl(F_GETFD)` before
adopting it as an owned file descriptor: otherwise a deliberately missing
fd triggers a Rust IO-safety abort instead of the required clean exit 2.
Both invalid-content and absent-descriptor boot cases are tested.

On `guard.lease`, `guard.grant`, `guard.allowlist.amend`, and direct
`receipt.issue`, the Rust `Kernel` checks the supplied additive `approvalProof` against the launch credential using a
fixed-length byte comparison. Missing/forged proofs are denied before minting a lease,
persistent grant, client-claimed chained receipt, or modifying the allowlist.
The internal Rust OwnerLog issues its independently observed receipts without
this external RPC, so the new restriction does not make caller data into
independent postimage proof. The parent `KernelClient.rpc` supplies
the proof only when invoking these three privileged methods on a trusted kernel.
`KernelClient.makeLease`/`makeGrant` and existing user-approved shell routing
remain compatible and use the same control channel. A workspace-bound Rust kernel
without an activated private control channel **refuses permission minting**, rather
than interpreting an absent secret as a globally open grant. Legacy unbound standalone
kernels intentionally retain backwards-compatible behavior; this mode is **NOT an
authenticated parent authorization boundary**.

If a previously trusted Rust child exits or transport fails, the same `KernelClient`
refuses local `guard.lease`/`guard.grant`/`guard.allowlist.amend`/
`receipt.issue` fallback. A never-trusted client also refuses local
permission/receipt minting when `HZ_EFFECT_HOST_KERNEL=require`. The
earlier `effect.execute` UNKNOWN/no-replay refusal remains. A non-executable or
incompatible child is handled without an unhandled `EACCES`/fd3 `EPIPE` event;
the fallback transport no longer crashes just because the child stdio endpoints
are null. This preserves old fallback-mode behavior in explicitly non-strict mode,
rather than silently granting new permission after a trusted child was lost.

## Independent behavior tests

- `kernel/src/control_auth.rs` unit tests validate exact 64-character lowercase
  credentials, incorrect/missing proof refusal and explicitly unbound standalone mode.
- Rust integration `bound_kernel_workspace_cannot_be_widened_by_raw_sandbox_root_argument`
  now also refuses a `guard.lease` on a workspace-bound kernel with no parent control
  pipe, while still proving raw `sandboxRoot` widening is denied before OwnerLog prepare.
- `app/tests/core/effect-owner-kernel.test.ts`: raw request injection through
  `callRemote` must fail for no/forged proof on `guard.lease` and `guard.grant`,
  must fail for unauthenticated `guard.allowlist.amend` and `receipt.issue`;
  a legitimate parent `makeLease` must yield a session-owned one-use lease usable
  by Rust `effect.execute`, and authenticated `issueReceipt` remains available.
  The secret is not enumerable nor exported via an environment variable.
- Same file: an actual malformed inherited fd3 boot fails with process exit 2 and
  the expected precondition error, rather than serving an open authorization channel.
  Separate real kernel fault-after-executing test asserts the formerly trusted client
  cannot locally mint a lease or grant after the Rust transport died.
- `app/tests/core/fallback.test.ts`: invalid/non-executable kernel binary still
  falls back in the non-strict compatibility path, with no unhandled child error.
  Existing event/receipt chain and policy tests still pass in isolation.

## Security limitations — DO NOT mark P0 done

1. **Parent authentication is not human approval attestation.** The Bun runtime
   controls the private pipe and can call its public `makeLease`/`makeGrant` APIs.
   Compromised TS runtime, code mode, extension or MCP paths *inside the same
   process* are not separately authenticated as a consent actor. In particular,
   `sessionId` is caller-supplied and a loop boolean is not an independent
   user-presence signal. A separate, trusted approval broker/challenge, canonical
   intent binding, principal identity and one-time permit transfer are still needed.
2. **Standalone compatibility mode:** an unbound Rust process without `--control-fd`
   remains a legacy unauthenticated minting surface. A workspace-bound process
   without the private pipe now refuses mint RPCs; it is **not** claimed to have
   a complete product trust posture unless the parent binding is in place.
3. **Portability:** the private descriptor reader is Unix-specific. On unsupported
   native platforms it refuses rather than pretending to authenticate; cross-platform
   product startup and secure transfer still require implementation and tests.
4. **Transport/replay:** `approvalProof` is passed in the privileged RPC request
   on the same parent-controlled NDJSON channel. This is *not* a replay-proof,
   per-intent HMAC protocol with a nonce and a policy revision; it relies on the
   kernel subprocess/pipe boundary and is not a defense against code running with
   the Bun parent's full permissions.
5. **Universal ownership:** Bun ambient effects, hooks, MCP, subagents, code mode,
   rewind, staging, shell-created outbound networking and SQLite↔OwnerLog
   coordinated admission remain outside the direct kernel fence.
6. **P0-2/3/4:** historical postimage snapshots, every effect's independent
   observation, executed-UNKNOWN resolution, production netns routing,
   proxy/TLS enforcement and real product egress bypass denial are still OPEN.
7. **R172/RC-18/patch parity:** full receipt ABI, nested verified events,
   all 44 `hz.*` canonical kinds (recorded 23/44), atomic multi-file/multi-hunk
   and fuzzy/AST kernel patch parity remain OPEN.

## Verification commands

```bash
cd app
bun run typecheck
bun test tests/core/effect-owner-kernel.test.ts tests/core/effect-execute-kernel.test.ts tests/core/effect-kernel-mutation-route.test.ts tests/core/fallback.test.ts
cd ../kernel
cargo test --offline --test integration
cargo test --offline --bin hz-kernel -- --skip eventlog::tests::tail_cache_keeps_a_20k_chain_verifiable
cd ..
python3 ops/generate-backlog-traceability.py
git -c core.whitespace=cr-at-eol diff --check
```

**Verified in this iteration:** TypeScript `bun run typecheck` PASS;
Rust integration **78 PASS / 0 FAIL**; Rust kernel unit **117 PASS /
0 FAIL** with the existing 20,000-chain stress case filtered; final
wider focused Bun regression **315 PASS / 0 FAIL** across 39 files,
including the `fallback.test.ts` **17 PASS / 0 FAIL** suite and
the Rust-backed parent-control cases. An additional isolated
`effect-owner-kernel.test.ts` run after the full suite was also green.
Reproducible backlog mapping: 47 primary, 16 RT, 44 upstream-specific,
15 unchecked checklists, with overlapping groups. Scoped Rust format
and `git -c core.whitespace=cr-at-eol diff --check` passed.

**Full Bun run history (not green):** ruling 351 baseline **2,746 pass /
43 fail / 3 skip**. First ruling 352 run, with a real unhandled
non-executable-spawn regression: **2,733 pass / 57 fail / 3 skip /
6 runner errors**. Fixed the EACCES/fd3 error-listener ordering and
verified every fallback test. The rerun completed **2,747 pass /
46 fail / 3 skip / 0 runner errors** (2,796 tests across 391 files).
Exact failure-name comparison versus ruling 351: 43 earlier failures
persist; the three additional ones were two code-mode abort/output
cases and one missing-fd boot test. The missing-fd boot test passed
when rerun in isolation, so the full-suite failure may be concurrency/
process instability rather than deterministic breakage. The other
two were not independently proven environmental. The project-wide
`cargo fmt --check` still has older unrelated formatting drift; no
blanket format or green release claim.

**Final gate:** not merged, not production-approved, no shell network claim,
no full P0-1/2/3/4, R170, R172, RC-18, patch parity or session/kernel completion.
