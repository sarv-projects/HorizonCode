# Landlock availability spike — 2026-11-08

> **Document class: historical evidence** (per `_conventions.md`). No normative force. It records the
> measured facts of one Landlock availability spike for NF-016, with every claim backed by a command and
> its observed output, and ranks the NF-016 options against those facts. Where this file and a re-run of
> `ops/landlock-probe.sh` disagree, the re-run wins and the disagreement is a defect to report.

**Scope.** NF-016 (`docs/24-feature-catalog.md` §NF-016, “Cross-platform sandbox matrix with typed
residuals”) names Landlock as the unprivileged, per-path Linux confinement candidate; `docs/28`
§4 item 11 calls the OS-level sandbox for Code Mode / shell “the top open authority item”. This record
answers one question before any design: **is Landlock available on the host class HorizonCode runs
on?** It was measured on the host this repository is developed in (a gVisor sandbox), 2026-11-08,
21:42–22:17 UTC, by the integrator agent. The re-runnable half is `ops/landlock-probe.sh`.

**Verdict (one paragraph).** Landlock is **not available here**: kernel release `4.19.0-gvisor`
(gVisor emulates a 4.19 kernel; Landlock needs Linux >= 5.13 with the LSM active), `/sys/kernel/security`
and `/proc/kallsyms` do not exist at all, and a raw `landlock_create_ruleset` syscall returns `ENOSYS`
(§2.1). One previously recorded fact **did not reproduce**: `unshare -Ur` succeeds reliably and
user/mount/PID/network namespaces are creatable unprivileged, so “unprivileged user namespaces
blocked” (`docs/28` §4 item 11; `docs/audit/reaudit-2026-11-08.md` L18/L59) is wrong as stated — the
`unshare -p` → `EPERM` observation is real but is the ordinary no-capabilities result, not userns
blocking (§2.2). The probe exits 3 with the reason (§3). Recommended order for NF-016: **design the
portable reduced form (c) first**, record the gVisor posture (b) now (as a statement plus an evidence
channel, not a design), and keep “require a Landlock-capable kernel” (a) as a deployment-gate input
and an upgrade path verified on a real >= 5.13 kernel via the checklist in §6.

---

## 1. Method

- One host: the gVisor sandbox this workspace runs in. The kernel string is gVisor’s compatibility
  value, not a real kernel; every kernel-level fact below is therefore a fact about *this deployment
  class*, and the probe exists to re-check it per target.
- Every fact was measured with the exact command shown; outputs are pasted verbatim (elided only where
  marked). Commands that ran programs wrote nothing outside a `mktemp -d` scratch directory and used
  no network.
- `ops/landlock-probe.sh` was written first, then run (`sh` and `bash`); its output is §3. The probe
  is read-only, offline, creates no files, and is POSIX `sh` (validated with `sh -n`, `dash -n` and
  `bash -n`; shellcheck is not installed on this host — re-run it where available).
- Terminology follows `docs/24` §NF-016: a **guarantee vector** over seven dimensions, each at
  `enforced` · `best_effort` · `unsupported`, with **typed residuals**; a caller states its minimum and
  the operation **fails closed** when the host cannot meet it (the D-10 “no silent sandbox degradation”
  rule, `docs/24` L1144).

## 2. Measured facts

### 2.1 Kernel and the Landlock surface — Landlock is absent

```text
$ date -u
Sun Nov  8 09:42:52 PM UTC 2026

$ uname -a
Linux mch-03cd203b-aa70-42d2-b499-f851e2b3ab8a 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016 x86_64 GNU/Linux

$ cat /proc/version
Linux version 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016

$ ls -la /sys/kernel/security/
ls: cannot access '/sys/kernel/security/': No such file or directory

$ cat /sys/kernel/security/lsm
cat: /sys/kernel/security/lsm: No such file or directory

$ head -3 /proc/kallsyms
head: cannot open '/proc/kallsyms' for reading: No such file or directory
```

The LSM list is **absent, not empty** — `/sys/kernel/security` itself does not exist, so there is no
place for a `landlock` entry to be, and no possibility of corroboration via kallsyms in this sandbox.

Direct syscall probe — the decisive test, since an LSM file could in principle be hidden while the
syscall exists (it is not; but this measures the interface itself). Run via `python3` + `ctypes`
(`syscall(444, …)`; the number is verified below from the system headers):

```text
$ python3 - <<'PY'
import ctypes, os
libc = ctypes.CDLL(None, use_errno=True)
LANDLOCK_CREATE_RULESET_VERSION = 1
ctypes.set_errno(0)
r = libc.syscall(444, 0, 0, LANDLOCK_CREATE_RULESET_VERSION)
err = ctypes.get_errno()
print(f"syscall(444, NULL, 0, VERSION) -> ret={r} errno={err} ({os.strerror(err)})")
ctypes.set_errno(0)
r2 = libc.syscall(444, 0, 0, 0)
err2 = ctypes.get_errno()
print(f"syscall(444, NULL, 0, 0)       -> ret={r2} errno={err2} ({os.strerror(err2)})")
PY
syscall(444, NULL, 0, VERSION) -> ret=-1 errno=38 (Function not implemented)
syscall(444, NULL, 0, 0)       -> ret=-1 errno=38 (Function not implemented)

$ python3 - <<'PY'     # control: an unknown syscall number
import ctypes, os
libc = ctypes.CDLL(None, use_errno=True)
ctypes.set_errno(0)
r = libc.syscall(9999, 0, 0, 0)
print(f"syscall(9999, ...) -> ret={r} errno={ctypes.get_errno()} ({os.strerror(ctypes.get_errno())})")
PY
syscall(9999, ...) -> ret=-1 errno=38 (Function not implemented)
```

`ENOSYS` (38) for both the version probe and the flags=0 form, with an unknown-number control returning
the same error: gVisor reports unimplemented syscalls as `ENOSYS`, so this reads as “the syscall does
not exist here”, not “Landlock is present but disabled”. (On a real kernel, a present-but-disabled
Landlock answers `EOPNOTSUPP` from the version probe instead.)

System headers on this host agree on the syscall number, useful for the §6 checklist:

```text
$ grep -rn 'landlock_create_ruleset' /usr/include | head -5
/usr/include/linux/landlock.h:17: * Argument of sys_landlock_create_ruleset().
/usr/include/linux/landlock.h:56: * sys_landlock_create_ruleset() flags:
/usr/include/x86_64-linux-gnu/bits/syscall.h:838:#ifdef __NR_landlock_create_ruleset
/usr/include/x86_64-linux-gnu/bits/syscall.h:839:# define SYS_landlock_create_ruleset __NR_landlock_create_ruleset
/usr/include/asm-generic/unistd.h:797:#define __NR_landlock_create_ruleset 444

$ grep -n 'LANDLOCK_CREATE_RULESET_VERSION' /usr/include/linux/landlock.h
63:#define LANDLOCK_CREATE_RULESET_VERSION			(1U << 0)
```

### 2.2 Sandbox primitives — including the userns correction

```text
$ id
uid=10001(forge) gid=10001(forge) groups=10001(forge)

$ grep -i '^Cap' /proc/self/status
CapInh:	0000000000000000
CapPrm:	0000000000000000
CapEff:	0000000000000000
CapBnd:	00000000a80405fb
CapAmb:	0000000000000000

$ command -v bwrap || echo 'bwrap: not found'
bwrap: not found

$ bwrap --version 2>&1 || echo "bwrap --version: exit $?"
/bin/sh: 6: bwrap: not found
bwrap --version: exit 127

$ unshare -p true 2>&1; echo "unshare -p true: exit $?"
unshare: unshare failed: Operation not permitted
unshare -p true: exit 1

$ unshare -Ur true 2>&1; echo "exit=$?"
exit=0

$ for i in 1 2 3; do unshare -Ur true 2>&1; echo "run$i exit=$?"; done
run1 exit=0
run2 exit=0
run3 exit=0

$ unshare -Ur sh -c 'id; echo uid_map:; cat /proc/self/uid_map; echo gid_map:; cat /proc/self/gid_map' 2>&1
uid=0(root) gid=0(root) groups=0(root)
uid_map:
         0      10001          1
gid_map:
         0      10001          1

$ unshare -Upr sh -c 'echo "without --fork: mypid=$$"' 2>&1; echo "exit=$?"
without --fork: mypid=28932        # parent-namespace pid: payload not in the new PID ns
exit=0

$ unshare -Uprf sh -c 'echo "with --fork: mypid=$$"' 2>&1; echo "exit=$?"
with --fork: mypid=1
exit=0

$ sh -c 'echo "outside: mypid=$$"'
outside: mypid=28935

$ unshare -Urm sh -c 'mount -t tmpfs none /mnt && echo mount-ok' 2>&1; echo "exit=$?"
mount-ok
exit=0

$ cat /proc/net/dev 2>&1 | head -5     # outside: lo + eth0 with traffic counters
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 2627359   16006    0    0    0     0          0         0  2851443   16006    0    0    0     0       0          0
  eth0: 821292126 1765967    0    0    0     0          0         0 4159098406 1523640    0    0    0     0       0          0

$ unshare -Ur --net sh -c 'cat /proc/net/dev 2>&1 | head -5; echo "--- ls /sys/class/net ---"; ls /sys/class/net 2>&1' 2>&1; echo "exit=$?"
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
--- ls /sys/class/net ---
ls: cannot access '/sys/class/net': No such file or directory
exit=2
# (inside the netns eth0 is gone; /sys/class/net does not exist under gVisor either way)
```

Reading of this block:

- **`unshare -p` → `EPERM` reproduces, but it does not mean userns is blocked.** Without a user
  namespace, creating a PID namespace needs `CAP_SYS_ADMIN`, which uid 10001 does not have
  (`CapEff: 0`). With `-U` the same operations succeed: `unshare -Ur` (user), `-Urm` (mount; a tmpfs
  mount inside actually worked), `-Uprf` (PID; the payload is pid 1 of the new namespace and `--fork`
  is required for the payload to *enter* it), `-Ur --net` (network; `eth0` disappears, only `lo`
  remains). Measured three times for `-Ur` to rule out a fluke.
- The sysctls that gate userns on some distros (`kernel.unprivileged_userns_clone`,
  `user/max_user_namespaces`, `kernel.unprivileged_bpf_disabled`) **do not exist** here — gVisor has
  no `/proc/sys` entries for them; absence of these knobs says nothing either way, the `unshare`
  results do.
- **`bwrap` is absent** (exit 127), so the bubblewrap backend of the designed matrix has no runtime
  on this class.
- `Seccomp: 0` in `/proc/self/status` (no filter installed on the measuring shell; §2.3 installs one
  in a child), and `kernel/seccomp/actions_avail` does not exist (no sysfs entry).
- `/sys/class/net` does not exist under gVisor (checked inside and outside the netns), so network
  interface evidence comes from `/proc/net/dev`.

### 2.3 Additional measurements relevant to the reduced form (option c)

Beyond the stated fact list, three checks matter for ranking option (c) “seccomp + no_new_privs +
rlImits + network-off”. All ran as throwaway binaries compiled with `cc -O2 -Wall` inside a
`mktemp -d` (appendices A–B carry the sources; nothing was installed or left behind):

```text
$ ./probe              # (1) no_new_privs + rlimits, installs
PR_SET_NO_NEW_PRIVS=1: ok
setrlimit(RLIMIT_AS 64MiB): ok
setrlimit(RLIMIT_NOFILE 64): ok
exit=0

$ ./probe filter       # (2) allow-all BPF filter
PR_SET_NO_NEW_PRIVS=1: ok
setrlimit(RLIMIT_AS 64MiB): ok
setrlimit(RLIMIT_NOFILE 64): ok
PR_SET_SECCOMP FILTER (allow-all): ok
exit=0

$ ./probe strict       # (3) SECCOMP_MODE_STRICT
PR_SET_NO_NEW_PRIVS=1: ok
setrlimit(RLIMIT_AS 64MiB): ok
setrlimit(RLIMIT_NOFILE 64): ok
PR_SET_SECCOMP STRICT: ERROR: Invalid argument
exit=0

$ ./t                  # (4) deny filter: control, install, enforcement
getpid before filter: ret=28412
install(ERRNO(EPERM)): ok
getpid after ERRNO filter: ret=-1 errno=1 (Operation not permitted)
exit=0

$ ./t kill             # (5) KILL_PROCESS denial
install(KILL_PROCESS): ok
exit=159               # killed by SIGSYS; the shell reported "Bad system call"

$ ./t rlimit           # (6) RLIMIT_AS enforcement
malloc(256MiB) under RLIMIT_AS=64MiB: refused
exit=0
```

Honest limits of this block: it proves the primitives **install and enforce on this host for the
cases tested** (ERRNO denial of one syscall, KILL_PROCESS, RLIMIT_AS), not that every seccomp return
code behaves like Linux — `TRACE`, `LOG`, `KILL_THREAD`, `TSYNC` and filter stacking were not tested,
and gVisor’s seccomp emulation is known to be partial. Any design that uses them must verify
enforcement at spawn (see §7) rather than trust install-ok.

## 3. The probe, and its verbatim output

`ops/landlock-probe.sh` (new file, mode 755) implements the checks in this order: kernel release;
`>= 5.13` verdict (major.minor only, suffix-tolerant, unparsable releases fail closed); LSM list from
`/sys/kernel/security/lsm`; `landlock` presence in that list with the `grep -i landlock
/proc/kallsyms | head -1` corroboration when kallsyms is readable; `unshare -Ur true` attempt;
`bwrap --version` attempt; one `verdict` line naming the reason. Exit **0** = Landlock usable (kernel
>= 5.13 AND `landlock` in the LSM list), **3** = not usable. It is read-only, offline, POSIX `sh`,
creates no files. Version parsing was unit-checked against `4.19.0-gvisor`, `5.13.0-20-generic`,
`5.13-rc1`, `5.12.9`, `6.1.0-13-amd64`, `5.15.0-91-generic`, `5`, `6.6`, `5.13`, `weird`,
`(unknown)` — all correct (5.13/6.x → yes; 5.12/4.19 → no; malformed → unknown).

Evidence, exactly as prescribed:

```text
$ bash ops/landlock-probe.sh; echo exit=$?
== landlock probe (NF-016) ==
kernel release          : 4.19.0-gvisor
kernel >= 5.13          : no (4.19 < 5.13)
LSM list                : (absent: /sys/kernel/security/lsm)
landlock in LSM list    : no
kallsyms corroboration  : (skipped: /proc/kallsyms not readable)
unshare -Ur true        : ok (exit 0)
bwrap --version         : not found (exit 127)
verdict                 : NOT USABLE — kernel 4.19.0-gvisor is below 5.13 (Landlock requires Linux >= 5.13 with the LSM active)
exit=3

$ sh ops/landlock-probe.sh; echo exit=$?
== landlock probe (NF-016) ==
kernel release          : 4.19.0-gvisor
kernel >= 5.13          : no (4.19 < 5.13)
LSM list                : (absent: /sys/kernel/security/lsm)
landlock in LSM list    : no
kallsyms corroboration  : (skipped: /proc/kallsyms not readable)
unshare -Ur true        : ok (exit 0)
bwrap --version         : not found (exit 127)
verdict                 : NOT USABLE — kernel 4.19.0-gvisor is below 5.13 (Landlock requires Linux >= 5.13 with the LSM active)
exit=3

$ sh -n ops/landlock-probe.sh && dash -n ops/landlock-probe.sh && bash -n ops/landlock-probe.sh; echo syntax=$?
syntax=0
```

Note for the deployment-gate half: exit 3 is *expected and correct* on this host class, so a gate
wired to the probe must consume the code **and** the verdict line (never treat “the command ran” as
“confinement exists”), and must not be aimed at gVisor targets with a Landlock requirement — that is
exactly the fail-closed collision option (a) cannot resolve (§4).

## 4. Options for NF-016, with trade-offs

Ranked here by what the measured facts allow *today*; the recommendation follows in §5.

| # | Option | Measured status on this host | Enforces | Cannot do |
|---|---|---|---|---|
| (a) | Require a Landlock-capable kernel (>= 5.13, LSM active) on deployment targets; probe is the gate | **Impossible here** (probe exit 3; ENOSYS; no LSM surface) | Per-path filesystem read/write/exec; TCP bind/connect at ABI >= 4; unprivileged, no bwrap needed | Nothing on gVisor-class targets; no per-command scoping beyond the ruleset it builds; macOS/Windows need siblings |
| (b) | On gVisor/container deployments the outer sandbox is the confinement of record; per-effect controls add evidence, not isolation | **True here** (we are inside gVisor; the guest cannot escape it) | Bounds the whole agent — process tree, filesystem reach, network reach as configured by the orchestrator | Per-*command* confinement; per-path rules; verification from inside — needs orchestration-side attestation to be auditable; says nothing if the target is not actually gVisor |
| (c) | Portable reduced form for `code_mode`/`shell` children: seccomp + `no_new_privs` + rlimits + network-off (netns or filter), typed as `best_effort` with residuals | **Primitives available here** (§2.3: enforcement observed for ERRNO/KILL/rlimits; netns gives network-off) | Syscall-level denials per child; resource caps; process/network namespace isolation; kills on violation | No per-path rules (the core Landlock advantage); filters are allow/deny lists maintained by us; still in-guest — a child that escapes the wrapper is back to ambient authority; partial gVisor seccomp semantics need per-target verification |

### (a) Require Landlock-capable kernels and gate on the probe

The only option that provides **path-level** filesystem confinement enforced by the kernel — the
property `docs/11-authority-safety.md` §S5 and the NF-016 guarantee vector are written around
(L1467–L1519: per-path read/write scopes, probe the ABI with a raw syscall, no silent fallback).
Trade-offs grounded in §2.1: on the measured host class it can never turn green — gVisor emulates a
4.19 kernel and exposes no Landlock syscall, so “require it” means “refuse all confined work” on
exactly the deployments we actually run; making the probe a gate without deciding that policy is
worse than useless. It stays the **upgrade path** and a per-target gate for bare-metal/VM targets,
verified via §6 on a real kernel. Cost: one already-written script plus a gate decision; the design
work moves to the first capable target.

### (b) The gVisor posture: outer sandbox as confinement of record

Stating this posture is free and prevents overclaiming: today, the only *enforced* confinement on
this class is the outer sandbox the orchestrator built (gVisor). The per-effect layer (Guard,
approvals, keyed frames, fd-verified writes) is real and valuable, but its product is **evidence and
narrowing, not isolation** — a `code_mode` child that ignores the bridge still cannot escape the
outer sandbox, but it *can* reach everything the agent process can reach (including the policy store
and anything else mounted), and `setsid` descendants remain in the same blast radius. Limits to record
with the posture:

- **Whole-agent scope, not per-command.** The outer sandbox bounds the entire HorizonCode process
  tree; there is no way to say “this one shell command may write only under `<workspace>`”.
- **Unverifiable from inside.** Nothing inside the guest can prove the guest is gVisor, what its
  version/config is, what is mounted, or what network policy applies. The posture needs an
  **attestation** from the orchestrator (gVisor version/config, mount set, network policy, container
  seccomp profile) to be auditable — without it the guarantee vector must mark these dimensions
  `unsupported`/unknown rather than `enforced`.
- **Conditional on the target actually being gVisor.** Where the same artifact is deployed on a plain
  Docker/kernel, the posture does not hold at all; the probe (and, ideally, attestation) must say
  which case a target is.

### (c) Portable reduced form (design input only)

Measured available here (§2.3), which is its whole argument: it is the only NF-016 mechanism that can
be *implemented and exercised* on the measured host class today. Shape for the design wave:
`code_mode` (and `shell`) children are spawned with `PR_SET_NO_NEW_PRIVS=1`, per-child rlimits
(RLIMIT_AS/NOFILE/…), a seccomp filter that removes what the child never needs (network syscalls,
process creation/`setsid`, keyctl/ptrace, …) with explicit `SECCOMP_RET_ERRNO`/`KILL` policy, and a
network-off profile (netns where available — measured working here with only `lo` inside; a filter
denial of `socket`/`connect` as the fallback). Trade-offs and honesty requirements:

- **Weaker than Landlock by construction:** no per-path rules. “Writes only under the workspace”
  cannot be expressed; the strongest statement is “this child cannot make the syscalls a sandboxed
  child does not need”. This must be typed `best_effort` per dimension with residuals, per NF-016 —
  never presented as equivalent to option (a).
- **Allow/deny lists are ours to maintain** (kernel ABI drift, new syscalls, arch differences — the
  filter must pin arch, as appendix A does). That is an ongoing cost, not a one-shot.
- **Enforcement varies by host:** measured true for ERRNO/KILL here, but gVisor’s seccomp is partial
  and `SECCOMP_MODE_STRICT` already returned `EINVAL`. The design must probe enforcement at spawn
  (install a canary filter + denied syscall and observe) instead of trusting install-ok.
- **In-guest, not kernel-external:** a process that escapes the wrapper (fork/exec outside the
  spawner, `setsid` today) runs unconfined again. It narrows the watched children; it does not change
  the class of authority the agent holds. Combined with (b) it is defense-in-depth inside a bound
  blast radius.
- **Namespace component is optional and security-sensitive:** `unshare -Uprf` (pid 1 child) and
  `-Ur --net` work here, but bwrap is absent and hand-rolling a namespace sandbox without a reviewed
  launcher is exactly where subtle escapes live; the design should either adopt a reviewed helper
  (codex-style launcher crate, the `linux_pid_namespace` pattern already catalogued at `docs/24` L193)
  or defer namespaces and ship seccomp+rlimits+network-off first.

## 5. Recommendation

1. **Design (c) first.** It is the only option that yields an implementable, testable confinement
   improvement on the measured host class (§2.3), and it is explicitly scoped as design input — the
   wave should produce the child-profile design (filter policy format, spawn-time enforcement probe,
   guarantee-vector typing, residuals) before any code. Grounding: (a) cannot be satisfied here at
   all (§2.1), so sequencing (a) first would leave the top authority item blocked on infrastructure
   that does not exist; (c) can land inside the current deployment.
2. **Record (b) now, as posture + evidence channel.** No design needed beyond the attestation
   requirement and the limits in §4 — but until it is written down, `docs/28` gap lists and the
   guarantee vector invite “the sandbox exists” readings that the measurements do not support. The
   attestation (what the orchestrator can actually state about the outer sandbox) is the one piece of
   (b) that must be designed with the infra owner.
3. **Wire (a) as the probe-gated upgrade path.** Keep `ops/landlock-probe.sh` as the per-target
   instrument; the policy decision for exit 3 (refuse vs downgrade with typed residual) belongs to the
   gate design (`docs/16` `sandbox.backends` row already states “warn on degraded, fail when the mode
   requires the missing dimension”), not to the probe. Do the §6 checklist on the first real >= 5.13
   target.

Composition note: these are layers, not alternatives. On a Landlock-capable target, (a) enforces
path-level filesystem dimensions and (c) remains useful for network/process denials and rlimits; on
this gVisor class, (b) bounds the agent and (c) narrows the children — and the guarantee vector must
report exactly which layer supplies which dimension, at what level, with the residual named, or the
D-10 silent-degradation failure returns through the back door.

## 6. Follow-up checklist on a >= 5.13 kernel (for the next agent)

Run on a real kernel (bare-metal VM or CI runner; `docs/27` L217 already records that gVisor cannot
prove Linux sandbox guarantees — the `ubuntu-latest` runner is the intended venue):

1. **Availability.** `sh ops/landlock-probe.sh` → expect exit 0, `kernel >= 5.13 : yes (x.y …)`,
   `landlock in LSM list : yes`. Record the full LSM list and kernel release. If exit 3, stop here.
2. **ABI version.** Raw syscall probe — `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`:
   ```sh
   python3 - <<'PY'
   import ctypes, os
   libc = ctypes.CDLL(None, use_errno=True)
   ctypes.set_errno(0)
   abi = libc.syscall(444, 0, 0, 1)   # __NR_landlock_create_ruleset, LANDLOCK_CREATE_RULESET_VERSION
   print("Landlock ABI:", abi, "errno:", ctypes.get_errno(), os.strerror(ctypes.get_errno()) if ctypes.get_errno() else "")
   PY
   ```
   Expected: a positive integer (>= 1). Map the result against `docs/11-authority-safety.md` L1492–L1494:
   network TCP bind/connect needs **ABI >= 4**; below that, `network_egress` is a typed residual.
3. **Per-path rules actually deny.** Build a ruleset that allows `READ_FILE|WRITE_FILE|READ_DIR` only
   under a scratch root (`handled_access_fs` set to exactly the handled bits), `PR_SET_NO_NEW_PRIVS=1`,
   then `landlock_restrict_self`. Verify: write outside → `EACCES`; read outside → `EACCES`; read/write
   inside → ok. Confirm that without `no_new_privs` the restrict fails closed (`EPERM`), proving the
   prerequisite ordering rather than assuming it.
4. **Exec restriction.** Include `LANDLOCK_ACCESS_FS_EXECUTE` in `handled_access_fs` and test that
   executing a helper outside the allowed set fails while an allowed binary runs. Confirm the flag
   names against `<linux/landlock.h>` on the target (header on this host lists `EXECUTE`, `WRITE_FILE`,
   `READ_FILE`, `READ_DIR`, `REMOVE_*`, `MAKE_*`, `REFER`, `TRUNCATE`, `IOCTL_DEV`; network:
   `BIND_TCP`, `CONNECT_TCP`; scopes: `ABSTRACT_UNIX_SOCKET`, `SIGNAL`).
5. **Referral behavior (ABI >= 2, `REFER`).** Rename/link across two allowed directories; confirm the
   deny-by-default behavior when either side lacks rights, and decide the workspace-fence policy
   (NF-016’s `workspace fence` dimension interacts with git’s rename patterns — a known sharp edge in
   codex’s backend).
6. **Irreversibility.** After `restrict_self`, verify the process cannot undo restrictions and cannot
   clear `no_new_privs` (`PR_SET_NO_NEW_PRIVS=0` → `EPERM`); a sandbox that can be lifted by the
   sandboxed process is a guarantee-vector lie.
7. **Stacking with (c).** In the intended child order (rlimits → `no_new_privs` → seccomp filter →
   Landlock ruleset → exec), verify a denied syscall returns the intended action and path denials still
   work — seccomp (syscall layer) and Landlock (VFS layer) are independent, but the combination is what
   ships.
8. **Coverage mapping.** For each of the seven NF-016 dimensions, write down what Landlock on that
   ABI/kernel covers (`enforced`), what only other layers cover (`best_effort`), and the residuals
   (network below ABI 4; ioctl below ABI 5; abstract unix sockets/signals via scopes; anything not
   handled). This mapping is the deliverable the guarantee vector consumes.
9. **CI pinning.** Record the kernel release in the capability record; `ubuntu-latest` kernels move,
   and an “enforced” claim is only as good as the kernel it was measured on.

## 7. Corrections to the corpus (measured vs written)

These are flagged for the owners of those files; this record edits none of them.

| Where | Written | Measured | Correct shape |
|---|---|---|---|
| `docs/28-implementation-status.md` §4 item 11 (L119) | “unprivileged user namespaces blocked (`unshare -p` → EPERM)”; Landlock “to be verified on the deployment kernel” | `unshare -p` EPERM yes; `unshare -Ur`/`-Urm`/`-Uprf`/`-Ur --net` all succeed (§2.2); Landlock verified **not available** (§2.1) | Replace with: userns available; `bwrap` absent; Landlock unavailable on this class — see `ops/landlock-probe.sh` + this record |
| `docs/audit/reaudit-2026-11-08.md` L18, L59 | “no bwrap/userns on this machine” | bwrap absent; userns available | Same correction as above |
| `docs/audit/external-audit-2026-11-08.md` L201 | “Landlock … measured as available; `bwrap` and unprivileged user namespaces are not” | Landlock **not** available; userns available; bwrap not available | Both halves need fixing; the recommendation to “wrap the runtime in an OS sandbox” should point at this record |
| `docs/audit/competitive-viability-audit-2026-11-08.md` L35 | “no bwrap/userns” | userns half wrong | Keep “no bwrap”; correct userns |
| `docs/27-implementation-plan.md` L217 | Linux sandbox guarantees “not provable here; … gVisor interposes syscalls → must run on CI” | Confirmed by §2.1 (no LSM surface, ENOSYS) | No change |

## 8. Open questions

1. **Target uniformity.** Is every deployment target gVisor-class, or do some run on plain kernels?
   The probe answers this per target; nobody has run it fleet-wide. This determines whether (a) ever
   turns green and what the gate policy for exit 3 must be.
2. **Attestation channel for (b).** Who can state — as an evidence artifact, not prose — the outer
   sandbox’s identity (gVisor version/config, mounts, network policy, container seccomp profile)?
   Without it, posture (b) cannot rise above “the operator says so”, and the guarantee vector must
   mark those dimensions unknown/unsupported.
3. **Gate semantics.** Should `ops/gates.sh` gain a sandbox-probe gate, and on which runner? On this
   class it would assert exit 3 + verdict line (documenting the expected posture); on a capable runner
   it would assert exit 0 (documenting the upgrade path). The docs/16 rule (“warn on degraded, fail
   when the mode requires the missing dimension”) is the design input.
4. **Where (c) lives.** Which component builds and enforces the child profile — the kernel effect
   host of NF-016, or the current spawner (`app/src/core/owned-spawn.ts` / `app/src/tools/codemode.ts`)
   in a first reduced form? The measured facts do not decide ownership; the NF-016 design must.
5. **Spawn-time enforcement proving.** gVisor’s seccomp semantics are partial (measured: ERRNO/KILL
   work, STRICT does not; stacking and TRACE/LOG untested). Does the reduced form re-verify at spawn
   with a canary, and how is that recorded? (Proposed: yes — evidence, not assumption.)
6. **Namespace or no namespace in (c) v1.** `unshare -Uprf`/`-Ur --net` work here, but shipping a
   hand-rolled namespace launcher without a reviewed codebase is a risk; ship
   seccomp+rlimits+network-off first and treat namespaces as v2, or adopt the codex `linux_pid_namespace`
   pattern wholesale?

## 9. What was NOT measured

- Real Landlock behavior of any kind (ruleset creation, path denials, ABI numbers above the ENOSYS
  probe) — none of it exists on this host by measurement; §6 is the checklist for where it does.
- macOS (Seatbelt) and Windows backends; other hosts in the deployment fleet; host-side gVisor
  configuration (not visible from inside).
- Seccomp return codes beyond `ERRNO` and `KILL_PROCESS`; filter stacking; `TSYNC`; `TRACE`/`LOG`.
  `SECCOMP_MODE_STRICT` was measured and is unsupported (`EINVAL`).
- Whether rlimits are enforced for *all* limits a profile would set (RLIMIT_AS and RLIMIT_NOFILE
  were observed enforced/refused; CPU/NPROC/FILE_SIZE not tested).
- Any end-to-end `code_mode`/`shell` change: nothing in `app/` or `kernel/` was built or modified by
  this spike — it is a probe plus a record.

---

## Appendix A — the deny/enforcement harness (`t.c`) used in §2.3

Compiled with `cc -O2 -Wall -o t t.c` in a `mktemp -d`; run as `./t`, `./t kill`, `./t rlimit`. It
sets `PR_SET_NO_NEW_PRIVS`, then installs a filter that denies `getpid` with the requested action;
values printed before installation are the control that the syscall works unfiltered.

```c
#define _GNU_SOURCE
#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>

static int install(const char *mode, __u32 ret) {
  struct sock_filter f[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_getpid, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, ret),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog prog = { .len = sizeof f / sizeof f[0], .filter = f };
  prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L);
  errno = 0;
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) != 0) {
    printf("install(%s): ERROR: %s\n", mode, strerror(errno));
    return 1;
  }
  printf("install(%s): ok\n", mode);
  return 0;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "kill") == 0) {
    if (install("KILL_PROCESS", SECCOMP_RET_KILL_PROCESS)) return 1;
    fflush(stdout);
    syscall(__NR_getpid);            /* must not return */
    printf("getpid survived despite KILL_PROCESS - NOT ENFORCED\n");
    return 7;
  }
  if (argc > 1 && strcmp(argv[1], "rlimit") == 0) {
    struct rlimit rl = { .rlim_cur = 64L * 1024 * 1024, .rlim_max = 64L * 1024 * 1024 };
    if (setrlimit(RLIMIT_AS, &rl) != 0) { printf("setrlimit: ERROR: %s\n", strerror(errno)); return 1; }
    fflush(stdout);
    char *p = malloc(256L * 1024 * 1024);
    if (p == NULL) { printf("malloc(256MiB) under RLIMIT_AS=64MiB: refused\n"); return 0; }
    memset(p, 1, 256L * 1024 * 1024);
    printf("malloc+touch(256MiB) under RLIMIT_AS=64MiB: SUCCEEDED - LIMIT NOT ENFORCED\n");
    return 0;
  }
  printf("getpid before filter: ret=%ld\n", (long)getpid());
  if (install("ERRNO(EPERM)", SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))) return 1;
  fflush(stdout);
  errno = 0;
  long p = syscall(__NR_getpid);
  printf("getpid after ERRNO filter: ret=%ld errno=%d (%s)\n", p, errno, errno ? strerror(errno) : "no error - FILTER NOT ENFORCED");
  return 0;
}
```

## Appendix B — the install/enforcement probe (`probe.c`) used in §2.3

Compiled with `cc -O2 -Wall -o probe probe.c` in a `mktemp -d`; run as `./probe`, `./probe filter`,
`./probe strict`. It installs `no_new_privs`, sets two rlimits, and (per argument) installs an
allow-all BPF filter or `SECCOMP_MODE_STRICT`.

```c
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <linux/seccomp.h>
#include <linux/filter.h>

static void rl(const char *name, int what, rlim_t v) {
  struct rlimit rl;
  rl.rlim_cur = v; rl.rlim_max = v;
  errno = 0;
  if (setrlimit(what, &rl) == 0) printf("setrlimit(%s): ok\n", name);
  else printf("setrlimit(%s): ERROR: %s\n", name, strerror(errno));
}

int main(int argc, char **argv) {
  errno = 0;
  if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) == 0) puts("PR_SET_NO_NEW_PRIVS=1: ok");
  else printf("PR_SET_NO_NEW_PRIVS=1: ERROR: %s\n", strerror(errno));

  rl("RLIMIT_AS 64MiB", RLIMIT_AS, 64L * 1024 * 1024);
  rl("RLIMIT_NOFILE 64", RLIMIT_NOFILE, 64L);

  if (argc > 1 && strcmp(argv[1], "filter") == 0) {
    struct sock_filter f[] = { BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW) };
    struct sock_fprog prog = { .len = 1, .filter = f };
    errno = 0;
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) == 0)
      puts("PR_SET_SECCOMP FILTER (allow-all): ok");
    else
      printf("PR_SET_SECCOMP FILTER (allow-all): ERROR: %s\n", strerror(errno));
  }

  if (argc > 1 && strcmp(argv[1], "strict") == 0) {
    fflush(stdout);
    errno = 0;
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_STRICT, 0L, 0L, 0L) == 0) {
      const char ok[] = "PR_SET_SECCOMP STRICT: ok\n";
      if (write(1, ok, sizeof ok - 1) < 0) { /* ignore */ }
      _exit(0);
    }
    printf("PR_SET_SECCOMP STRICT: ERROR: %s\n", strerror(errno));
  }
  return 0;
}
```
