# Provider Superset - strict comparison: opencode + oh-my-pi vs HorizonCode

Phase 1 research report. Read-only. No repo was modified. This document is the implementation spec for HorizonCode's provider superset work.

Clones read (all in a local `externals/` clone directory; upstream URLs and pins are in [upstream-pins.md](upstream-pins.md); latest at the time):
- `opencode` (sst/opencode) - PRIMARY TARGET. Provider lifecycle read end to end.
- `oh-my-pi` (can1357/oh-my-pi) - catalog + provider abstraction.

HorizonCode read:
- Code: `app/src/core/providers/{index,openai,anthropic,google,ollama,mock,retry,sse,scripted}.ts`, `app/src/core/config.ts`, `app/src/contracts.ts`.
- Docs: `docs/07-apis-and-contracts.md`, `docs/15-extensibility.md`, `docs/28-implementation-status.md`.

Convention note: `app/src/contracts.ts` is LAW. Every proposed schema change in §5 names `contracts.ts` as the owner and is a design decision, not a silent edit.

---

## 0. Executive summary (the five portable wins)

1. **Fail loud on unknown provider.** `app/src/core/providers/index.ts` `makeProvider()` `default:` branch silently returns `createMockProvider()`. A typo in `HZ_PROVIDER` or a provider the catalog knows but the switch does not yields a fake chat with no error. opencode's whole design treats an unknown provider/model as not-found, never as a silent fallback. Fix: the `default:` branch must emit an error-provider (like the existing `missingKeyProvider`), not the mock.
2. **One `openai-compatible` adapter unlocks ~80% of providers.** Both opencode ([`packages/ai/src/providers/openai-compatible.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/openai-compatible.ts), [`protocols/openai-compatible-chat.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/protocols/openai-compatible-chat.ts)) and oh-my-pi ([`packages/catalog/src/provider-models/openai-compat.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/provider-models/openai-compat.ts)) route the large majority of providers through a single OpenAI-chat-shaped adapter parameterised by `baseURL` + auth. HorizonCode already has a working OpenAI chat-completions client (`openai.ts`); generalising it to accept an arbitrary `baseURL` + provider id is the single highest-leverage change.
3. **Rely on models.dev for the catalog.** opencode bundles a committed `models.dev` snapshot ([`packages/core/src/models-dev/snapshot.txt`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev/snapshot.txt), 8.2 MB) of **230 providers / 8787 models**, validated at build with a `MINIMUM_PROVIDERS = 100` floor, fetched/pinned/refreshed by [`packages/core/src/models-dev.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev.ts) + [`packages/core/script/models-snapshot.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/script/models-snapshot.ts). HorizonCode's catalog today is `DEFAULT_MODELS` - five hardcoded strings in `config.ts`. models.dev is the catalog the user wants to depend on.
4. **API-key OR OAuth, uniformly.** opencode's [`packages/ai/src/route/auth.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/route/auth.ts) models a credential as an `Auth.Definition` with `bearer()` / `header()` / `scheme()` renderers and `orElse` fallbacks; OAuth providers (ChatGPT, GitHub Copilot, etc.) register as `IntegrationOAuthMethodRegistration` in `packages/core/src/plugin/provider/*.ts`. The same provider accepts an API key path and an OAuth path interchangeably. HorizonCode has only `apiKey: string`.
5. **User provider registry.** Both tools let a user declare a provider by id + baseURL + options without shipping code. HorizonCode docs already describe `ProviderContributionV1` as "endpoint + codec id, never code" (`docs/15-extensibility.md` §3.1, §5 precedence table line 561) but the runtime has a closed 5-entry `switch`. The registry concept is designed but not built.

---

## 1. opencode provider lifecycle (exhaustive)

opencode splits the provider stack across two packages: **`packages/ai`** (pure model-call machinery: providers, protocols, routes, auth, schema - no Session dependency, per [`packages/ai/AGENTS.md`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/AGENTS.md)) and **`packages/core`** (catalog, OAuth, orchestration, plugins). Dependency direction is Schema → Core/Protocol → Server (`AGENTS.md`).

### 1.1 Layering (bottom to top)

```
schema/ids.ts            ProviderID, ModelID (branded strings), ProtocolID, RouteID
   │
schema/options.ts        ProviderOptions, HttpOptions, TimeoutConfig, RequestEncoding, ProviderMetadata
   │
route/auth.ts            Auth.Credential / Auth.Definition (bearer/header/scheme/none/orElse)
route/auth-options.ts    AuthOptions.apiKey / .bearer  (env-var fallback, apiKey:false => no auth)
route/client.ts          Route.make({id,provider,protocol,endpoint,framing}) ; Route.with(...)
route/endpoint.ts        Endpoint.path("/chat/completions",{baseURL})
   │
protocols/*.ts           ~50 wire-format adapters (openai-chat, openai-responses,
                         anthropic-messages, gemini, bedrock-converse, ...)
   │
providers/*.ts           per-vendor facades: compose protocols via Route, add typed options,
                         api-key sugar, env fallback, default normalization
   │
providers/index.ts       barrel: export * as Anthropic, OpenAI, OpenAICompatible, ... (46 namespaces)
```

Key principle from [`packages/ai/AGENTS.md`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/AGENTS.md): **"Reuse protocols. Providers compose existing protocols with `Route.make(...)` instead of cloning them."** A per-vendor file is thin; the wire logic lives once in a protocol.

### 1.2 The registry: per-vendor facades + a barrel

[`packages/ai/src/providers/index.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/index.ts) is a static barrel exporting **46 provider namespaces** (`export * as Anthropic from "./anthropic.js"`, etc.). This is the compile-time set of *protocol implementations* opencode ships. It is NOT the user-facing provider list - that comes from the catalog (§1.4), which maps each catalog provider to one of these packages by name.

Each facade exports a uniform shape. From `providers/openai.ts`:
- `export const id = ProviderID.make("openai")`
- `export const routes = [OpenAIResponses.route, OpenAIChat.route]`
- `export const configure = (input: Config = {}) => ({ id, model, responses, chat, image, speech, transcription, decision, configure })`
- `export const model: ProviderPackage.Model<Settings, OpenAIProviderOptionsInput, ...>` - the entry the catalog loader calls
- `Config` / `Settings` types: `Config` is route-level (`baseURL`, `queryParams`, `providerOptions`, `ProviderAuthOption<"optional">`); `Settings` is the flat user-facing form (`apiKey`, `baseURL`, `organization`, `project`, ...).

`settings.ts` `toConfig()` splits flat `Settings` into connection config (`apiKey`, `baseURL`, `headers`, `body`) vs provider options (everything else). `bearerRouteDefaults()` turns settings into route options with `Authorization: Bearer` auth and a `baseURL` fallback.

Minimal facade - [`providers/baseten.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/baseten.ts) (the briefing's named example): fixed `baseURL = "https://inference.baseten.co/v1"`, one `Route.make({ id:"baseten-chat", protocol: OpenAIChat.protocol, endpoint: Endpoint.path("/chat/completions",{baseURL}), framing: OpenAIChat.framing })`, auth via `bearerRouteDefaults(input, "BASETEN_API_KEY", baseURL)`. It reuses `OpenAIChat` wholesale and only adds a bespoke `decision` route. This is the template the catalog follows for OpenAI-shaped hosts.

### 1.3 The openai-compatible adapter (the force multiplier)

[`providers/openai-compatible.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/openai-compatible.ts):
- `id = ProviderID.make("openai-compatible")`
- `Config` requires `baseURL: string`, optional `provider?: string` (the real host id), `ProviderAuthOption<"optional">`.
- `configure(input)`: `provider = input.provider ?? "openai-compatible"`; `auth = AuthOptions.bearer(input, [])` (no env var - the key is explicit); `route = OpenAICompatibleChat.route.with({ provider, endpoint:{baseURL}, auth })`. Returns `{ id: ProviderID.make(provider), model, image, configure }`.
- The returned provider id is the *configured provider name*, not the literal `"openai-compatible"` - so saved state and request metadata carry the real host id.

The wire logic is [`protocols/openai-compatible-chat.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/protocols/openai-compatible-chat.ts) (a sibling of `openai-chat.ts`). This is how 200+ catalog hosts that speak OpenAI chat-completions are served by one code path.

Also present: `anthropic-compatible.ts` (same idea for Anthropic-messages hosts), `openai-compatible-responses.ts` (OpenAI Responses-API-shaped hosts).

### 1.4 The catalog: models.dev fetch + pin + validate

**Source module:** [`packages/core/src/models-dev.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev.ts) (the `ModelsDev` service) + [`packages/core/src/models-dev/v1.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev/v1.ts) (v1→v2 converter) + committed snapshot [`packages/core/src/models-dev/snapshot.txt`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev/snapshot.txt).

**Bundled snapshot:** 8.2 MB text, imported as a module constant:
```ts
import snapshotText from "./models-dev/snapshot.txt" with { type: "text" }
```
Counted directly from the committed file: **230 providers, 8787 models.**

**catalogPath** (the v2 experimental API, restricted to the types opencode keeps):
```ts
const TYPES = ["chat", "decision", "image"]
export const catalogPath = `/experimental/v2.0/api.json?type=${TYPES.join(",")}`
```
Default source `https://models.opencode.ai` (an opencode-hosted mirror of models.dev), overridable with `OPENCODE_MODELS_URL`.

**Fetch / pin / validate pipeline** ([`packages/core/script/models-snapshot.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/script/models-snapshot.ts)):
- `fetchModelsSnapshot()` GETs `${source}${catalogPath}` (30 s timeout), trims unused model fields (`UNUSED_MODEL_FIELDS`: description, canonical_id, knowledge, last_updated, deprecation_date, open_weights, metadata) to shrink the bundle, then `validateModelsSnapshot()`.
- `validateModelsSnapshot()` decodes via `ModelsDev.decodeSnapshot(text)` and enforces `MINIMUM_PROVIDERS = 100` - *"A floor, not equality: guards against an error page or a truncated body that still parses as a small object."* If fewer than 100 providers it throws.
- `modelsSnapshotPlugin(text)` is a Bun build plugin that inlines the snapshot text into the bundle at build time.
- `bundledModelsSnapshot()` lets `OPENCODE_MODELS_SNAPSHOT` point at a file; otherwise reads the committed `snapshot.txt`.
- Refresh script: [`packages/core/script/update-models-snapshot.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/script/update-models-snapshot.ts) (rewrites the committed snapshot); parity scripts `snapshot-parity.ts` / `snapshot-parity-compare.ts` / `snapshot-parity-run.sh` verify the normalized catalog is stable across a refresh.

**Runtime service** (`models-dev.ts` `ModelsDev.Service` / `layer(options)`): a layered boot-time floor + periodic refresh.
- `populate`: file override → KV cache → **bundled snapshot (the boot-time floor)** → live fetch+write. Decoded+normalized once per isolate (`bundledCache`), because the multi-MB constant is expensive and one isolate can host many runtimes.
- `refresh(force?)`: 5-minute `Schedule.spaced` poll; uses `ETag` / `If-None-Match` and a body `digest` (sha256) to skip republishing a byte-identical catalog; publishes `ModelsDev.Event.Refreshed` on the bus only when the body actually changed. Cache key is versioned (`models-dev:v2:catalog`) so a v1-cached entry is never read as v2. KV write is best-effort (Durable Object SQLite caps values at 2 MB, and the catalog exceeded it in Aug 2026) - a failed cache write just refetches.

**Normalization** (`models-dev.ts` `normalize`): decodes each provider (`SourceProvider`) and model (`SourceModel`) independently with `Schema.decodeUnknownResult`; a model that fails to parse is pushed to `failed[]` and skipped (logged, never fatal) - this is the "tolerate unknowns" rule. Per model it computes a `route()` (which opencode package serves it) from the model's `api` map. It picks the provider's default package/baseURL as `mostCommon()` across its models. Produces `Snapshot = { info: Provider.Info, models: Model.Info[], environment: string[] }`.

**v1 → v2 bridge** ([`models-dev/v1.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev/v1.ts)): v1 catalogs (the old `/api.json`) name an AI SDK npm package per model; v2 providers never do. `isV1()` detects the npm field; `toV2()` converts cost tiers, reasoning options (effort/budget/toggle), modalities, and infers the protocol (`responses` vs `chat-completions`) from `RESPONSES_BY_DEFAULT = {@ai-sdk/openai, @ai-sdk/azure, @ai-sdk/xai}` and a `shape` hint.

**Catalog → package routing** (`models-dev.ts` `route()`): a chat model takes its first API entry whose `sdk.opencodeai` entrypoint is loadable (`Provider.builtinPackages`) or whose `sdk.aisdk` maps to a native opencode package via `AISDKNative.native(...)` / `Provider.aisdk(...)`. `BUILDS_OWN_URL` is the set of packages (bedrock, azure/*, cloudflare*, google-vertex/*, sap, watsonx) that construct their URL from settings, so the catalog's URL for them is ignored. `COMPATIBLE = {openai-compatible, anthropic-compatible}` packages get told the real provider id in `settings.provider`.

`catalog-smoke.ts` (named in the briefing): the smoke test that boots the catalog and asserts it populates.

### 1.5 Auth: API key AND OAuth

**Credential model** - [`packages/ai/src/route/auth.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/route/auth.ts):
- `Auth.Credential`: `{ load: Effect<Redacted>, orElse(that), bearer(), header(name), pipe }`. `load` resolves a redacted secret; `orElse` chains fallbacks.
- `Auth.Definition`: `{ apply(input): Effect<Headers>, andThen(that), orElse(that), pipe }`. A definition renders auth headers onto a request.
- Constructors: `Auth.value(secret)`, `Auth.optional(secret)`, `Auth.config(envName)` (reads an env/config var, fails `MissingCredentialError` if empty), `Auth.none` (no header), `Auth.headers(...)`, `Auth.remove(name)`, `Auth.custom(apply)`.
- Renderers: `bearer()` → `Authorization: Bearer <secret>`; `header(name)` → `name: <secret>`; `bearerHeader(name)` → `name: Bearer <secret>`; `scheme(name)` → `Authorization: <scheme> <secret>` (e.g. Deepgram's `Token`).

**API-key resolution** - [`packages/ai/src/route/auth-options.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/route/auth-options.ts):
- `ProviderAuthOption<"optional"|"required">` is a union: an `AuthOverride` (`{auth}`) OR an `{apiKey}` form. `apiKey: false` means "provider needs no key: no env lookup, no header."
- `AuthOptions.apiKey(options, envVar, apply)`: honor explicit `auth`; `apiKey:false` → `Auth.none`; else resolve `apiKey` (explicit option, then each env var via `Auth.config(name)` chained with `.orElse`) and render with `apply`.
- `AuthOptions.bearer(options, envVar)` = `apiKey(...)` rendered as `Authorization: Bearer`.
- This is the single uniform API-key path every provider facade uses (e.g. `openai.ts`: `AuthOptions.bearer(options, "OPENAI_API_KEY")`; `baseten.ts`: `bearerRouteDefaults(input,"BASETEN_API_KEY",baseURL)`).

**OAuth path** - `packages/core/src/plugin/provider/*.ts` (each OAuth provider is a `define(...)` plugin registering an `IntegrationOAuthMethodRegistration`):
- `chatgpt.ts` (read in full): PKCE (`generatePKCE` S256), dynamic client registration (`registrationClientID = "dynamic_agent_client"`, OpenAI returns the issued client id on callback), a local loopback `node:http` server on `127.0.0.1:0` for `/auth/callback`, `state`+`nonce` validation, `exchange()` (authorization_code) and `refresh()` (refresh_token) against `${issuer}/api/accounts/oauth/token`, `verifyIDToken()` via `jose` JWKS, and a `credential(tokens, clientID, scopes)` that mints a `Credential.OAuth`. It then uses plugin hooks - `ctx.provider.transform`, `ctx.model.transform`, `ctx.session.hook("model.request")` (injects `session-id`/`thread-id` headers), `ctx.session.hook("retry")` (non-retryable sharing codes) - to overlay the OAuth-backed provider onto the catalog provider at runtime.
- `refresh.ts` (`ProviderRefresh.onSwitch` / `reloadIfChanged`): reloads the provider when the active credential changes.
- Other OAuth/credential providers present: `github-copilot.ts`, `google-vertex.ts`, `amazon-bedrock.ts` (+ [`protocols/utils/bedrock-auth.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/protocols/utils/bedrock-auth.ts) SigV4), `azure.ts`, `databricks.ts`, `snowflake-cortex.ts`, `sap-ai-core.ts`, plus key-only dynamic hosts `ollama.ts`, `lmstudio.ts`, `vllm.ts`, `openrouter.ts`, `nvidia.ts`, `cerebras.ts`, `xai.ts`, `local.ts`, `modal.ts`, `neon.ts`, `kilo.ts`, `llmgateway.ts`, `poe.ts`, `zenmux.ts`, `cloudflare-*`, `digitalocean.ts`.
- `local.ts` (`createLocalProviderPlugin`) is the template for key-optional local servers that *discover* their models at runtime (Ollama uses it - see `ollama.ts`: GETs `/api/tags`, `POST /api/show`, filters to `capabilities includes "completion"`).
- `page.ts` (`packages/core/src/oauth/`): the HTML success/error pages served on the OAuth loopback callback.

**Keyless-auth test** (`keyless-auth.test.ts`, named in the briefing): asserts `apiKey:false` providers never attach an Authorization header.

### 1.6 Provider + model option schemas

- [`schema/ids.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/schema/ids.ts): `ProviderID`/`ModelID` are branded strings (`Schema.String.pipe(Schema.brand("AI.ProviderID"))`). `ProtocolID`/`RouteID` are plain strings.
- [`schema/options.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/schema/options.ts): `ProviderOptions = Record<string,Unknown>` (open pass-through), `ProviderMetadata = Record<string,Record<string,Unknown>>`, `HttpOptions` (`query`, deep-merged `body`, `encoding: "zstd"|"gzip"|"none"`), `TimeoutConfig` (`total`/`headers`/`chunk` in ms, `false` to disable), `DEFAULT_HTTP_TIMEOUT_MS=300_000`, `DEFAULT_CHUNK_TIMEOUT_MS=900_000` (DeepSeek can stream nothing for minutes while reasoning). `mergeProviderOptions` / `mergeJsonRecords` deep-merge option layers.
- Per-vendor option shapes (e.g. [`providers/openai-options.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/openai-options.ts), `open-responses-options.ts`) use `OpenString<"a"|"b">` = `Known | (string & {})` - the forward-compat pattern from [`packages/ai/AGENTS.md`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/AGENTS.md): accept unknown future enum values as pass-through strings; use closed literals only where opencode branches on the value.

### 1.7 Slash commands related to models/providers/auth

- Core prompt-command templates: `packages/core/src/plugin/command/*.txt` (`initialize.txt`, `review.txt`, `schedule.txt`) - prompt commands, not provider machinery.
- CLI command handlers: `packages/cli/src/commands/handlers/auth/` (`login.ts`, `account.ts`, `export.ts`, `form.ts`) and [`packages/cli/src/commands/handlers/models.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/commands/handlers/models.ts) - the `auth login` / `models` surfaces that drive the OAuth flows and list the catalog. [`packages/cli/src/commands/handlers/mcp/auth.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/commands/handlers/mcp/auth.ts) is the MCP-server auth variant.
- TUI model/provider pickers: [`packages/tui/src/component/dialog-model.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/component/dialog-model.tsx), `dialog-model-free.tsx`, `model-options.tsx`, `model-preference.ts`, [`util/model.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/util/model.ts) - the interactive model switcher backed by the catalog.
- Session/shell command palettes: `packages/app/src/session/commands/` and `packages/app/src/shell/commands/` (command palette, search).
- `packages/core/src/plugin/command/` registration is async and non-blocking (`AGENTS.md` "Plugin Loading": handlers never wait for plugins; a model/provider that has not loaded yet fails with not-found, by design).

---

## 2. How many providers / models, and the compat-flag model

| Metric | opencode (models.dev) | oh-my-pi (bundled catalog) |
|---|---|---|
| Providers | **230** (committed `snapshot.txt`) | **81** (`models.json` `providers[]`) |
| Models | **8787** (sum of `.models` per provider) | ~**8674** node pool entries (`nodes[]`); per-provider model lists index into it |
| Protocol-impl packages shipped in code | 46 ([`providers/index.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/index.ts) barrel) | ~90 model-manager factories (`descriptors.ts` `MODEL_MANAGER_FACTORIES`) + `openai-compat`/`special`/`google`/`ollama` families |
| Catalog source | models.dev v2 API, mirrored at models.opencode.ai, pinned to a committed snapshot | stencil.so + provider discovery + OpenCode docs, compiled into `models.json` |
| Catalog format | JSON, decoded per-field with Effect Schema, unknown fields/models skipped | compiled columnar: `keys`(411) + `booleanShapes`(343) + `nodes`(8674) + `compat`(12) + `providers`(81); models reference compat axes by integer index |
| Validation floor | `MINIMUM_PROVIDERS = 100` at build | compile-time KDL validation; `AmbiguousOverlapError` on equal-rank rule overlap |
| Where quirks live | per-field compatibility hints in the catalog (`reasoning_field`, `max_tokens_field`, `media_input`) + per-package overrides in code | **KDL rule tree** `compat/rules/**/*.kdl` compiled to `rules.json`, resolved by `resolveModelPolicy`/`classifyModel` |

The user's belief of "100s or more providers" is confirmed on the opencode side: **230 providers / 8787 models** in the pinned catalog. oh-my-pi is smaller (81 providers) but its node pool is comparably large.

**Compat-flag model - the central difference:**

- **opencode: data-driven, per-field, tolerant.** The catalog carries per-model `capabilities` (`tools.supported`, `reasoning` {supported/toggle/effort/budget}, `temperature`), `modalities`, `limit`, `cost`, and an `api.*.compatibility` block (`reasoning_field`, `max_tokens_field`, `media_input`). Unknown fields and unparseable models are skipped, never fatal ([`packages/ai/AGENTS.md`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/AGENTS.md): "Tolerate unknowns"). Options use `Known | (string & {})` so new enum values pass through. There is no model-name string matching in the hot path - behavior is read from the catalog record.

- **oh-my-pi: rules-engine, compiled, no string matching allowed.** [`packages/catalog/src/compat/axes.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/compat/axes.ts) defines a **closed axis vocabulary** (`AXES`): each KDL directive maps to a resolved camelCase field with a declared shape (`scalar`/`array`/`object`), axis set (`wire`/`thinking`/`catalog`), and - for wire axes - which `CompatRecordName` (`openai`, `openai-responses`, `anthropic`, `bedrock`, `devin`, `google`, `request`, `ollama`) it applies to. Policy is authored in `compat/rules/{taxonomy,classes,providers,runtime}/*.kdl`, compiled by `bun run gen:compat` into `rules.json`, and resolved at build via `classifyModel()` / `resolveModelPolicy()` / `buildModel()`. The repo's `AGENTS.md` forbids hard-coding model/provider policy in TS ("no `id.includes("claude")`, no model-name regexes, no per-model lookup tables"). Branching on identity is allowed only through structured facts (`class`/`family`/`revision`) from `classifyModel()`. This is stricter and more powerful than opencode's per-field hints, but much heavier to port.

For HorizonCode, **opencode's data-driven model is the right one to reuse** - it matches "rely on models.dev" directly, and it is portable without adopting a KDL compiler. oh-my-pi's KDL engine is a reference for *where* quirks should live (data, not code) but is out of scope to port wholesale.

---

## 3. oh-my-pi provider / catalog comparison

Packages: `@oh-my-pi/pi-ai` (`packages/ai`, wire translation) and `@oh-my-pi/pi-catalog` (`packages/catalog`, the model DB + provider descriptors + compat engine).

**Catalog contents** ([`packages/catalog/README.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/README.md)):
- `models.json` + `models` - bundled DB (pricing, context windows, modalities, thinking). Generated, never hand-edited.
- [`provider-models/descriptors.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/provider-models/descriptors.ts) - `CATALOG_PROVIDERS` / `PROVIDER_DESCRIPTORS`: pairs each catalog provider with a runtime **model-manager factory** (~90 entries in `MODEL_MANAGER_FACTORIES`). `DEFAULT_MODEL_PER_PROVIDER` is derived from the KDL entries, not hardcoded in TS.
- [`provider-models/openai-compat.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/provider-models/openai-compat.ts) - the shared OpenAI-compatible discovery/request plumbing that ~70 of those factories delegate to (`basetenModelManagerOptions`, `deepinfraModelManagerOptions`, `groqModelManagerOptions`, `openrouterModelManagerOptions`, `together...`, `fireworks...`, `cerebras...`, `nvidia...`, `vllm...`, etc.). This is oh-my-pi's analogue of opencode's `openai-compatible.ts`.
- [`provider-models/special.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/provider-models/special.ts) - bespoke managers (`cursor`, `devin`, `factory-droid`, `gitlab-duo`, `cloudflare-workers-ai`, `zai`, `typesafe`, `web`, `local`).
- [`provider-models/google.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/provider-models/google.ts), `ollama.ts` - vendor-specific discovery.
- `discovery/` - runtime model discovery for OpenAI-compatible endpoints, Gemini, Codex, Cursor, Antigravity, Ollama.
- `compat/` - the rule engine (§2).
- `identity/` - reference resolution, dialects, selection priority, tokenizer families.
- `model-manager` / `model-cache` - runtime registry with discovery refresh and on-disk caching.

**Auth ids** live in [`compat/auth-ids.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/compat/auth-ids.ts) / [`compat/auth.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/compat/auth.ts); OAuth-driven managers (`google-antigravity`, `google-gemini-cli`, `openai-codex`, `xai-oauth`) are built by the coding-agent runtime, not in the catalog descriptor table.

**Comparison to opencode's models.dev approach:**
- Both pin a bundled catalog and refresh via runtime discovery; both funnel most providers through one OpenAI-compatible path.
- opencode's catalog is an *external* source (models.dev) decoded tolerantly at runtime; oh-my-pi *compiles its own* catalog from multiple upstreams (including OpenCode docs) into a compact columnar JSON + a KDL policy tree.
- opencode keeps quirks as per-field catalog hints; oh-my-pi keeps them as compiled rules resolved by taxonomy. opencode is easier to adopt and is the one aligned with the user's "rely on models.dev" directive.
- oh-my-pi's unique, absorbable idea: **model policy must be data, never `id.includes(...)` in code.** HorizonCode should adopt that principle even using opencode's lighter data-hint model.

---

## 4. Strict capability comparison vs HorizonCode (docs + code)

Legend: COMMON = in both external sources (merge once). UNIQUE = in one source (absorb). HAVE = already in HorizonCode. MISSING = absent in HorizonCode.

| Capability | opencode | oh-my-pi | HorizonCode (code / docs) | Disposition |
|---|---|---|---|---|
| Unknown provider → error, never silent | not-found everywhere | not-found | **BUG**: [`providers/index.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/index.ts) `default:` returns `createMockProvider()` silently | COMMON → **fix in HorizonCode** |
| Missing key → readable message | `MissingCredentialError` | yes | HAVE: `missingKeyProvider()` in `index.ts` | HAVE (extend to all providers) |
| OpenAI chat-completions client | [`protocols/openai-chat.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/protocols/openai-chat.ts) | [`provider-models/openai-compat.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/provider-models/openai-compat.ts) | HAVE: `providers/openai.ts` (`/v1/chat/completions`, SSE, tool-call delta assembly, usage) | HAVE |
| Generic openai-compatible adapter (arbitrary baseURL + id) | [`providers/openai-compatible.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/openai-compatible.ts) | `openai-compat.ts` family | MISSING (only 4 fixed providers; `baseUrl` is per-provider override, not a generic host) | COMMON → **absorb** |
| anthropic-compatible / responses-compatible | `anthropic-compatible.ts`, `openai-compatible-responses.ts` | compat records | partial (fixed `anthropic.ts`, `google.ts`) | UNIQUE (opencode) → absorb later |
| User provider registry (declare id+baseURL+options, no code) | catalog + config overlay (`configured.ts` `foldSettings`) | `CATALOG_PROVIDERS` + models.yml | DESIGNED only: `ProviderContributionV1` "endpoint + codec id, never code" (`docs/15` §3.1, line 561); runtime is a closed `switch` | COMMON → **absorb (designed, unbuilt)** |
| models.dev catalog reliance (hundreds of providers/models) | `models-dev.ts` + 8.2 MB snapshot, 230/8787 | own compiled catalog, 81 providers | MISSING: `DEFAULT_MODELS` = 5 hardcoded strings (`config.ts`) | COMMON (concept) → **absorb opencode's** |
| Catalog pin + build-time validation floor | `MINIMUM_PROVIDERS=100`, snapshot plugin | compile-time KDL + `AmbiguousOverlapError` | MISSING | COMMON → absorb |
| Catalog refresh (ETag/digest, periodic) | `refresh()` 5-min, ETag + sha256 digest | model-cache discovery refresh | MISSING | COMMON → absorb (later) |
| API-key resolution with env fallback chain | `AuthOptions.apiKey/.bearer` + `Auth.config` orElse | [`compat/auth.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/compat/auth.ts) | HAVE (partial): `config.ts` `providerKey()` per-provider env, `detectProvider()` | HAVE (generalise) |
| `apiKey:false` keyless providers | `Auth.none`, `keyless-auth.test.ts` | `allowUnauthenticated` descriptor flag | partial: Ollama special-cased in `index.ts` | UNIQUE pattern → absorb as a flag |
| OAuth (PKCE, dynamic client, refresh) | [`plugin/provider/chatgpt.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/plugin/provider/chatgpt.ts) etc., `IntegrationOAuthMethodRegistration` | `openai-codex`, `xai-oauth`, gemini-cli managers | MISSING: `HzConfig.apiKey` is a bare string | COMMON → **absorb (auth union)** |
| Alternate auth schemes (`scheme`, `bearerHeader`, SigV4) | `auth.ts` + `bedrock-auth.ts` | [`compat/auth.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/compat/auth.ts) | MISSING | COMMON → absorb (later) |
| Per-request HTTP options (timeout phases, encoding) | [`schema/options.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/schema/options.ts) `TimeoutConfig`, `RequestEncoding` | request compat axes | partial: `retry.ts` retry/backoff; no timeout phases/encoding | UNIQUE → absorb (later) |
| Open provider-options pass-through (`Known\|(string&{})`) | `OpenString`, `ProviderOptions` | open spec fields | MISSING: `ProviderRequest` has no `providerOptions` | COMMON → absorb (contracts.ts change) |
| Runtime model discovery (Ollama `/api/tags`, LM Studio, vLLM) | `local.ts` / `ollama.ts` discover | `discovery/` + ollama/google | partial: `ollama.ts` exists but no discovery of installed models | UNIQUE (both) → absorb |
| Model capability facts (tools/reasoning/modalities/limit/cost) | catalog `Model.Info` | `classifyModel()` facts | MISSING: HorizonCode tracks only `model` string + context window table (`ContextUsage`, docs/NF-074) | COMMON → absorb (from catalog) |
| Model/provider pickers + `auth login` surfaces | TUI dialogs + CLI handlers | coding-agent surfaces | MISSING (no model/provider slash command surface found) | COMMON → absorb (UX, later) |
| Provider = endpoint + codec, never executable code | enforced (plugins run in host but providers are data) | descriptors are data | DESIGNED: `docs/15` line 561 "endpoints + codec ids, never code" | HAVE (as doctrine) |
| Tolerate unknown provider events/enums | [`packages/ai/AGENTS.md`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/AGENTS.md) principle | tolerant decode | partial: `openai.ts` ignores unknown SSE fields already | HAVE (keep) |

---

## 5. Concrete, portable reuse plan for HorizonCode's provider superset

Grounded in exact HorizonCode files. Every `contracts.ts` change is called out as a design decision (contracts.ts is LAW).

### 5.1 Fail loud on unknown provider (no code, highest priority)

File: `app/src/core/providers/index.ts`.
- Change `makeProvider()` `default:` from `return createMockProvider()` to an error-provider that names the unknown id and lists valid providers, reusing the existing `missingKeyProvider` pattern (one `error` event + one `done`). The mock must only be returned when `opts.mockFlag` is set or `config.provider === "mock"` explicitly.
- Keep the mock reachable via `--mock` / `HZ_PROVIDER=mock` (already handled at the top of `makeProvider`).
- Add a test asserting an unknown `HZ_PROVIDER` yields a visible error, not a mock greeting (mirrors opencode's not-found contract; `MOCK_GREETING` must never appear for a typo'd provider).

### 5.2 openai-compatible adapter (absorb opencode `openai-compatible.ts`)

New file: `app/src/core/providers/openai-compatible.ts`.
- Reuse the wire logic already in `openai.ts` (`toOpenAiMessages`, `toOpenAiTools`, SSE loop, tool-call delta assembly, finish-reason mapping, usage). Factor the streaming core so both `openai.ts` and the compatible adapter share it (opencode shares `OpenAIChat.protocol`; HorizonCode can export the core from `openai.ts`).
- Signature: `createOpenAiCompatibleProvider({ name, apiKey, baseUrl })` → `Provider` whose `name` is the configured provider id (not the literal `"openai-compatible"`), exactly as opencode's `configure()` returns `ProviderID.make(provider)`.
- Wire into `makeProvider`: when `config.provider` is not one of the five built-ins but a `baseUrl` is configured (and, per registry §5.3, the provider is registered), construct the compatible adapter instead of falling through to the error.

### 5.3 User provider registry (absorb; the designed-but-unbuilt `ProviderContributionV1`)

Files: `app/src/core/config.ts` (+ `contracts.ts` if a shared type is added).
- Add a `providers?` section to the user config file (`~/.config/horizon/config.json`), parsed like the existing `mcp` section (`parseMcpConfig` is the template: tolerant, collects `rejected[]`, never throws). Each entry: `{ id: string (slug), baseUrl: string, protocol?: "openai-chat" (default), envKey?: string, apiKey?: string }`.
- `loadConfig()` resolves the selected provider against built-ins first, then the registry; an unknown id that is neither built-in nor registered feeds the fail-loud path (§5.1).
- This realises `docs/15-extensibility.md` §3.1 `ProviderContributionV1` ("endpoint + codec id, never code") and the precedence rule at `docs/15` line 561 (managed → user → plugin; bare-name collision is a typed error). Keep it USER-config only in v1, mirroring the MCP rule in `config.ts` (a workspace cannot name a provider that runs with the user's authority).

### 5.4 models.dev catalog reliance (absorb opencode's catalog)

New area: `app/src/core/catalog/` + a committed snapshot `app/src/core/catalog/models-dev.snapshot.json`.
- Port opencode's shape, reduced: a boot-time bundled snapshot is the floor; optional refresh later. Fetch from models.dev (or the opencode mirror `https://models.opencode.ai` + `catalogPath = /experimental/v2.0/api.json?type=chat`), trim unused fields, validate with a `MINIMUM_PROVIDERS` floor (opencode uses 100), commit the snapshot. Decode tolerantly (skip unparseable models, never fatal) - opencode's `normalize()` is the reference.
- Replace `DEFAULT_MODELS` (5 hardcoded strings in `config.ts`) with a catalog lookup: given `(provider, model)`, resolve the default model and the model's capabilities/limits from the catalog; fall back to the current hardcoded defaults only when offline and the snapshot lacks the provider.
- Feed the context window into the existing `ContextUsage` / NF-074 output-budget machinery (`contracts.ts` `ContextUsage.window`), replacing any hardcoded window table with the catalog's `limit.context`.
- Network: models.dev fetch needs OPEN_INTERNET or COMMON_DEPENDENCIES; under INTEGRATIONS_ONLY ship the committed snapshot only (no live fetch).

### 5.5 API-key OR OAuth auth (absorb opencode's auth union) - contracts.ts change

File: `app/src/contracts.ts` (LAW - design decision), consumed in `config.ts` + [`providers/index.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/index.ts).
- Today `HzConfig.apiKey?: string` and provider factories take `{ apiKey, baseUrl }`. To support OAuth uniformly, introduce a credential union in `contracts.ts`:
  ```ts
  export type Credential =
    | { kind: "apiKey"; value: string }
    | { kind: "oauth"; accessToken: string; refreshToken?: string; expiresAt?: string }
    | { kind: "none" };               // keyless providers (ollama, apiKey:false)
  ```
  This mirrors opencode's `Auth.Definition` outcomes (bearer / none) and its `Credential.OAuth`. Provider factories render the credential into the request header (bearer for both apiKey and oauth; nothing for `none`).
- v1 scope: implement `apiKey` and `none` fully (the `none` kind formalises the current Ollama special-case and opencode's `apiKey:false`). Reserve `oauth` in the type now so later OAuth work (PKCE loopback, token refresh, following opencode's [`plugin/provider/chatgpt.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/plugin/provider/chatgpt.ts)) is additive, not a second breaking contracts change. Record this reservation in the contracts.ts header the way `RunBudget`/`RunExit` are documented.
- `missingKey()` / `missingKeyProvider()` stay but key off `kind` instead of a bare string.

### 5.6 Sequencing / dependencies

1. §5.1 fail-loud (standalone, no deps, do first - it is the named bug).
2. §5.2 openai-compatible adapter (depends on refactoring `openai.ts` core; no contract change).
3. §5.3 user registry (depends on §5.2 to have something to construct; config-only).
4. §5.5 credential union (contracts.ts change; do before OAuth, formalises `none`).
5. §5.4 models.dev catalog (largest; independent of 5.2/5.3 but best after, since the registry + catalog together replace `DEFAULT_MODELS`).

Later / out of v1 scope (documented, not built): live catalog refresh with ETag/digest (§1.4), OAuth loopback flows (§1.5), alternate auth schemes + SigV4 (bedrock), per-request timeout phases + request encoding (§1.6), anthropic-compatible / responses-compatible adapters, runtime model discovery (Ollama `/api/tags`), oh-my-pi's KDL policy engine (adopt the *principle* - quirks as data not code - without the compiler).

---

## 6. Exact-path evidence index

opencode:
- Registry barrel: [`packages/ai/src/providers/index.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/index.ts) (46 namespaces).
- Vendor facade template: [`packages/ai/src/providers/openai.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/openai.ts), `baseten.ts`.
- openai-compatible: [`packages/ai/src/providers/openai-compatible.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/openai-compatible.ts); protocol [`packages/ai/src/protocols/openai-compatible-chat.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/protocols/openai-compatible-chat.ts).
- Settings split: [`packages/ai/src/providers/settings.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/settings.ts) (`toConfig`, `bearerRouteDefaults`).
- Auth core: [`packages/ai/src/route/auth.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/route/auth.ts) (`Auth.Credential`/`Definition`, `bearer`/`header`/`scheme`/`none`/`config`/`orElse`).
- Auth options: [`packages/ai/src/route/auth-options.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/route/auth-options.ts) (`AuthOptions.apiKey`/`.bearer`, `ProviderAuthOption`, `apiKey:false`).
- Catalog service: [`packages/core/src/models-dev.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev.ts) (`ModelsDev.Service`, `catalogPath`, `normalize`, `route`, `refresh`, `BUILDS_OWN_URL`, `COMPATIBLE`, `TYPES`).
- Catalog snapshot pin + validate: [`packages/core/script/models-snapshot.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/script/models-snapshot.ts) (`MINIMUM_PROVIDERS=100`, `UNUSED_MODEL_FIELDS`, `fetchModelsSnapshot`, `modelsSnapshotPlugin`); refresh [`script/update-models-snapshot.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/script/update-models-snapshot.ts).
- Committed snapshot: [`packages/core/src/models-dev/snapshot.txt`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev/snapshot.txt) (8.2 MB; 230 providers, 8787 models).
- v1→v2 converter: [`packages/core/src/models-dev/v1.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev/v1.ts) (`isV1`, `toV2`, `RESPONSES_BY_DEFAULT`).
- OAuth provider: [`packages/core/src/plugin/provider/chatgpt.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/plugin/provider/chatgpt.ts) (PKCE, dynamic client, `exchange`/`refresh`, `verifyIDToken`, `IntegrationOAuthMethodRegistration`); callback page [`packages/core/src/oauth/page.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/oauth/page.ts); refresh [`plugin/provider/refresh.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/plugin/provider/refresh.ts); config overlay [`plugin/provider/configured.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/plugin/provider/configured.ts) (`foldSettings`); local/discovery `plugin/provider/{local,ollama}.ts`; dynamic SDK [`plugin/provider/dynamic.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/plugin/provider/dynamic.ts).
- Schema: [`packages/ai/src/schema/ids.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/schema/ids.ts) (branded `ProviderID`/`ModelID`), [`schema/options.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/schema/options.ts) (`ProviderOptions`, `HttpOptions`, `TimeoutConfig`, `RequestEncoding`).
- Commands: [`auth/login.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/commands/handlers/auth/login.ts), [`auth/account.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/commands/handlers/auth/account.ts), [`auth/export.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/commands/handlers/auth/export.ts), [`auth/form.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/commands/handlers/auth/form.ts), [`handlers/models.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/commands/handlers/models.ts); TUI [`dialog-model.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/component/dialog-model.tsx), [`dialog-model-free.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/component/dialog-model-free.tsx), [`model-options.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/component/model-options.tsx).

oh-my-pi:
- Catalog README: [`packages/catalog/README.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/README.md).
- Bundled catalog: [`packages/catalog/src/models.json`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/models.json) (81 providers, 8674-node pool, compiled columnar).
- Compat axis vocabulary: [`packages/catalog/src/compat/axes.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/compat/axes.ts) (`AXES`, `CompatRecordName`, `AxisDef`).
- Compat provider accessors: [`packages/catalog/src/compat/providers.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/compat/providers.ts); compiled [`compat/rules.json`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/compat/rules.json) from `compat/rules/**/*.kdl`.
- Descriptors: [`packages/catalog/src/provider-models/descriptors.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/provider-models/descriptors.ts) (`MODEL_MANAGER_FACTORIES` ~90, `PROVIDER_DESCRIPTORS`, `DEFAULT_MODEL_PER_PROVIDER`).
- OpenAI-compatible family: [`packages/catalog/src/provider-models/openai-compat.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/src/provider-models/openai-compat.ts); bespoke `special.ts`; discovery `discovery/`.
- Policy doctrine: [`AGENTS.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/AGENTS.md) ("Model/Provider Policy Lives in KDL"), [`catalog/scripts/generate-models.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/catalog/scripts/generate-models.ts), `scripts/compat-compiler/`.

HorizonCode:
- Provider registry + the bug: `app/src/core/providers/index.ts` (`makeProvider` `default:` → `createMockProvider()`; `missingKeyProvider`).
- Vendor clients: `app/src/core/providers/{openai,anthropic,google,ollama,mock}.ts`; shared `retry.ts`, `sse.ts`.
- Config + defaults: `app/src/core/config.ts` (`ProviderName`, `PROVIDER_NAMES`, `DEFAULT_MODELS`, `DEFAULT_BASE_URLS`, `HzConfig`, `detectProvider`, `providerKey`, `parseMcpConfig` template, `missingKey`).
- Contracts (LAW): `app/src/contracts.ts` (`Provider`, `ProviderEvent`, `ProviderRequest`, `ChatMsg`, `ToolSpec`, `Usage`, `ContextUsage`).
- Docs: `docs/15-extensibility.md` §3.1 (`ProviderContributionV1`), line 561 (provider precedence, "endpoints + codec ids, never code"); `docs/07-apis-and-contracts.md` (surface status); `docs/28-implementation-status.md` (provider adapters are the built slice; NF-074 context-cost).
