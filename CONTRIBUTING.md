# Contributing to HorizonCode

## Prerequisites

- **Rust** (stable toolchain with `cargo`) for `kernel/`
- **Bun** for `app/`

## Zero Runtime Dependencies

`app/package.json` intentionally has **no `dependencies`**. Only `devDependencies` (`@types/bun`, `@types/node`, `typescript`) are installed for typechecking. Do not introduce third-party runtime packages without explicit architectural approval.

## Local Build & Test Workflow

1. **Install dev type definitions**:
   ```bash
   cd app && bun install --frozen-lockfile
   ```
2. **Rust kernel tests & release binary**:
   ```bash
   cd kernel && cargo test --locked && cargo build --release --locked
   ```
3. **Typecheck & TypeScript tests**:
   ```bash
   cd app && bun run typecheck && bun test --timeout 30000
   ```
4. **Full CI gate runner** (runs Rust tests, kernel selftest, typecheck, TS suite, e2e mock smokes, startup latency, and doc consistency checks):
   ```bash
   bash ops/gates.sh
   ```

## Launchers & Trust Boundary

- Use `./bin/hzcode` (POSIX), `bin\hzcode.cmd` (Windows CMD), or `bin\hzcode.ps1` (PowerShell) when testing CLI flows. All launchers pass `--no-env-file` so Bun never auto-loads a workspace `.env`.

## Commit & PR Hygiene

- Keep changes focused and small, with regression tests covering any bug fix or new CLI flag.
- Run `bash ops/gates.sh` (or the relevant Rust + Bun checks on Windows) before opening a PR.
- Keep `ops/ci/github-actions.yml` and `.github/workflows/ci.yml` in sync when updating CI workflows.
- Do not commit secrets, API keys, or local `.hz/` state files.
