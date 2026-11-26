# Security Policy

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Instead, report suspected vulnerabilities privately using **GitHub Security Advisories** (the repository's Security tab -> "Report a vulnerability"). If private advisories are unavailable on a fork or mirror, contact the repository maintainers directly with:

- A clear description of the issue and affected component (`kernel/`, `app/`, `bin/`, or `ops/`).
- Minimal reproduction steps or a proof of concept.
- The impact on the trust boundary (for example: workspace escape, policy bypass, credential leakage, or receipt tampering).

We aim to acknowledge reports promptly and coordinate a fix before public disclosure.

## Trust Model Summary

HorizonCode separates untrusted workspace content from user-owned trust-boundary controls:

- **No workspace `.env` auto-loading**: The launchers (`bin/hzcode`, `bin/hzcode.cmd`, `bin/hzcode.ps1`) and `--worktree` re-exec invoke Bun with `--no-env-file`. Only explicit process environment variables and the user-owned, `0600` `<user config dir>/env` file outside the workspace are read.
- **Rust kernel guard & receipts**: Side-effecting tools are mediated by the `hz-kernel` guard and recorded in hash-chained event and receipt logs.
- **Fail-closed fallback**: If the Rust kernel binary is missing or fails pin verification, HorizonCode defaults to read-only mode unless the user explicitly passes `--allow-untrusted`.
- **Honest scope**: `--worktree` isolates git working trees, not OS processes. HorizonCode does not claim full OS-level sandboxing across all platforms; check `hzcode doctor` for the active environment's enforcement status.
