I have completed my reconnaissance. Here is the comprehensive report.

---

# Deep Code-Organization Tour — `grok-build` (`xai-org/grok-build`)

Repository: `/data/home/forge/repo-tour/grok-build` · commit `2bdd1d6` ("Synced from monorepo") · `SOURCE_REV` `559751fdcec02d413e4c57c8832ab275e4f44980` · primary language Rust (edition 2024, toolchain 1.94.0).

---

## 1. Identity

**Grok Build** (`grok`) is SpaceXAI's terminal-based AI coding agent. From `file:///data/home/forge/repo-tour/grok-build/README.md#L13-L17`:

```markdown
**Grok Build** is SpaceXAI's terminal-based AI coding agent. It runs as a
full-screen TUI that understands your codebase, edits files, executes shell
commands, searches the web, and manages long-running tasks — interactively,
headlessly for scripting/CI, or embedded in editors via the Agent Client
Protocol (ACP).
```

Key identity facts:

- **Binary artifact** is `xai-grok-pager`; shipped as `grok` in official installs (`file:///data/home/forge/repo-tour/grok-build/README.md#L81-L83`).
- Built by the **composition-root package** `crates/codegen/xai-grok-pager-bin` (`README.md#L99`).
- **Read-only workspace root**: `Cargo.toml` is generated — `# Auto-generated workspace root. Prefer editing per-crate Cargo.toml files.` (`file:///data/home/forge/repo-tour/grok-build/Cargo.toml#L1`).
- **External contributions are not accepted** — `CONTRIBUTING.md:3-L4`. Published for source transparency under Apache-2.0.
- The repo is synced periodically from the SpaceXAI monorepo (`README.md#L31-L35`).
- **Workspace size**: 107 workspace members; `crates/codegen` holds **89** crates, `crates/common` **12**, plus `crates/build`, `prod/mc`, and 4 vendored `third_party` crates.

Notable root-config policies (`file:///data/home/forge/repo-tour/grok-build/clippy.toml#L40-L54`) ban raw `reqwest::Client::new`, `std::fs::canonicalize`, `dirs::home_dir`, and raw process spawning — enforcing a central TLS policy, `dunce` canonicalization, `xai_dirs` home resolution, and `ProcessScope::enroll` child lifecycle.

---

## 2. Top-level map

```
/data/home/forge/repo-tour/grok-build
├── Cargo.toml            # generated workspace (107 members, deps, lints, profiles)
├── Cargo.lock             # 364 KB
├── clippy.toml            # disallowed-methods policy (nearest-file, duplicates root)
├── rustfmt.toml           # use_field_init_shorthand = true
├── rust-toolchain.toml    # channel 1.94.0
├── SOURCE_REV             # monorepo commit SHA
├── SECURITY.md            # HackerOne
├── CONTRIBUTING.md        # external PRs not accepted
├── LICENSE / THIRD-PARTY-NOTICES
├── .cargo/config.toml     # per-target rustflags (RELRO/NX on musl, jemalloc page size)
├── .gitignore             # /target, *.rs.bk, .DS_Store
├── bin/protoc             # DotSlash-shebang hermetic protoc v29.3 pin
├── crates/
│   ├── build/xai-proto-build
│   ├── codegen/           # 89 crates — the CLI closure
│   └── common/            # 12 crates — shared leaf crates (Computer Hub, compaction, tracing…)
├── prod/mc/cli-chat-proxy-types
└── third_party/           # vendored: mermaid-to-svg, dagre_rust, graphlib_rust, ordered_hashmap
```

### `bin/`
Only one file, `bin/protoc`, a DotSlash descriptor (`file:///data/home/forge/repo-tour/grok-build/bin/protoc#L1-L6`):

```
#!/usr/bin/env dotslash
{
    "name": "protoc",
    ...
```

It pins protoc 29.3 per-platform by sha256; `xai-grok-tools-api/build.rs` and `xai-proto-build` resolve it.

### `prod/`
`prod/mc/cli-chat-proxy-types` — a small shared crate (`crates/common`/`prod` leafs pulled in by the closure). Consumed by `xai-grok-shell` as `prod-mc-cli-chat-proxy-types` (`file:///data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-shell/Cargo.toml#L179`).

### `third_party/`
Vendored **upstream source** for the Mermaid diagram stack — the "grove-on-NFS" userspace server and FUSE client. From `file:///data/home/forge/repo-tour/grok-build/third_party/README.md#L14-L22`:

```markdown
This directory holds in-tree third-party Rust (and similar) sources: the
mermaid layout stack that renders **untrusted model output**, ...
| [`mermaid-to-svg`](./mermaid-to-svg/) | (path) | MIT |
| [`dagre_rust`](./dagre_rust/) | 0.0.5 | Apache-2.0 |
| [`graphlib_rust`](./graphlib_rust/) | 0.0.2 | Apache-2.0 |
| [`ordered_hashmap`](./ordered_hashmap/) | 0.0.3 | Apache-2.0 |
```

The dependency chain is documented as `xai-grok-mermaid → mermaid-to-svg → dagre_rust → graphlib_rust → ordered_hashmap`.

---

## 3. Crate graph + responsibilities

The workspace is a layered closure. Below is a function-oriented map of the major crates (all under `crates/codegen` unless noted).

### 3.1 Top of the dependency stack (composition + shells)

| Crate | Responsibility | Description / evidence |
|---|---|---|
| `xai-grok-pager-bin` | **Composition root** — builds `xai-grok-pager`. Has `build.rs` stamping `VERSION_WITH_COMMIT`. | `README.md#L99` |
| `xai-grok-pager` | The **TUI**: scrollback, prompt, modals, rendering, event loop, slash commands, settings, headless entry. | `README.md#L100` |
| `xai-grok-pager-render` | Presentation-primitives layer (theme, appearance, terminal, input, syntax, modal window). | `pager-render/src/lib.rs` |
| `xai-grok-pager-minimal` | Scrollback-native ("minimal") screen mode implementation. | `pager-minimal/src/lib.rs` |
| `xai-grok-pager-diff` | Diff-hunk construction for the TUI. | lib desc |
| `xai-grok-pager-pty-harness` | Shared PTY harness + scenario library for e2e tests/benches. | lib desc |
| `xai-grok-shell` | **Agent runtime** + leader/stdio/headless entry points. | `README.md#L101` |
| `xai
