#!/usr/bin/env python3
"""Build the current non-authoritative coverage index from the authoritative backlog.

The matrix is a cross-reference, not evidence that a feature is complete.
It captures upstream landing paths, existing status claims and test-evidence flags.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
FULL = (ROOT / "docs/FULL-BACKLOG-2026-11-13.md").read_text(encoding="utf-8")
STEAL = (ROOT / "docs/30-steal-list.md").read_text(encoding="utf-8")
OUT = ROOT / "docs/BACKLOG-TRACEABILITY-2026-11-13.md"


def section(text: str, prefix: str, heading: str = "## ") -> str:
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(heading + prefix))
    end = next((i for i in range(start + 1, len(lines))
                if lines[i].startswith(heading) and not lines[i].startswith(heading + prefix)),
               len(lines))
    return "\n".join(lines[start:end])


def cells(line: str) -> list[str]:
    return [p.strip().replace(r"\|", "|") for p in re.split(r"(?<!\\)\|", line.strip())[1:-1]]


def clean(s: str, limit: int = 135) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    s = s.replace("|", "/")
    return s if len(s) <= limit else s[:limit - 3] + "..."


SOURCES = sorted(
    list((ROOT / "app/src").rglob("*.ts")) + list((ROOT / "kernel/src").rglob("*.rs")),
    key=lambda p: p.as_posix(),
)
TESTS = sorted((ROOT / "app/tests").rglob("*.test.ts"), key=lambda p: p.as_posix())


def landing(*texts: str) -> str:
    matches: list[str] = []
    for txt in texts:
        for p in re.findall(r"`((?:app|kernel)/(?:src|tests)/[^\s`|,;:)]+)`", txt):
            if (ROOT / p).exists() and p not in matches:
                matches.append(p)
        # Many status entries name the source basename without a directory.
        # Resolve only exact basenames from the current tree, never invent paths.
        for name in re.findall(r"`([A-Za-z][A-Za-z0-9_-]+\.(?:ts|rs))`", txt):
            for src in SOURCES:
                if src.name == name:
                    p = src.relative_to(ROOT).as_posix()
                    if p not in matches:
                        matches.append(p)
    actual = matches[:2]
    proof = []
    for p in actual:
        stem = Path(p).stem
        for test in TESTS:
            if test.name == stem + ".test.ts":
                proof.append(test.relative_to(ROOT).as_posix())
    out = ", ".join("`" + p + "`" for p in actual) or "not source-mapped"
    if proof:
        out += "; test: " + ", ".join("`" + p + "`" for p in proof[:1])
    return out


def status_claim(st: str) -> str:
    return "partial; TESTED claimed" if "TESTED" in st else "partial; no TESTED claim"


def markdown_row(*data: str) -> str:
    return "| " + " | ".join(clean(x) for x in data) + " |"


main = []
source_rows = {}
for line in section(STEAL, "2. The consolidated steal list").splitlines():
    if not re.match(r"^\| [A-J]-\d+ \|", line):
        continue
    parts = cells(line)
    if len(parts) >= 6:
        source_rows[parts[0]] = parts

for line in section(FULL, "C. §7 OPEN rows only").splitlines():
    m = re.match(r"^\| \*\*([A-J]-\d+)\*\* \|", line)
    if not m:
        continue
    code = m.group(1)
    parts = source_rows.get(code)
    if parts is None:
        raise RuntimeError(f"missing source record for {code}")
    source, title, origin, upstream, disposition, state = parts[:6]
    main.append((code, title, origin, state, landing(disposition, state)))
assert len(main) == 47, f"expected 47 main OPEN, found {len(main)}"

rt = []
for line in section(STEAL, "8. Repo-take steal wave").splitlines():
    if not re.match(r"^\| \d+ \|", line):
        continue
    parts = cells(line)
    n = int(parts[0])
    if n > 16:
        continue
    rt.append(("RT-" + str(n), parts[1], parts[-1], landing(parts[3], parts[-1])))
assert len(rt) == 16, f"expected 16 RT partials, found {len(rt)}"

upstream = []
for label, heading in [
    ("OpenCode", "5.1 opencode"), ("Cline", "5.2 cline"),
    ("Codex", "5.3 codex"), ("oh-my-pi", "5.4 oh-my-pi"),
    ("Grok Build", "5.5 grok-build"), ("Claude Code", "5.6 Claude Code"),
    ("DeepSeek", "5.7 DeepSeek harness"),
]:
    block = section(STEAL, heading, "### ")
    counter = 0
    for line in block.splitlines():
        if not line.startswith("|"):
            continue
        parts = cells(line)
        if len(parts) < 5:
            continue
        state = parts[-1]
        if not state.startswith("**partial"):
            continue
        counter += 1
        upstream.append((f"{label}-{counter}", label, parts[0], state, landing(*parts[1:-1], state)))
assert len(upstream) == 44, f"expected 44 upstream partials, found {len(upstream)}"

pack = []
for header, prefix in [("K. little-coder TAKE", "LC"), ("L. aider TAKE", "Aider")]:
    n = 0
    for line in section(FULL, header).splitlines():
        if line.startswith("- [ ] "):
            n += 1
            pack.append((f"{prefix}-{n}", line[6:]))
assert len(pack) == 15, f"expected 10 LC + 5 Aider, found {len(pack)}"

lines = [
    "# HorizonCode backlog traceability matrix (2026-11-13)",
    "",
    "> GENERATED by `ops/generate-backlog-traceability.py`. Re-run after status changes.",
    "> This document records **links and declared test evidence**, not a claim of tested",
    "> completion. Only code plus a named successful test proves a behavior. The primary",
    "> source of truth remains `FULL-BACKLOG-2026-11-13.md` and `docs/28` rulings.",
    "> Overlapping upstream and RT entries are NOT additive to the 47 main requirements.",
    "",
    "## P0 and Wave 0 gates",
    "",
    "| ID | Completion proof required | Current evidence | State |",
    "|---|---|---|---|",
    "| P0-1 | All mutations kernel-owned or refused, complete edit/patch parity | `kernel/src/effect_host.rs`, `app/src/core/kernel.ts`, `app/src/core/effect-kernel-mutation-route.ts`, `app/tests/core/effect-owner-kernel.test.ts`; 349 refusal/transport fail-close, multi-op safe refusal, NOT universal owner | PARTIAL |",
    "| P0-2 | Independent observation, replay, postimage and receipt settlement all effects | `kernel/src/effect_owner.rs`, `kernel/src/effect_host.rs`; 349 independent preimage SHA-256 before prepare/primitive; historic replay/other classes OPEN | PARTIAL |",
    "| P0-3 | Rust OwnerLog + atomic cross-process admission + durable mandatory R170 latch | `kernel/src/effect_owner.rs`, `kernel/tests/integration.rs`, `app/tests/core/effect-owner-kernel.test.ts`; 349 v2 prepare-only safe recovery + Bun guard preflight, other entrypoints OPEN | PARTIAL |",
    "| P0-4 | Product default routed netns/proxy, real socket bypass denial tests | `kernel/src/egress.rs`, `ops/usernetns-direct-tcp-denial-smoke.sh` (disposable user+net namespace only, NOT product), `ops/netns-spawn-routed-veth-probe.sh` | PARTIAL; PRODUCT UNPROVEN |",
    "| R172 | Nested streams, verification chain, RC-7 terminal and entrypoint parity | `app/src/core/effect-reconcile-attach.ts` | PARTIAL |",
    "| RC-18 | 44 expected canonical event kinds emitted and validated | `app/src/core/event-catalogue.ts` (23/44 recorded) | PARTIAL |",
    "| Patch parity | All strict-mode cross-file/ambiguous/fuzzy projection decisions | `app/src/core/effect-kernel-tool-projection.ts`, `app/src/core/effect-kernel-mutation-route.ts`; 349 multi-op EARLY REFUSAL, atomic kernel fs.batch OPEN | PARTIAL |",
    "| Cross-process consistency | Atomic owner/fencing and replay after crashes | `kernel/src/effect_owner.rs` 348 flock + 349 v2 pre-execution release, `app/src/core/kernel.ts` guard preflight (NOT atomic), `app/src/core/effect-reconcile-attach.ts`; universal replay/UNKNOWN resolution OPEN | PARTIAL |",
    "",
    "## 47 open primary adoption requirements",
    "",
    "| ID | Mechanism | Original source | Implementation anchor | Evidence in register |",
    "|---|---|---|---|---|",
]
for code, title, origin, state, codefiles in main:
    lines.append(markdown_row(code, title, origin, codefiles, status_claim(state)))
lines += ["", "## 16 partial repo-take entries",
          "", "| ID | Mechanism | Landing area | Evidence in register |",
          "|---|---|---|---|"]
for code, title, state, ptr in rt:
    lines.append(markdown_row(code, title, ptr, status_claim(state)))
lines += ["", "## 44 source-specific upstream partials",
          "", "| ID | Upstream | Mechanism | Implementation anchor | Evidence in register |",
          "|---|---|---|---|---|"]
for code, upstream_name, title, state, codefiles in upstream:
    lines.append(markdown_row(code, upstream_name, title, codefiles, status_claim(state)))
lines += ["", "## 15 unchecked TAKE-pack entries",
          "", "| ID | Unfinished candidate |",
          "|---|---|"]
for code, title in pack:
    lines.append(markdown_row(code, title))
lines += [
    "",
    "## Coverage/verification rules",
    "",
    "- The table's TESTED label is inherited from the source's status text. It is **not** an independently rerun test.",
    "- A source-mapped file merely exists; it is not proof that the whole row is implemented.",
    "- For actual P0 evidence inspect `docs/28-implementation-status.md` §3, `docs/GOAL-PROGRESS.md`, and the CI logs.",
    "- Every completed requirement must be backed by a direct behavior test, a verified receipt/denial or E2E scenario, and a status change.",
    "- The deferred full KDL resolver, unrestricted bypass, speculation and root LICENSE remain outside the active queue.",
    "",
    f"**Cross-reference totals:** {len(main)} primary OPEN, {len(rt)} repo-take partials, "
    f"{len(upstream)} source-specific partials, {len(pack)} unchecked TAKE-pack lines.",
    "",
]
OUT.write_text("\n".join(lines), encoding="utf-8")
print(f"{OUT.name}: {len(lines)} lines; {len(main)} primary, {len(rt)} RT, {len(upstream)} upstream, {len(pack)} pack")
