# 32. Plan files (`.hz/plans/`)

A plan file is a markdown document that records a design before work starts and
tracks progress while it runs. It is a convention, not a feature: nothing in the
runtime reads it except the built-in `execute-plan` skill, and every write to it
goes through the same guard as any other file write.

## Layout

```
.hz/plans/<yyyy-mm-dd>-<slug>-v<N>.md
```

`<slug>` is a short kebab-case name; `N` starts at 1 and goes up when a plan is
revised, so the older versions stay as a design history. Commit the folder if the
history is worth keeping, or ignore it if not.

## Shape

```markdown
# <title>

Goal: one or two sentences.

## Tasks
- [ ] first concrete, checkable step
- [ ] second step

## Verification
- command or observation that proves the goal is met
```

Tasks are `- [ ]` (open) or `- [x]` (done). Verification criteria are things the
executor can run or observe; a criterion that cannot be checked is not one.

## Writing a plan

Switch to `/mode plan` (or `/plan on`) and ask for a plan. In plan mode writes
are staged, so the plan file appears under `/changes` and lands with `/apply`,
like any other staged write. No special path is granted.

## Running a plan

`/execute-plan [file]` activates the built-in skill. It reads the plan (the newest
file in `.hz/plans/` when none is named), does the first open task, ticks it, and
repeats, then runs the verification list and reports. Each action is an ordinary
tool call with the ordinary guard decision and receipt. A user or workspace skill
named `execute-plan` replaces the built-in one.

The built-in skill is not listed in the system prompt (the prompt budget is
fixed); type `/execute-plan` to use it.
