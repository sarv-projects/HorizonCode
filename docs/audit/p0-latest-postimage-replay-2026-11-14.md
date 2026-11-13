# HorizonCode Ruling 350 — independent latest-postimage verification

**Date:** 2026-11-14. **Baseline:** ruling 349, commit `6221c4e666cb6aee3474589683afc5020401f2e1`.
**Scope:** P0-2 postimage verification reduction and partial R172 RC-7 terminal contract.
**Overall result:** P0-1–P0-4, R170, R172, RC-18, full patch parity and the product egress proof are **OPEN**. The project is **NOT RELEASE-READY**.

## Exact new contract

`effect.owner.postimage.verify` is a new read-only Rust NDJSON RPC exposed through
`KernelClient.ownerPostimageVerify()`. The LocalKernel fallback refuses it rather
than manufacturing verified status. All four OwnerLog RPCs (status, verify,
recover, latest postimage verification) are now enumerated in the additive
`KERNEL_METHODS` catalogue, with a regression test.

Input: `{}`.

Output:
```ts
{
  ok: boolean;
  checked: number;           // distinct current file paths checked
  legacyUnverifiable: number; // owner.settled records with no postimages
  unsupportedEffects: number;// settled shell/process effects with no file proof
  unresolved: number;        // OwnerLog open/executing/UNKNOWN effects
  mismatches: Array<{
    effectId: string;
    path: string;
    expectedState: 'present' | 'absent';
    observedState: 'present' | 'absent';
    expectedDigest?: string | null;
    observedDigest?: string | null;
    observationStable: boolean;
  }>;
  scope: 'latest_settled_file_postimage_only';
}
```

The verifier takes the same permanent-inode POSIX `flock` as direct kernel
mutation admission, first reconstructs and verifies the hash-chained OwnerLog,
then checks all settled owner↔receipt links against the cryptographic receipt
chain (including unhashed receipt identity sidecars). It walks the ordered
`owner.settled` events, retains only the **last** independently observed
state for each absolute path, and independently re-reads those paths. Present
files require two matching SHA-256 reads; missing paths require two `lstat`
not-found probes. A permission error or dangling symlink is NOT proof of
absence. Any disagreement appears as a typed mismatch and `ok=false`.
A matching older state that was later legitimately overwritten is not
incorrectly treated as a current mismatch.

## Settlement evidence

Inside the existing fsynced, hash-chained `owner:effects` stream, new
`owner.settled` events carry additive `postimages`:

- `fs.write` / `fs.edit`: final file path, `present`, independent SHA-256.
- `fs.delete`: deleted file path, `absent` after independent metadata checks.
- `fs.rename`: destination path `present` with SHA-256; source path `absent`
  after independent metadata checks.
- `shell.exec`: empty array, **counted as unsupported**, not silently
  declared independently verified.

On inability to capture required evidence, the kernel writes an
`owner.unknown` and does not issue a settled receipt. In particular this
does not treat a permission-denied stat as a missing file.

## Partial RC-7 event terminology (R172)

The OwnerLog adds a `terminal` sidecar to relevant transitions:

| Transition | RC-7 terminal |
|---|---|
| `owner.settled`, successful file mutation or shell exit 0 | `succeeded` |
| `owner.settled`, shell exits with nonzero code and observable result | `failed` |
| `owner.unknown`, execution or observation cannot be established | `unknown` |
| `owner.released`, proven prepare-only crash (no execution marker) | `interrupted` |

A result can have a **settled receipt with a failed outcome**. These are
different dimensions: the effect demonstrably happened, but did not succeed.
This does NOT implement complete EffectReceiptV1 terminal semantics,
cancellation/timeouts, nested event streams or RC-18 `hz.*` emissions.
The recorded RC-18 status remains **23 of 44** canonical events.

## Reproducible test evidence

- `kernel/tests/integration.rs::owner_postimage_replay_detects_external_mutation_without_rewriting_receipt_chain`: two independent kernel processes; external overwrite detected even when `effect.owner.verify` and receipt chain remain valid; most recent of two writes wins.
- `kernel/tests/integration.rs::owner_postimage_replay_tracks_delete_absence_and_both_rename_endpoints`: both rename endpoints and subsequent deletion; externally recreated source, including a dangling symlink at the source spelling, fails replay.
- `kernel/tests/integration.rs::owner_terminal_rc7_distinguishes_settled_failure_from_unknown`: nonzero `false` execution produces settled receipt + `failed` terminal, not an invented success.
- `kernel/tests/integration.rs::owner_shell_receipt_binds_observed_streams_and_does_not_poison_next_effect`: shell effects explicitly counted unsupported by file replay.
- `app/tests/core/effect-owner-kernel.test.ts`: independent TS Rust clients, tamper detection, untrusted transport refusal and method-catalogue parity.

Run:
```bash
cd kernel && cargo test --offline --test integration
cargo test --offline --bin hz-kernel -- --skip eventlog::tests::tail_cache_keeps_a_20k_chain_verifiable
cd ../app && bun run typecheck
bun test tests/core/effect-owner-kernel.test.ts tests/core/effect-kernel-mutation-route.test.ts
cd .. && python3 ops/generate-backlog-traceability.py
git -c core.whitespace=cr-at-eol diff --check
```

**Current verified tests:** Rust integration **74 PASS / 0 FAIL**,
Rust kernel unit **115 PASS / 0 FAIL** (one existing 20,000-chain slow test
excluded), TypeScript `bun run typecheck` PASS; Bun focused owner suite
**23 PASS / 0 FAIL** after the RPC catalogue parity assertion; the
final broader focused Bun regression is **294 PASS / 0 FAIL**
across 38 files. Generated backlog matrix reproducible (47 primary,
16 repo-take, 44 source-specific, 15 checklist), `git diff --check`
PASS, and disposable Linux user+net namespace TCP denial PASS
(`ENETUNREACH`, **not** HorizonCode product routing). Full Bun regression suite **2,743 PASS / 43 FAIL / 3 SKIP** across 391
files (2,789 tests). Previous ruling 349 **2,742 PASS / 43 FAIL / 3 SKIP**:
all 43 unresolved failures remain. Known categories include parallel
tool-batch execution, code mode, context/compaction, hooks, multi-file
apply_patch evaluation (now deliberately refused until atomic kernel batch),
skills/config, the spawn allowlist checker, netns/WSL host capability
probes and TUI/PTY/color snapshots; failures are NOT all presumed pre-existing.
The full suite is NOT GREEN. Global `cargo fmt --check` FAILS from
unchanged formatting drift in `kernel/src/bin/../sandbox_veth_netlink.rs`,
not a passing gate. The scoped new `effect_owner.rs` is rustfmt-clean.
The full Bun run began before the later method-catalogue assertion and
rename-lstat hardening (verified with separate final Rust/TS runs); this
is not falsely labeled a full-final-tree green run.

## Remaining blockers (never mark CLOSED from this feature)

1. **P0-1:** Bun/hook/MCP/code mode/child effects are not universally
   kernel-owned; Guard authorization is not executed as one inseparable
   Rust effect transaction. Directory, process and multi-file patch
   effects remain incomplete.
2. **P0-2:** This verifier checks only **latest** current file states
   recorded by direct Rust effects, not historical overwritten snapshots,
   external filesystem races at execute time, independent observation
   of non-file network/shell side effects, or every effect entrypoint.
   A correct `ok=true` does not prove all P0-2 requirements.
3. **P0-3:** Universal Bun ↔ SQLite ↔ Rust ownership, alias/race proof and
   safe executed-UNKNOWN recovery still unresolved.
4. **P0-4:** No product-level netns + proxy + TLS + shell-created traffic
   denial proof. Disposable user namespace denial is not product enforcement.
5. **R172:** Nested streams, effect receipt terminal model, RC-7 across all
   sources and entrypoints are still missing.
6. **RC-18:** 21 canonical events still unmapped/unemitted. Internal
   `owner.*` transitions are NOT counted as `hz.*`.
7. **Patch parity:** an atomic multi-file kernel batch, ambiguous/fuzzy
   first-hit parity, AST multi-match and multi-hunk updates are still open.
8. **Session/kernel consistency:** universal atomic admission and
   independent durable reconciliation remain unverified.

**Operator rule:** Never call this implementation historical replay,
universal receipt verification, or a production shell-network security boundary.
