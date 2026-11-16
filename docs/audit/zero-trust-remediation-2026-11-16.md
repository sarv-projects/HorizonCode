# Zero-trust remediation — 2026-11-16

> Branch `audit-remediation` (checkpoint `b13a82f` preserved the prior 114-file
> WIP). This page records what was actually changed and what remains. It is
> evidence, not a completion claim: the overall goal stays **NOT COMPLETE**.

## Fixed in this wave

| Finding | Change | Commit |
|---|---|---|
| C1 — workspace `.env` could replace the kernel/provider | `bin/hzcode` uses `bun --no-env-file`; only `~/.config/horizon/env` (0600, outside workspace) is loaded; package scripts use `--no-env-file`; regression tests | `8d0455a` |
| C4 — kernel absent meant Bun authority | untrusted/unverified kernel forces **read-only**; `--allow-untrusted` is the explicit opt-out; `doctor` shows the posture | `8d0455a` |
| H-35 — no kernel pin | `kernel/kernel.sha256` + `HZ_KERNEL_SHA256`; verified before spawn; `HZ_KERNEL_PIN=require` refuses absent/mismatch; `doctor` reports the digest | `8d0455a`, `097051d` |
| C2 — symlink write escape | write/edit/apply_patch/ast_edit/undo guard the **real** target; atomic write re-checks the approved real path; hostile-write tests | `ed7aa5c` |
| C3 — grep symlink read escape | realpath root before guard, skip symlink entries, per-candidate checks; hostile tests | `ed7aa5c` |
| H6 — execution-bearing writes allowed | Rust `sensitive-write` rule + TypeScript LocalKernel mirror: `.git/hooks`, `.env*`, manifests/lockfiles, CI workflows, Makefile/Dockerfile, shell rc → **ask** | `ed7aa5c`, `989aae6` |
| H2 — provider hangs | request (30 s), total (300 s), stream-idle (60 s) budgets; typed timeout errors; 11 tests | `5f6d8e7` |
| H3 — raw prompts/output in audit log | deep redaction, digests + previews, 64 KB cap; event types unchanged | `f41d3e9` |
| H4 — state 0644 / unignored | runtime DBs/transcripts/exports under `.hz/state`, 0700/0600, legacy read fallback, generated `.hz/.gitignore` | `f41d3e9` |
| H5 — plan mode not read-only | conservative read-only command allowlist; unknown program refused; `find -delete`, `git checkout`, `make`, `npm install` denied | `3293b6b` |
| H7 — live-session corruption | durable `session_owners` table, pid+boot-id+start-ticks liveness, epoch CAS takeover, heartbeat, owner-before-repair; `SessionOwnedError` | `3293b6b` |
| H8 — typecheck red | added `thinking_loop` to `RunExit.detail`; typecheck green | `b13a82f` + `9990af7` |
| H9 — O(n²) verifier (bounded) | full OwnerLog/receipt/archive verification at most once per 30 s; unresolved-only status between; `effect.execute` still verifies under the owner lock | `42186d3` |
| H1 — static sandbox claim | TS and Rust live `/bin/true` canary; probe carried on `sandbox.report`; WSL child-net default visible; code_mode requires a verified sandbox and refuses otherwise | `b890f27` |
| Low — 51 MB `bun:test` tracked | removed from the index; ignored | `cd5cdbc` |
| Backlog **C-5** | durable lock-guarded `SpendLedger` (reserve/settle/release, micro-USD, corruption fails closed) + reservation before each provider dispatch | `eacbb00`, `9990af7` |
| Docs claims | README now states read-only fallback, 28 tools, reduced fullscreen, `.env` behavior | `eacbb00` |

## Verification

```bash
cd app && bun run typecheck          # green
cd app && bun test tests/providers   # 124 pass
cd app && bun test tests/core/{kernel-pin,env-trust,fallback-readonly}.test.ts  # 23 pass
cd app && bun test tests/tools/{hostile-write,write,edit,grep,apply-patch,ast-edit,undo}.test.ts # 188 pass
cd app && bun test tests/core/{sandbox-spawn,codemode-sandbox,sandbox-child-net}.test.ts # 30 pass
cd app && bun test tests/core/{command-guard,session-owner,session,plan-loop}.test.ts # 45 pass
cd kernel && cargo test --locked      # 132 + 80 + 17 passed
./bin/hzcode doctor --json            # kernel.pin OK, kernel.mode trusted + pinned
```

Host limitation (unchanged): WSL2 denies `unshare(CLONE_NEWNET)`. Shell children
run with FS/seccomp confinement and `HZ_SANDBOX_CHILD_NET=on`; **network is not
confined** and the UI/doctor say so. `HZ_SANDBOX_REQUIRE=1` refuses this posture.
`code_mode` requires network-off, so it refuses to run on this host rather than
running unsandboxed.

## Still open / next

- Full `bun test` result is recorded in `/tmp/hz-full-test.log`; triage any
  failures before merging.
- **H9:** the 30 s window is a bound, not an incremental verifier. A true
  append-only/tail verifier remains.
- **H-4:** default `allow` writes still carry no one-use lease. Either mint a
  lease for every allow or downgrade the HLD invariant.
- **H-29/H-30:** `hzk` still dies with the parent; no independent supervisor.
- **H-31:** workspace identity is still a path string, not `(dev, ino)` in the
  guard digest.
- **EffectHost/R170/egress (backlog §Z):** universal kernel ownership, atomic
  `fs.batch`, routed netns egress and full R172 remain the P0 backlog.
- **E-4:** continuous Markdown transcript exists; `--restore` / default-on wiring
  is the next user-visible backlog row.
