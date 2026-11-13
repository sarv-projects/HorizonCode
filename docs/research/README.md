# Research notes (imported)

> **Agents:** [`../FULL-BACKLOG-2026-11-13.md`](../FULL-BACKLOG-2026-11-13.md) · **`repo_take/`** [`upstream-pins.md`](upstream-pins.md) · steal matrix [`steal-little-coder-aider.md`](steal-little-coder-aider.md).

These research reports produced `docs/30-steal-list.md`, the provider, hook, edit-engine, LSP, TUI and safety work, and the product README plan. They were written by earlier research passes as read-only deep dives of upstream agent repositories. They are kept here verbatim in substance so a new engineer or coding agent can see the evidence behind each design decision.

## How to read the links

- Every path inside an upstream repo that could be verified is now a link to the exact file at the pinned commit (full 40 character SHA). Pins, URL patterns and the list of repos that could not be verified are in [upstream-pins.md](upstream-pins.md).
- A backticked path that is NOT a link falls into one of three groups: a HorizonCode path (for example `app/src/core/loop.ts`), a path relative to a package directory that matched more than one file or none in the clone (treat as `path not verified` and search the upstream repo), or a path in a repository that is not cloned.
- Local absolute paths and the name of the original private clone directory were removed. Clone names such as `opencode` or `cline` map to the table in [upstream-pins.md](upstream-pins.md).
- Line numbers quoted in the notes refer to the upstream clone at the pin, and to HorizonCode at the commit named in each note. HorizonCode has moved since; re-check before relying on a HorizonCode line number.
- Em dashes in the originals were replaced with hyphens.
- A secret scan (`nvapi-`, `sk-`, `ghp_`, `AKIA`, bearer tokens, key assignments) found no credentials in these files.

## Files

| File | What it is |
|---|---|
| [horizoncode-baseline.md](horizoncode-baseline.md) | A faithful summary of HorizonCode's own documentation corpus as it stood before the steal waves: what the system is, a per-document summary, the status ladder (DESIGNED to RELEASED), the full contents of the first steal list, all consolidated weaknesses and open items, and the rules of engagement any change must obey. Use it to understand what HorizonCode already claimed before reading the comparisons. It cites HorizonCode docs only, not upstream repos. |
| [steal-opencode-cline.md](steal-opencode-cline.md) | Wave 1 report on opencode and cline. Part A covers opencode (find-and-replace edit tool, provider handling, the silent mock fallback weakness in `makeProvider`), Part B covers cline (hooks, safety trackers, command guard, apply_patch), and Part C is a consolidated action queue of about 20 numbered changes mapped to HorizonCode files, each tagged as new or as extending an existing feature number. |
| [steal-ohmypi-codex.md](steal-ohmypi-codex.md) | Wave 1 report on codex (`codex-rs/`) and oh-my-pi (`packages/`, `crates/pi-*`). Records the compaction prompts, apply_patch seek-sequence, guardian approval, LSP integration and edit ladder thresholds, maps them to HorizonCode changes, and has a "what NOT to copy" section and an evidence path appendix. |
| [steal-grok-claude-deepseek.md](steal-grok-claude-deepseek.md) | Wave 1 report on the DeepSeek harness (`dsh`, "Everything is a Plugin"), grok-build (network egress, edit anchoring, multi-dialect tools) and Claude Code (extensibility, permissions, lifecycle hooks). Section 0 documents how each source was located and what part of it exists; section 4 is the mapped steal list; section 5 lists cross-source convergence as the highest confidence signals. |
| [compare-cline-claude.md](compare-cline-claude.md) | Strict follow-up comparison of cline and Claude Code against HorizonCode. Covers the cline package architecture, the hook taxonomy, safety trackers, command guard, apply_patch fuzz ladder, line endings helper and model to tool routing, and the Claude Code hook, permission and plugin surface. Ends with a superset absorption plan. Provider and catalog surface is deliberately left to compare-providers. |
| [compare-codex-grok.md](compare-codex-grok.md) | Strict follow-up comparison of codex and grok-build against HorizonCode. Section 0 pins revisions, sections 1 and 2 are exhaustive per-subsystem architecture findings for each repo, section 3 is the strict matrix, section 4 maps absorption to HorizonCode files (unicode fold rung for the edit ladder, sandbox and approval policy, rollout), and section 5 cross-checks against earlier reports. |
| [compare-ohmypi-deepseek.md](compare-ohmypi-deepseek.md) | Strict follow-up comparison of oh-my-pi and the DeepSeek harness against HorizonCode. Each capability is classified COMMON, UNIQUE or already present. Includes the executive verdict, the edit ladder sharpening with named thresholds, the LSP writethrough design, the hook and plugin model, and corrections to the earlier reports. |
| [compare-providers.md](compare-providers.md) | The implementation spec for the provider superset: opencode's provider lifecycle, how many providers and models exist and the compat flag model, the oh-my-pi catalog and KDL compat rules, a capability comparison with HorizonCode, a concrete reuse plan (fail loud on unknown provider, one openai-compatible adapter, catalog snapshot and refresh, auth and OAuth shapes), and an exact path evidence index. models.dev is the shared catalog source. |
| [forgecode-deep.md](forgecode-deep.md) | Deep dive of forgecode (agents forge, sage and muse, doom loop hook, compaction, read-before-edit, provider transformers) classified against HorizonCode, plus a quality-practices section, a first look at the Grok Build TUI, an analysis of forgecode's README as a product README, a recommended HorizonCode README outline, and a list of things HorizonCode must not claim without verification on main. Includes the author's own measurements (startup time, selftest) with the method used. |
| [grok-tui-deep.md](grok-tui-deep.md) | Deep analysis of the Grok Build TUI (the pager crates under `crates/codegen/`): the two TUIs, architecture, layout, exact transcript cell formats, animation, theme, input, minimal mode and the PTY test harness, followed by the HorizonCode TUI Part 2 specification derived from it. This is the main source for the TUI work tracked in `docs/13-tui.md` (see its provenance sections). |
| [steal-little-coder-aider.md](steal-little-coder-aider.md) | 2026-11-13 deep dive of [little-coder](https://github.com/itayinbarr/little-coder) (local/small-model scaffold policies on pi) plus an aider git-tools recheck against the verified `repo_take/aider` clone. Disposition matrices: TAKE / ALREADY / SKIP / DEFER. Pins in [upstream-pins.md](upstream-pins.md). |

## Where the findings landed

- `docs/30-steal-list.md` is the ranked list that these notes feed.
- `docs/13-tui.md` carries the TUI provenance. `docs/28-implementation-status.md` carries the status of each stolen item (the status ladder lives only there).
- Items intentionally postponed are marked deferred in the destination doc; a pointer to each deferral will be collected in the handoff docs (see the task state for the docs-handoff work).
