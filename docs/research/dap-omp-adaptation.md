# DAP: oh-my-pi reference and HorizonCode adaptation plan

**Upstream pin:** [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) @ `21f1188cf88b2f534c092181968cd5a4d1a9c296` (`research/upstream-pins.md`).

**What OMP ships (MIT, TypeScript):**

| File | Role |
|------|------|
| `packages/coding-agent/src/dap/client.ts` (~32k) | Spawn (stdio / unix socket / TCP), framing, requests, **events**, reverse requests, dispose |
| `packages/coding-agent/src/dap/session.ts` (~63k) | Launch/attach sessions, breakpoints, step/continue, output capture, idle cleanup |
| `packages/coding-agent/src/dap/config.ts` | Resolve adapter from config + `defaults.json` |
| `packages/coding-agent/src/dap/types.ts` | DAP message/capability types |

HorizonCode **must not** claim parity with a few `send()` helpers. A real debugger path needs at least OMP **client event dispatch** + **session** state machine before `launch`/`step` tool ops.

## What HorizonCode has today (honest)

- `app/src/core/dap/client.ts`: Content-Length framing, **`sendRequest`**, **`onEvent` / `waitForEvent`**, split `initialize` / `configurationDone` / `ready()`, stack/variables/setBreakpoints.
- `app/src/core/dap/session.ts`: **OMP launch/attach ordering** + **`stepSession`** (`continue` / `next` / `stepIn` / `stepOut`: subscribe `stopped` before command).
- `app/src/core/dap/config.ts` + `defaults.json`: catalogue, `.hz/dap.json` merge, PATH resolve, extension auto-pick (stdio).
- `app/src/tools/debug.ts`: Spawns user-supplied or named/`adapter`/auto-picked adapter; stack / variables / launch / attach / close / step ops (deferred). Live registry reuses adapter across calls.
- `app/src/core/dap/registry.ts`: One live adapter per chat session; `close` disposes.
- `app/tests/fixtures/fake-dap-server.ts`: Holds launch/attach until configurationDone; emits `stopped` after step/continue.

## Adaptation order (steal mechanisms, not the 63k monolith in one PR)

1. ~~**Client events**~~ — done.
2. ~~**Session launch sequencing**~~ — done.
3. ~~**Session step/continue**~~ — done (`stepSession` + tool ops; ruling **135**).
4. ~~**Attach sequencing**~~ — done (`attachSession` + tool op; ruling **137**).
5. ~~**Persistent sessions**~~ — done (registry + `close`; ruling **138**).
6. ~~**Config + adapters (stdio)**~~ — done (`defaults.json` + `config.ts` + `adapter` / auto-pick; ruling **139**).
7. ~~**Idle sweep + TCP/socket transport**~~ — done (`registry` idle TTL; `transport.ts` listen-parse + connect; debug tool wire; ruling **145**). Live e2e vs real dlv/js-debug still open.

## What not to copy

- Bun-only `ptree.spawn`, socket-mode spawn matrix — reimplement on `spawnOwned` + hzcode guard.
- Full breakpoint kinds (data/instruction) until a real adapter demands them.

**Evidence in repo:** `docs/research/steal-ohmypi-codex.md` §1.10; `docs/33-handoff.md` §5.1.
