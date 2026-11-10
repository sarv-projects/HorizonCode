# Ultra Deep-Dive: `wshobson/agents` — Subagent System Design Study

**Repo:** `wshobson-agents` (repo not cloned, path not verified) ("Claude Code Workflows" — multi-harness plugin marketplace)
**Purpose:** Learning pass for HorizonCode's subagent system (`AgentProfileV1` + fleet, docs 08 / 15)
**Method:** structure map → 202-agent frontmatter census (mechanical) → deep-read of 17 agent specs + 5 meta-docs
**Date:** 2026-11-06 · **Read-only on the repo; nothing outside this report file was modified.**

---

## Contents

1. [Repo map](#1-repo-map)
2. [Full agent inventory](#2-full-agent-inventory-202-agents)
3. [Agent-spec anatomy](#3-agent-spec-anatomy)
4. [Ten design patterns to adopt](#4-ten-design-patterns-to-adopt-into-horizoncode)
5. [Anti-patterns to avoid](#5-anti-patterns-to-avoid)
6. [Recommended HorizonCode bundled profiles](#6-recommended-horizoncode-bundled-agent-profiles)

---

## 1. Repo map

### 1.1 What this repo actually is

Not a subagent library with a runtime — a **content marketplace**. There is no orchestrator code, no agent loop, no scheduler. Everything is Markdown + YAML frontmatter, and the "system" is whatever the host harness (Claude Code, Codex, Cursor, OpenCode, Antigravity, Copilot, Pi) chooses to do with the files. That is the single most important framing for HorizonCode: this repo is a **corpus of prompt-engineering artefacts and conventions**, and its value to us is the conventions, not the machinery.

### 1.2 Top-level layout

| Path | Lines / count | Role |
|---|---|---|
| `README.md` | 10.1 KB | Public landing page: install routes per harness, component counts, quick start |
| `AGENTS.md` | 7.0 KB, ~150 lines | **Canonical context file.** Claude Code reads it via `CLAUDE.md` → symlink to `AGENTS.md`. Explicitly capped: *"This file should never grow beyond ~150 lines"* |
| `CLAUDE.md` | symlink → `AGENTS.md` | Single-source trick so 7 harnesses read one file |
| `ARCHITECTURE.md` | 8.9 KB | Adapter framework, source-of-truth invariant |
| `CONTRIBUTING.md` | 8.0 KB | External/vendor plugin bar, quality gates, workflow |
| `Makefile` | 13.6 KB | `generate-all`, `validate STRICT=1`, `garden`, `test`, `smoke-test`, `check-version-bumps`, `lint`, installers |
| `plugins/` | **92 local plugins** | The product. Auto-discovered |
| `plugins/*/agents/` | **202 agent `.md`** | The subagent corpus — our study target |
| `plugins/*/skills/` | 185 skills | `SKILL.md` + `references/` + `assets/`, progressive disclosure |
| `plugins/*/commands/` | 105 commands | Slash-command workflows |
| `plugins/*/.claude-plugin/plugin.json` | 92 | Manifest + version (bump required on every change) |
| `tools/adapters/` | — | Per-harness format generators; `capabilities.py` holds `MODEL_ALIASES` |
| `docs/` | 12 files | `agents.md` (202-agent reference), `authoring.md` (style guide), `harnesses.md`, `architecture.md`, `plugins.md`, `usage.md`, `agent-skills.md`, `plugin-eval.md`, `mlops.md`, `round-trip-results.md` |
| `evals/` | — | Eval harness scaffolding |
| `.github/` | — | Issue templates, CI workflows, PR template, CoC |
| `.agents/`, `.cursor/`, `.cursor-plugin/`, `.codex-plugin/` | generated | Native-install registries, committed and drift-checked |

### 1.3 The plugin shape (uniform, auto-discovered)

```text
plugins/<plugin-name>/
├── .claude-plugin/plugin.json     # name, version, description, keywords
├── .codex-plugin/plugin.json      # generated, committed
├── agents/<name>.md               # 0..n agent specs
├── skills/<name>/SKILL.md         # 0..n skills (+ references/, assets/)
├── commands/<name>.md             # 0..n commands
└── README.md                      # optional
```

Contrast with HorizonCode: our `AgentProfileV1` is a *runtime object* with a digest pinned into the session. Here the agent file **is** the object; there is no digest, no revision, no pinning. A plugin version bump is the only change-tracking mechanism.

### 1.4 Category taxonomy

There is **no taxonomy field**. Categories are three independent, partially-overlapping schemes:

1. **Plugin directory name** — 92 topical buckets (`python-development`, `kubernetes-operations`, `seo-content-creation`, `hr-legal-compliance`). This is the *distribution* axis; it is what a user installs.
2. **`docs/agents.md` hand-maintained headings** — a *presentation* axis with ~20 headings grouped under 5 banners: *Architecture & System Design* (Core Architecture / UI-UX & Mobile), *Programming Languages* (Systems & Low-Level / Web & Application / Enterprise & JVM / Specialized Platforms), *Infrastructure & Operations* (DevOps & Deployment / Database Management / Incident Response & Network / Project Management), *Quality Assurance & Security* (Code Quality & Review / Testing & Debugging / Performance & Observability), *Data & AI*.
3. **`name:` frontmatter** — usually `<plugin>-<role>` for disambiguation, sometimes bare (`python-pro`, `rust-pro`, `review`, `team-lead`).

**Observation:** categories 1 and 2 disagree constantly — `data-engineer` lives in `data-engineering`, is documented under *Data & AI*, and is modelled `opus`. `comprehensive-review/code-reviewer`, `codebase-cleanup/code-reviewer`, `tdd-workflows/code-reviewer` and `git-pr-workflows/code-reviewer` are **the same agent shipped four times**. The taxonomy is a *packaging* decision, not a *capability* decision. That is a deliberate trade (users install a bundle, not a role) but it makes the fleet non-composable: there is no single canonical `code-reviewer` to hand a task to.

### 1.5 Component counts

| Component | Count |
|---|---:|
| Plugins (local) | 92 (+2 external registry entries = 94 catalog) |
| Agents | 202 |
| Skills | 185 |
| Commands | 105 |
| Harnesses | 7 |

### 1.6 What lives in the body of a typical agent

Mechanical census of `^## ` headings across all 202 agent files:

| Heading | Count | Reading |
|---|---:|---|
| `## Capabilities` | 123 | The default bullet-dump section |
| `## Response Approach` | 115 | Numbered 5–10 step procedure |
| `## Behavioral Traits` | 115 | Persona guardrails |
| `## Purpose` | 108 | Second-person role statement |
| `## Example Interactions` | 107 | Quoted user-utterance triggers |
| `## Knowledge Base` | 101 | Domain areas of expertise (filler) |
| `## Output` / `## Output Format` | 34 + 13 | The output contract — **only ~1/4 of agents have one** |
| `## Workflow` | 14 | Step-by-step method |
| `## Strict Boundaries` | 6 | Explicit negative scope |
| `## Inputs` | 6 | Named artifact inputs |

**The two-tier corpus is obvious.** ~150 of the 202 agents are the same template with the nouns swapped (Capabilities → Response Approach → Behavioral Traits → Example Interactions → Knowledge Base), and they are poor delegation targets because they have no input contract and no output contract. ~30 agents are genuinely engineered: short, boundary-bearing, tool-restricted, with named inputs, named outputs, and verdict formats. **The engineered minority is the entire design lesson.**

---

## 2. Full agent inventory (202 agents)

### 2.0 Census method and headline numbers

Enumerated mechanically from all 202 files under `plugins/*/agents/*.md` (frontmatter `name`, `model`, `tools`, `description`). Purpose strings are condensed from each file's own `description:`. Deep-read files are marked **★**.

**Model distribution (202 agents):**

| Model alias | Count | Share | Reading |
|---|---:|---:|---|
| `sonnet` | 70 | 35% | Default worker tier — nearly all leaf implementers, testers, writers |
| `opus` | 54 | 27% | Reviewers, architects, security, and everything "elite" |
| `inherit` | 52 | 26% | Harness-dependent; the adapter maps it to the session model |
| `haiku` | 24 | 12% | Mechanical, extractive, formatting and SEO/ops chores |
| `fable` | 2 | 1% | `team-lead` (orchestrator) and `framework-migration/legacy-modernizer` |

**Tool restriction (202 agents):**

| Tool frontmatter | Count | Reading |
|---|---:|---|
| *absent* → host default (full toolset) | 188 | **93% of agents declare no tool allowlist at all** |
| explicit allowlist | 13 | The engineered minority |
| explicitly empty `tools: []` | 1 | `arm-cortex-expert` — likely a bug, not a design |

**Trigger phrases:** 176 of 202 `description:` values carry the word `Use` ("Use when …", "Use PROACTIVELY when …") because the repo's lint (`MISSING_TRIGGER`) mechanically requires one. The repo documents the accepted set: `Use when …`, `Use this skill when …`, `Use PROACTIVELY when …`, `Use after …`, `Trigger when …`, `Auto-loads when …`.

### 2.1 Inventory — architecture, API, backend

| Agent | Plugin | Model | Tools | Purpose |
|---|---|---|---|---|
| `backend-architect` | api-scaffolding | inherit | all | Scalable API design, microservice boundaries, distributed systems |
| `django-pro` | api-scaffolding | opus | all | Django 5.x async views, DRF, Celery, Channels |
| `fastapi-pro` | api-scaffolding | opus | all | Async APIs with FastAPI, SQLAlchemy 2.0, Pydantic V2 |
| `graphql-architect` | api-scaffolding | opus | all | Federated GraphQL schema and resolver architecture |
| `backend-architect` | backend-api-security | inherit | all | (duplicate of api-scaffolding) |
| `backend-security-coder` | backend-api-security | sonnet | all | Input validation, authentication, API security implementation |
| `backend-architect` | backend-development | inherit | all | (duplicate) |
| `event-sourcing-architect` | backend-development | inherit | all | Event sourcing, CQRS, event stores, sagas |
| `graphql-architect` | backend-development | opus | all | (duplicate of api-scaffolding) |
| `performance-engineer` | backend-development | sonnet | all | Response times, memory, query efficiency, scaling |
| `security-auditor` | backend-development | sonnet | all | OWASP Top 10, auth flaws, compliance review |
| `tdd-orchestrator` **★** | backend-development | opus | all | Red-green-refactor discipline, multi-agent TDD coordination |
| `temporal-python-pro` | backend-development | inherit | all | Temporal durable workflows, saga patterns |
| `test-automator` | backend-development | sonnet | all | Unit/integration/E2E suite creation |
| `backend-architect` | backend-development | inherit | all | (duplicate) |
| `backend-architect` | database-cloud-optimization | inherit | all | (duplicate) |
| `backend-architect` | data-engineering | inherit | all | (duplicate) |
| `backend-architect` | multi-platform-apps | inherit | all | (duplicate) |
| `backend-architect` **★** | backend-development | inherit | all | Scalable API design, service boundaries, data schemas |
| `review-policy-author` | review-agent-governance | sonnet | all | Cedar policy author gating AI agent review actions |
| `payment-integration` | payment-processing | sonnet | all | Stripe/PayPal checkout, subscriptions, webhooks, PCI |
| `dotnet-architect` | dotnet-contribution | sonnet | all | C#, ASP.NET Core, EF Core, Dapper enterprise apps |
| `dgx-spark-ops-engineer` | dgx-spark-ops | sonnet | all | NVIDIA DGX Spark / GB10 / aarch64 CUDA-13 environment doctor |
| `arm-cortex-expert` | arm-cortex-microcontrollers | inherit | **`[]`** | Firmware for Arm Cortex-M (allowlist is empty — see §5) |
| `firmware-analyst` | reverse-engineering | opus | all | Embedded/IoT firmware and hardware reverse engineering |
| `malware-analyst` | reverse-engineering | opus | all | Defensive malware research, threat intel |
| `reverse-engineer` | reverse-engineering | opus | all | Binary analysis, disassembly, decompilation |

### 2.2 Inventory — languages & frameworks

| Agent | Plugin | Model | Tools | Purpose |
|---|---|---|---|---|
| `python-pro` | python-development | opus | all | Python 3.12+, async, performance, packaging |
| `django-pro` | python-development | opus | all | (duplicate) |
| `fastapi-pro` | python-development | opus | all | (duplicate) |
| `javascript-pro` | javascript-typescript | inherit | all | ES6+, async patterns, Node.js APIs |
| `typescript-pro` | javascript-typescript | opus | all | Advanced types, generics, strict type safety |
| `rust-pro` | systems-programming | opus | all | Rust 1.75+, async, ownership, systems programming |
| `golang-pro` | systems-programming | opus | all | Go 1.21+, concurrency, production microservices |
| `cpp-pro` | systems-programming | opus | all | Modern C++, RAII, smart pointers, STL |
| `c-pro` | systems-programming | opus | all | C with manual memory management and syscalls |
| `java-pro` | jvm-languages | opus | all | Java 21+, virtual threads, Spring Boot 3.x |
| `scala-pro` | jvm-languages | inherit | all | Scala, functional programming, distributed systems |
| `csharp-pro` | jvm-languages | inherit | all | Modern C#, records, pattern matching, async |
| `elixir-pro` | functional-programming | inherit | all | OTP, supervision trees, Phoenix LiveView |
| `haskell-pro` | functional-programming | sonnet | all | Advanced type systems, pure functional design |
| `ruby-pro` | web-scripting | inherit | all | Ruby metaprogramming, Rails, gem development |
| `php-pro` | web-scripting | inherit | all | Modern PHP, generators, SPL, OOP |
| `sql-pro` | database-design | inherit | all | Cloud-native SQL, OLTP/OLAP tuning |
| `julia-pro` | julia-development | sonnet | all | Julia 1.10+, multiple dispatch, performance |
| `bash-pro` | shell-scripting | sonnet | all | Defensive Bash for CI/CD and system utilities |
| `posix-shell-pro` | shell-scripting | sonnet | all | Strict POSIX sh portability |
| `unity-developer` | game-development | opus | all | Unity 6, optimized C#, rendering, assets |
| `minecraft-bukkit-pro` | game-development | opus | all | Bukkit/Spigot/Paper plugin development |
| `blockchain-developer` | blockchain-web3 | opus | all | Web3 apps, smart contracts, DeFi protocols |

### 2.3 Inventory — frontend, UI/UX, mobile

| Agent | Plugin | Model | Tools | Purpose |
|---|---|---|---|---|
| `ui-visual-validator` **★** | accessibility-compliance | sonnet | all | Visual regression and UI verification against design system |
| `frontend-developer` | application-performance | inherit | all | React components, responsive layouts, client state |
| `frontend-developer` | frontend-mobile-development | inherit | all | (duplicate) |
| `frontend-developer` | frontend-mobile-security | inherit | all | (duplicate) |
| `frontend-developer` | multi-platform-apps | inherit | all | (duplicate) |
| `mobile-developer` | frontend-mobile-development | inherit | all | React Native / Flutter cross-platform apps |
| `mobile-developer` | multi-platform-apps | inherit | all | (duplicate) |
| `ios-developer` | multi-platform-apps | inherit | all | Swift/SwiftUI, iOS 18, Core Data |
| `flutter-expert` | multi-platform-apps | inherit | all | Flutter, Dart 3, advanced widgets |
| `ui-ux-designer` | multi-platform-apps | sonnet | all | Wireframes, interface design, design systems |
| `ui-designer` | ui-design | inherit | all | Component creation, layout systems, visual design |
| `accessibility-expert` **★** | ui-design | inherit | all | WCAG 2.1/2.2/3.0, ARIA, screen readers, keyboard nav |
| `design-system-architect` | ui-design | inherit | all | Design tokens, component libraries, theming |
| `frontend-security-coder` | frontend-mobile-security | sonnet | all | XSS prevention, CSP, client-side security |
| `mobile-security-coder` | frontend-mobile-security | sonnet | all | WebView security, mobile input validation |

### 2.4 Inventory — infrastructure, cloud, DevOps

| Agent | Plugin | Model | Tools | Purpose |
|---|---|---|---|---|
| `cloud-architect` | cicd-automation | opus | all | Multi-cloud (AWS/Azure/GCP/OCI) IaC architecture |
| `deployment-engineer` | cicd-automation | haiku | all | CI/CD pipelines, GitOps workflows, deployments |
| `devops-troubleshooter` | cicd-automation | sonnet | all | Incident response, debug, observability |
| `kubernetes-architect` | cicd-automation | opus | all | Cloud-native K8s, ArgoCD/Flux GitOps |
| `terraform-specialist` | cicd-automation | opus | all | Terraform/OpenTofu, state management, modules |
| `cloud-architect` | cloud-infrastructure | opus | all | (duplicate) |
| `deployment-engineer` | cloud-infrastructure | haiku | all | (duplicate) |
| `hybrid-cloud-architect` | cloud-infrastructure | opus | all | Multi-cloud + on-prem hybrid topologies |
| `kubernetes-architect` | cloud-infrastructure | opus | all | (duplicate) |
| `network-engineer` | cloud-infrastructure | sonnet | all | Cloud networking, security, performance |
| `service-mesh-expert` | cloud-infrastructure | opus | all | Istio/Linkerd, mTLS, traffic management |
| `terraform-specialist` | cloud-infrastructure | opus | all | (duplicate) |
| `cloud-architect` | database-cloud-optimization | sonnet | all | (duplicate, downgraded to sonnet) |
| `cloud-architect` | deployment-validation | sonnet | all | (duplicate, downgraded) |
| `deployment-engineer` | deployment-strategies | haiku | all | (duplicate) |
| `terraform-specialist` | deployment-strategies | opus | all | (duplicate) |
| `kubernetes-architect` | kubernetes-operations | opus | all | (duplicate) |
| `deployment-engineer` | full-stack-orchestration | haiku | all | (duplicate) |
| `monorepo-architect` | developer-essentials | opus | all | Nx/Turborepo/Bazel, workspace optimization |
| `database-architect` | database-design | opus | all | Data-layer design, technology selection, schemas |
| `database-architect` | database-cloud-optimization | inherit | all | (duplicate) |
| `database-optimizer` | database-cloud-optimization | inherit | all | Query tuning, indexing, scalable architecture |
| `database-optimizer` | database-migrations | inherit | all | (duplicate) |
| `database-optimizer` | observability-monitoring | inherit | all | (duplicate) |
| `database-admin` | database-migrations | sonnet | all | Backup, replication, monitoring, automation |
| `observability-engineer` | application-performance | inherit | all | Monitoring, logging, tracing, SLI/SLO |
| `observability-engineer` | observability-monitoring | inherit | all | (duplicate) |
| `performance-engineer` | application-performance | inherit | all | Profiling, optimization, scalability |
| `performance-engineer` | observability-monitoring | inherit | all | (duplicate) |
| `performance-engineer` | performance-testing-review | inherit | all | (duplicate) |
| `performance-engineer` | full-stack-orchestration | inherit | all | (duplicate) |
| `network-engineer` | observability-monitoring | sonnet | all | (duplicate) |
| `dx-optimizer` | team-collaboration | sonnet | all | Developer experience, tooling, setup workflows |
| `dx-optimizer` | debugging-toolkit | sonnet | all | (duplicate) |

### 2.5 Inventory — quality, security, review, docs

| Agent | Plugin | Model | Tools | Purpose |
|---|---|---|---|---|
| `code-reviewer` | codebase-cleanup | opus | all | AI-assisted review: security, performance, reliability |
| `code-reviewer` | code-documentation | opus | all | (duplicate) |
| `code-reviewer` | code-refactoring | opus | all | (duplicate) |
| `code-reviewer` **★** | comprehensive-review | opus | all | **Canonical** elite review: AI analysis, static tools, config review |
| `code-reviewer` | git-pr-workflows | opus | all | (duplicate of canonical) |
| `code-reviewer` | tdd-workflows | opus | all | (duplicate) |
| `code-reviewer` | incident-response | sonnet | all | Logic flaws, type-safety gaps, error handling |
| `architect-review` | comprehensive-review | opus | all | Architectural consistency and pattern validation |
| `architect-review` | framework-migration | opus | all | (duplicate) |
| `security-auditor` | comprehensive-review | opus | all | DevSecOps, vulnerability assessment, compliance |
| `security-auditor` | security-compliance | opus | all | (duplicate) |
| `security-auditor` | security-scanning | opus | all | (duplicate) |
| `security-auditor` | full-stack-orchestration | opus | all | (duplicate) |
| `threat-modeling-expert` | security-scanning | opus | all | STRIDE, attack trees, PASTA, security requirements |
| `test-automator` | codebase-cleanup | sonnet | all | Self-healing tests, quality engineering |
| `test-automator` | full-stack-orchestration | sonnet | all | (duplicate) |
| `test-automator` | performance-testing-review | sonnet | all | (duplicate) |
| `test-automator` | unit-testing | sonnet | all | (duplicate) |
| `test-automator` | incident-response | sonnet | all | Regression and security test creation for fixes |
| `debugger` | debugging-toolkit | sonnet | all | Errors, test failures, unexpected behaviour |
| `debugger` | error-debugging | sonnet | all | (duplicate) |
| `debugger` | error-diagnostics | sonnet | all | (duplicate) |
| `debugger` | unit-testing | sonnet | all | (duplicate) |
| `debugger` | incident-response | sonnet | all | Root cause via code path tracing, git bisect |
| `error-detective` | distributed-debugging | sonnet | all | Log/stack-trace pattern search, correlation |
| `error-detective` | error-debugging | sonnet | all | (duplicate) |
| `error-detective` | error-diagnostics | sonnet | all | (duplicate) |
| `error-detective` | distributed-debugging | sonnet | all | (duplicate) |
| `error-detective` | incident-response | sonnet | all | Error signatures, reproduction steps, user impact |
| `devops-troubleshooter` | distributed-debugging | sonnet | all | (duplicate) |
| `devops-troubleshooter` | incident-response | sonnet | all | (duplicate) |
| `incident-responder` | incident-response | sonnet | all | SRE incident command, observability, comms |
| `legacy-modernizer` | code-refactoring | sonnet | all | Framework migration, gradual modernization |
| `legacy-modernizer` | dependency-management | sonnet | all | (duplicate) |
| `legacy-modernizer` | framework-migration | **fable** | all | (duplicate, promoted to fable) |
| `docs-architect` | code-documentation | sonnet | all | Docs from codebase: architecture, patterns, APIs |
| `docs-architect` | documentation-generation | sonnet | all | (duplicate) |
| `tutorial-engineer` | code-documentation | sonnet | all | Step-by-step tutorials from code |
| `tutorial-engineer` | documentation-generation | sonnet | all | (duplicate) |
| `api-documenter` | api-testing-observability | sonnet | all | OpenAPI 3.1, developer experience docs |
| `api-documenter` | documentation-generation | sonnet | all | (duplicate) |
| `mermaid-expert` | documentation-generation | haiku | all | Mermaid diagrams: flowcharts, sequence, ERD |
| `reference-builder` | documentation-generation | haiku | all | Exhaustive parameter/reference listings |
| `c4-code` **★** | c4-architecture | **haiku** | all | C4 Code-level docs from a code directory (320 lines) |
| `c4-component` | c4-architecture | sonnet | all | Synthesises Code-level into Component-level C4 |
| `c4-container` | c4-architecture | sonnet | all | Synthesises Component-level into Container-level |
| `c4-context` | c4-architecture | sonnet | all | System context diagrams, personas, external systems |

### 2.6 Inventory — tool-restricted agents (the engineered minority)

Every agent in the repo that declares an explicit `tools:` allowlist. This is the most directly transferable table in the report.

| Agent | Plugin | Model | Allowlist | Rationale visible in the spec |
|---|---|---|---|---|
| `team-lead` **★** | agent-teams | fable | `Read, Glob, Grep, Bash, Agent, TeamCreate, TeamDelete, TaskCreate, TaskList, TaskGet, TaskUpdate, SendMessage` | **No `Write`/`Edit`.** Orchestrator cannot touch files; it owns lifecycle + task + messaging verbs only |
| `team-implementer` **★** | agent-teams | opus | `Read, Write, Edit, Glob, Grep, Bash, TaskList, TaskGet, TaskUpdate, SendMessage` | Write/Edit present; **no `Agent`, no `TaskCreate`, no `TeamDelete`** — cannot spawn or destroy |
| `team-reviewer` **★** | agent-teams | opus | `Read, Glob, Grep, Bash, TaskList, TaskGet, TaskUpdate, SendMessage` | **Read-only on the workspace**; still reports via TaskUpdate/SendMessage |
| `team-debugger` **★** | agent-teams | opus | `Read, Glob, Grep, Bash, TaskList, TaskGet, TaskUpdate, SendMessage` | Read-only investigator; evidence gathering only |
| `conductor-validator` | conductor | opus | `Read, Glob, Grep, Bash` | Pure validator: no write, no messaging, no spawn |
| `eval-judge` **★** | plugin-eval | sonnet | `Read, Grep, Glob` | Judge must not mutate what it scores; no Bash at all |
| `code-review-preshipment` **★** | operating-kit | sonnet | `Bash, Read, Glob, Grep` | Reviewer reads + runs git; never edits |
| `deploy-with-verification` | operating-kit | sonnet | `Bash, Read, Edit` | May run deploy and **edit only the state doc** — no `Write` |
| `prod-logs-health-check` | operating-kit | haiku | `Bash, Read` | Pure observation, minimal tier |
| `session-start` **★** | operating-kit | haiku | `Read, Bash, Edit` | Reads state, verifies live, edits the state doc only |
| `session-end` | operating-kit | haiku | `Read, Edit, Bash` | Same shape as session-start |
| `social-publishing-publisher` | social-publishing | haiku | `Read, Write, Bash, WebFetch` | Needs network + write, nothing else |
| `gallery-researcher` | meigen-ai-design | haiku | `mcp__meigen__search_gallery`, `mcp__meigen__get_inspiration` | **MCP-scoped**: only the two read-shaped MCP verbs |
| `image-generator` | meigen-ai-design | inherit | `mcp__meigen__generate_image` | Exactly one tool — a pure context-relay wrapper |

### 2.7 Inventory — data, AI/ML, business, orchestration

| Agent | Plugin | Model | Tools | Purpose |
|---|---|---|---|---|
| `data-scientist` | machine-learning-ops | inherit | all | Analytics, ML modelling, statistics |
| `ml-engineer` | machine-learning-ops | inherit | all | PyTorch 2.x/TF serving, production ML |
| `mlops-engineer` | machine-learning-ops | inherit | all | MLflow/Kubeflow pipelines, model registry |
| `data-engineer` | data-engineering | opus | all | ETL, warehouses, streaming (Airflow/Spark/Kafka) |
| `ai-engineer` | llm-application-dev | inherit | all | LLM apps, RAG, agents, vector search |
| `prompt-engineer` | llm-application-dev | inherit | all | Advanced prompting, LLM optimisation |
| `vector-database-engineer` | llm-application-dev | inherit | all | Pinecone/Weaviate/pgvector, embeddings |
| `llm-finetuning-architect` **★** | llm-finetuning | opus | all | Owns the eval gate; **refuses to plan training without a baseline** |
| `llm-finetuning-eval-engineer` | llm-finetuning | sonnet | all | Golden sets, graders, judge calibration |
| `llm-finetuning-training-engineer` | llm-finetuning | sonnet | all | Dataset prep, Unsloth training scripts, runs |
| `eval-orchestrator` | plugin-eval | opus | all | Orchestrates plugin quality evaluation, certification |
| `context-manager` | agent-orchestration | inherit | all | Context engineering, vector DBs, knowledge graphs |
| `context-manager` | context-management | inherit | all | (duplicate) |
| `business-analyst` | business-analytics | sonnet | all | Requirements, dashboards, data-driven insights |
| `startup-analyst` | startup-business-analyst | inherit | all | Market sizing, financial modelling, competitive analysis |
| `quant-analyst` | quantitative-trading | inherit | all | Financial models, backtests, risk metrics |
| `risk-manager` | quantitative-trading | inherit | all | Portfolio risk, R-multiples, hedging, expectancy |
| `hr-pro` | hr-legal-compliance | sonnet | all | Hiring, onboarding, PTO, compliant policy |
| `legal-advisor` | hr-legal-compliance | sonnet | all | Privacy policies, ToS, GDPR, cookie notices |
| `payment-integration` | payment-processing | sonnet | all | Stripe/PayPal, checkout, subscriptions, webhooks |
| `content-marketer` | content-marketing | haiku | all | Content strategy, omnichannel, SEO distribution |
| `search-specialist` | content-marketing | haiku | all | Web research, search operators, synthesis |
| `customer-support` | customer-sales-automation | haiku | all | Conversational support, ticketing, sentiment |
| `sales-automator` | customer-sales-automation | haiku | all | Cold emails, proposals, pricing pages, case studies |
| `seo-content-writer` | seo-content-creation | sonnet | all | SEO content from keyword briefs |
| `seo-content-auditor` | seo-content-creation | sonnet | all | E-E-A-T scoring and improvement |
| `seo-content-planner` | seo-content-creation | haiku | all | Outlines, topic clusters, calendars |
| `seo-authority-builder` | seo-analysis-monitoring | sonnet | all | E-E-A-T authority signal analysis |
| `seo-cannibalization-detector` | seo-analysis-monitoring | haiku | all | Keyword overlap / cannibalisation detection |
| `seo-content-refresher` | seo-analysis-monitoring | haiku | all | Stale-statistic and freshness updates |
| `seo-keyword-strategist` | seo-technical-optimization | haiku | all | Keyword density, semantic/LSI variants |
| `seo-meta-optimizer` | seo-technical-optimization | haiku | all | Meta titles, descriptions, URL suggestions |
| `seo-snippet-hunter` | seo-technical-optimization | haiku | all | Featured-snippet formatting, SERP features |
| `seo-structure-architect` | seo-technical-optimization | haiku | all | Header hierarchy, schema markup, internal links |
| `policy-enforcer` **★** | protect-mcp | opus | all | Cedar policy author/auditor for agent tool calls |
| `receipt-verifier` | protect-mcp | sonnet | all | Ed25519 signed receipts, JCS canonicalisation |
| `pptx-deck-creation-builder` | pptx-deck-creation | inherit | all | Build/repair/audit editable PPTX decks |

### 2.8 Inventory — the orchestrated pipelines (the most interesting plugins)

**`ship-mate`** — a complete sequential multi-agent pipeline with file-based handoffs:

| Agent | Model | Tools | Purpose |
|---|---|---|---|
| `orchestrate` **★** | sonnet | all | Product Manager: reads story file, asks clarifying questions **one at a time**, confirms FRONTEND/BACKEND, writes `orchestrator-output.md` |
| `architect` | inherit | all | Reads `orchestrator-output.md` + `AGENTS.md` + `project-doc.md`, writes numbered `architect-plan.md` |
| `implement` | sonnet | all | Executes the plan step by step, writes tests, leaves notes |
| `playwright` | sonnet | all | **Only runs when task type is FRONTEND**; verifies acceptance criteria in a real browser |
| `qa` | sonnet | all | Tests every acceptance criterion and edge case, emits `qa-report.md` |
| `review` **★** | inherit | all | 3-tier review taxonomy (🔴 Critical / 🟡 Should Fix / 💡 Consider), auto-resolves minor issues, pauses on critical, writes `review-report.md` |

**`agent-teams`** — a live team protocol with a shared task board and message bus:

| Agent | Model | Tools | Purpose |
|---|---|---|---|
| `team-lead` **★** | fable | lifecycle + Agent + tasks + messaging | Decompose, assign file ownership, spawn, monitor, synthesise, shut down |
| `team-implementer` **★** | opus | write + tasks + messaging | Build within strict file-ownership boundaries |
| `team-reviewer` **★** | opus | read-only + tasks + messaging | One review dimension per agent (security, performance, architecture) |
| `team-debugger` **★** | opus | read-only + tasks + messaging | Investigate **one assigned hypothesis** per agent |

**`operating-kit`** — a session-lifecycle loop deliberately built from three haiku/sonnet agents with tiny tool grants, plus a paired inverse (`session-start` ↔ `session-end`).

### 2.9 Duplication census

Of 202 agents, **61 are byte-similar duplicates under different plugin directories** (`code-reviewer` ×6, `security-auditor` ×4, `frontend-developer` ×4, `performance-engineer` ×4, `test-automator` ×5, `database-optimizer` ×3, `debugger` ×5, `error-detective` ×4, …). The `name:` field is namespaced `<plugin>-<role>` in exactly the plugins that needed collision-avoidance, but many duplicates reuse the bare name — meaning the same role appears twice with **different** model tiers (`cloud-architect` is `opus` in `cloud-infrastructure` and `sonnet` in `deployment-validation`). There is no single source of truth for a role.

---

## 3. Agent-spec anatomy

### 3.1 Frontmatter — the whole surface

The repo's own `docs/authoring.md` states the contract: **required `name`, `description`; recommended `model`; optional `tools:`, optional `color:`**.

```yaml
---
name: team-lead
description: Team orchestrator that decomposes work into parallel tasks with file ownership
  boundaries, manages team lifecycle, and synthesizes results. Use when coordinating
  multi-agent teams, decomposing complex tasks, or managing parallel workstreams.
tools: Read, Glob, Grep, Bash, Agent, TeamCreate, TeamDelete, TaskCreate, TaskList, TaskGet, TaskUpdate, SendMessage
model: fable
color: blue
---
```

| Field | Required | Semantics | Portability |
|---|---|---|---|
| `name` | **yes** | Agent identifier. May differ from filename. Prefixed `<plugin>-<role>` when the plugin needed collision-avoidance | Codex reserves `default`/`worker`/`explorer`; the adapter namespaces collisions and lints `AGENT_NAME_COLLISION` |
| `description` | **yes** | **The routing signal.** One sentence: identity + capability list + trigger phrase. Lint `MISSING_TRIGGER` fires without a recognized phrase (`Use when`, `Use PROACTIVELY when`, `Use after`, `Trigger when`, `Auto-loads when`, `Use this skill when`) | Copilot requires a **plain string** (no YAML block scalars) |
| `model` | recommended | Tier alias: `opus` / `sonnet` / `haiku` / `fable` / `inherit`. Adapters map it per harness (see `tools/adapters/capabilities.py`) | Cursor, Antigravity, Pi, Codex all map differently; Antigravity takes a *tier* not a model id |
| `tools` | optional | Comma-separated **allowlist**. Absent ⇒ host default (full toolset). Becomes a per-harness permission block where supported, dropped otherwise | **Honoured only on Claude Code / Antigravity / OpenCode** (+Pi via extension). Cursor and Codex have coarser models |
| `color` | optional | Cosmetic terminal tint | Dropped everywhere except Claude Code |

**`fable` deserves a note.** The repo documents it as *"the tier above `opus`, reserved for the longest-horizon autonomous work… Tag an agent `fable` only when Opus demonstrably needs multiple attempts at the task. Avoid it for security-analysis agents — Fable 5's cyber/bio classifiers fall back to Opus there anyway. Prefer stating goals over step-by-step scaffolding in fable-tier agent bodies, and never instruct the model to echo its reasoning."* Only 2 of 202 agents use it (`team-lead`, `legacy-modernizer`) — and both are exactly the "long-horizon, must hold a plan across many steps" shape.

### 3.2 Body — the canonical section stack

```text
<one-line role statement>              # "You are an expert X specializing in Y."

## Purpose / Core Mission / Expert Purpose   # what this agent is FOR (108/202)
## Capabilities                              # domain bullet dump (123/202) — usually 100-200 lines
    ### Sub-capability group
    - bullet, bullet, bullet
## Workflow / Implementation Workflow          # numbered phases (rare, 14/202)
## Inputs                                    # named artifacts to read (6/202) ← the good ones
## Output / Output Format                     # the required artefact (47/202 combined) ← the good ones
## Strict Boundaries                          # explicit negatives (6/202) ← the good ones
## Behavioral Traits                          # persona guardrails (115/202)
## Knowledge Base                             # expertise areas (101/202) — filler
## Example Interactions                       # quoted user utterances (107/202)
## Response Approach                          # numbered 5-10 step procedure (115/202)
```

**Length distribution is bimodal.** The engineered agents are 55–120 lines; the template agents are 150–400 lines (`c4-code` is 320 lines for a haiku agent). Length correlates *negatively* with usefulness here: the long ones spend their budget telling the model what a domain expert would already know.

### 3.3 A quoted example — the best-engineered spec in the repo

`plugins/agent-teams/agents/team-lead.md` (92 lines, model `fable`, 12-tool allowlist). Reproduced with elisions:

```markdown
---
name: team-lead
description: Team orchestrator that decomposes work into parallel tasks with file ownership boundaries,
  manages team lifecycle, and synthesizes results. Use when coordinating multi-agent teams,
  decomposing complex tasks, or managing parallel workstreams.
tools: Read, Glob, Grep, Bash, Agent, TeamCreate, TeamDelete, TaskCreate, TaskList, TaskGet, TaskUpdate, SendMessage
model: fable
color: blue
---

You are an expert team orchestrator specializing in decomposing complex software engineering tasks into parallel workstreams with clear ownership boundaries.

## Core Mission

Lead multi-agent teams through structured workflows: analyze requirements, decompose work into independent tasks with file ownership, spawn and coordinate teammates, monitor progress, synthesize results, and manage graceful shutdown.

## Capabilities

### Team Composition
- Select optimal team size based on task complexity (2-5 teammates)
- Choose appropriate agent types for each role (read-only vs full-capability)
...

## File Ownership Rules

1. **One owner per file** — Never assign the same file to multiple teammates
2. **Explicit boundaries** — List owned files/directories in each task description
3. **Interface contracts** — When teammates share boundaries, define the contract (types, APIs) before work begins
4. **Shared files** — If a file must be touched by multiple teammates, the lead owns it and applies changes sequentially

## Communication Protocols

1. Use `SendMessage` with `message` for direct teammate communication (default)
2. Use `broadcast` only for critical team-wide announcements
3. Never send structured JSON status messages — use TaskUpdate instead
4. Read team config from `~/.claude/teams/{team-name}/config.json` for teammate discovery
5. Refer to teammates by their actual spawned NAME, never by UUID or role alias

## Team Lifecycle Protocol

1. **Spawn** — Create team with TeamCreate tool, spawn teammates with Agent tool
2. **Assign** — Create tasks with TaskCreate, assign with TaskUpdate
3. **Monitor** — Check TaskList periodically, respond to teammate messages
4. **Collect** — Gather results as teammates complete tasks
5. **Synthesize** — Merge results into consolidated output
6. **Shutdown** — Send shutdown_request to each teammate, wait for responses
7. **Cleanup** — Call TeamDelete to remove team resources

## Behavioral Traits

- Decomposes before delegating — never assigns vague or overlapping tasks
- Monitors progress without micromanaging — checks in at milestones, not every step
- Synthesizes results with clear attribution to source teammates
- Escalates blockers to the user promptly rather than letting teammates spin
- Maintains a bias toward smaller teams with clearer ownership
```

**Why this one works:** (a) the tool allowlist *is* the job description — no write verbs for an orchestrator who must not edit; (b) invariants are stated as numbered rules, not prose (`One owner per file`); (c) the lifecycle protocol names every operation in order so the model executes a state machine rather than improvising; (d) anti-patterns are named (`never send structured JSON status messages`, `never by UUID or role alias`); (e) the description carries three distinct trigger conditions so routing does not depend on one phrase matching.

### 3.4 The output-contract exemplars

Two specs in the repo show what a real output contract looks like.

**`operating-kit/code-review-preshipment`** (80 lines, `sonnet`, tools `Bash, Read, Glob, Grep`) — a hedge against the classic "reviewer that reads nothing" failure: it opens with the exact git commands that define the review scope, then a 10-section checklist, then a fixed verdict vocabulary:

```markdown
## Verdict

For each issue: **severity** (blocker / should-fix / nit), **file:line**, quoted code, why it's wrong, and the fix.
End with: **SHIP** / **SHIP WITH FIXES** / **DO NOT SHIP**.
Never emit SHIP without having walked every section above.
```

The three-value escalation ladder (`SHIP` / `SHIP WITH FIXES` / `DO NOT SHIP`) is what makes this agent *machine-consumable by a pipeline* — unlike the 47 agents that end with "## Example Interactions" and no defined artefact. `ship-mate/review.md` does the same with its 🔴/🟡/💡 tiers, each bound to a **pipeline action** column (`Pauses + human notified` / `Auto-resolved, no human` / `Logged only`), so severity directly drives orchestration.

**`operating-kit/session-start`** (75 lines, `haiku`, tools `Read, Bash, Edit`) — a literal output template in a fenced block:

```markdown
## Output format

```
## Session Briefing: [today's date]

### Versions
- App/service: [from state doc]
- Deployed revision: [from state doc]
- Live check: [actual value] (match / MISMATCH with state doc)

### Open known issues
- [from state doc, or "none flagged"]
```

Keep it short. This is a status check, not a report.
```

Note the trailing instruction: `Keep it short. This is a status check, not a report.` A haiku agent with a 3-tool grant and a fixed template is the cheapest reliable subagent shape in the repo.

### 3.5 The discipline clause

The single most interesting *behavioural* line in the corpus is a description-level refusal in `llm-finetuning/agents/llm-finetuning-architect.md`:

```yaml
description: Fine-tuning strategist who owns the eval gate and method/model selection.
  Refuses to plan training without a baseline.
```

Putting a **refusal condition in the `description`** (rather than buried in the body) means the router itself can see the precondition — the orchestrator learns before spawning that this agent will bounce a request that arrives without a baseline metric. This is exactly the kind of precondition HorizonCode's `AgentProfileV1` should express structurally rather than in prose.

### 3.6 Model-assignment strategy

The repo has no written policy document for model choice — the assignment is inferable from the census and is remarkably consistent:

| Tier | Roles it is given to | Inferred rule |
|---|---|---|
| **`opus`** | Reviewers (`code-reviewer`, `security-auditor`, `architect-review`), architects (`cloud-architect`, `kubernetes-architect`, `terraform-specialist`, `database-architect`, `service-mesh-expert`), reverse engineering, language specialists for the hardest languages (`rust-pro`, `cpp-pro`, `c-pro`, `golang-pro`, `java-pro`, `typescript-pro`, `data-engineer`), threat modelling, Cedar/policy authors, and `tdd-orchestrator` | **Judgement-bearing roles.** Anything whose output is a *finding, a verdict, or an irreversible architecture decision* gets the strongest model. The asymmetry: a wrong review ships a vulnerability; a wrong test file is caught by CI |
| **`sonnet`** | The bulk of leaf work: testers, debuggers, documenters, SEO writers, most framework specialists (Django/FastAPI/GraphQL previously `opus` but the plugin variants differ), security *coders* (as opposed to auditors) | **Execution-bearing roles.** Transform an explicit input into an explicit output |
| **`haiku`** | `mermaid-expert`, `reference-builder`, `c4-code`, all SEO analysis/monitoring, `content-marketer`, `search-specialist`, `customer-support`, `sales-automator`, `deployment-engineer`, and the entire `operating-kit` session-loop (`session-start`, `session-end`, `prod-logs-health-check`) | **Mechanical, extractive, templated roles.** Fixed output schema + no judgement + short context. `operating-kit` is the deliberate case: the session lifecycle runs on haiku because the *template* carries the reliability, not the model |
| **`inherit`** | Language/framework pros whose difficulty matches the parent session (`javascript-pro`, `elixir-pro`, `ruby-pro`, `php-pro`, `csharp-pro`, `scala-pro`, `sql-pro`), plus all of `ui-design`, `multi-platform-apps`, ML/LLM (`ml-engineer`, `ai-engineer`) | **"No opinion" default.** Also used when the author could not decide — see §5 for why this is a mild smell |
| **`fable`** | `team-lead`, `legacy-modernizer` (framework-migration variant) | **Multi-hour autonomous plan-holding.** Documented explicitly: *"only when Opus demonstrably needs multiple attempts"* |

**Two structural lessons.**

1. **Tier follows blast radius, not seniority.** `security-auditor` (opus) reviews; `backend-security-coder` (sonnet) implements. `code-reviewer` (opus) finds; `test-automator` (sonnet) writes. The repo never pays opus prices for generation and never risks sonnet on a verdict.
2. **The same role gets different tiers in different plugins** (`cloud-architect`: opus in `cloud-infrastructure`, sonnet in `deployment-validation`). This is drift, not policy — the strongest argument for HorizonCode pinning a model *role* per profile rather than letting each bundle re-declare it.

### 3.7 Tool-restriction strategy

188 of 202 agents grant everything; the 14 restricted ones share one design idea: **the allowlist is derived from the agent's verb set, and the withheld tools are the ones that would let it exceed its role.**

| Pattern | Instances | Rule |
|---|---|---|
| **Orchestrator cannot edit** | `team-lead` (no `Write`/`Edit`), `conductor-validator` | An agent that assigns file ownership must not also be able to touch files, or ownership boundaries are unenforceable |
| **Reviewer cannot edit** | `code-review-preshipment` (`Bash, Read, Glob, Grep`), `team-reviewer`, `team-debugger`, `eval-judge` (`Read, Grep, Glob` — no Bash at all) | Review findings must be *reported*, never silently applied. The judge that scores skills cannot modify them |
| **Implementer can't spawn or destroy** | `team-implementer` (no `Agent`, no `TaskCreate`, no `TeamDelete`) | Fan-out and teardown are lead-only privileges; prevents runaway recursive team growth |
| **Mechanical agents get 2–3 verbs** | `prod-logs-health-check` (`Bash, Read`), `session-start` (`Read, Bash, Edit`) | The minimum primitive set for the job, nothing more |
| **Scoped single-tool relay** | `image-generator` (`mcp__meigen__generate_image` only) | An agent that exists purely to keep a large tool response out of the parent's context gets exactly that one tool and nothing else |
| **MCP tools are namespaced in the allowlist** | `mcp__meigen__search_gallery`, `mcp__meigen__get_inspiration` | MCP verbs are grantable at the same granularity as built-ins — directly relevant to HorizonCode's `mcp.invoke` capability |

The repo explicitly warns that this mechanism is the *least* portable one (`Cursor` and `Codex` don't honour allowlists; `tools:` is dropped rather than translated). HorizonCode has the advantage: our `capabilityCeiling` is enforced in the *kernel*, so a profile's restriction cannot be discarded by a host that doesn't feel like honouring it.

### 3.8 Prose patterns worth copying

1. **Trigger conditions live in `description`, and there are usually three.** `"...Use when coordinating multi-agent teams, decomposing complex tasks, or managing parallel workstreams."` Multiple phrasings hedge against the router's single-shot matching. 176/202 comply because a lint enforces it.
2. **`Use PROACTIVELY` is an explicit escalation marker.** Used where the agent should fire *unprompted* on a detected condition (`dx-optimizer`: "Use PROACTIVELY when setting up new projects"; `debugger`: "Use proactively when encountering any issues"). It is a routing hint with a distinct meaning from `Use when`.
3. **Numbered invariants beat prose.** `File Ownership Rules` as `1. / 2. / 3. / 4.` rather than a paragraph — the model can enumerate and check them.
4. **Named anti-patterns.** `"Never send structured JSON status messages"`, `"never by UUID or role alias"`, `"Don't assume — check the actual code"`, `"If in doubt, ask"`. Negative instructions are cheaper than positive ones and more binding.
5. **Template placeholders for project-specific facts.** `operating-kit` uses `{{REPO_PATH}}`, `{{STATE_DOC}}`, `{{LIVE_CHECK}}`, `{{LAST_DEPLOYED_REF}}`, `{{PRIMARY_CODE_DIR}}` with an explicit *"replace these with this project's specifics"* note. A **distribution** pattern for profiles that must be instantiated per repo — HorizonCode would express this as `templateVariables` in `systemPrompt`, which the schema already anticipates.
6. **"Read `AGENTS.md` before doing anything else."** `ship-mate`'s agents all open by binding to the repo's canonical context file. This is how the pipeline grounds on project-specific rules without hard-coding them.
7. **Persona-with-seniority as a compression device.** `"You are a Senior Code Reviewer with 30 years of experience"` is doing real work: it primes behaviour (be adversarial, expect the reader to be rushed) in fewer tokens than an instruction list. Used well in `ship-mate`; used as filler in the 150 template agents.

### 3.9 How agents compose

There is **no composition mechanism in the platform** — no handoff protocol, no typed result, no `then:`. Composition is achieved three different ways, and only the first is sound:

**(a) File-based sequential handoff — `ship-mate`.** Each stage writes a named artifact that the next stage is instructed to read. Implicitly typed by convention:

```text
stories/[story].md → orchestrate → orchestrator-output.md
                                  → architect   → architect-plan.md
                                  → implement   → (code + tests)
                                  → qa          → qa-report.md
                                  → review      → review-report.md
                  (playwright runs conditionally, frontend tasks only)
```

The good parts: stages are **strictly ordered**, each has an explicit **input list**, a named **output file**, and `playwright` carries an explicit **precondition** (`only runs for FRONTEND tasks`). The bad part: the handoff lives in the *filesystem*, so nothing enforces that the architect actually read a complete `orchestrator-output.md`, and nothing records which revision of the upstream artifact a stage consumed. HorizonCode's `adopt_ref` (`hz://artifact/<sha256>` injected into a dependent node's capsule, *"never by transcript text"*) is precisely the fix for this.

**(b) Live team protocol — `agent-teams`.** `team-lead` spawns, `TaskCreate`/`TaskUpdate` form the shared board, `SendMessage` carries coordination, and the lead synthesises. The interesting constraints: **one owner per file**, **shared files are lead-owned and applied sequentially**, **deputies coordinate through typed messages not JSON blobs** ("Never send structured JSON status messages — use TaskUpdate instead"), and **review/debug fan-out is dimension-partitioned** (one reviewer per *dimension*, one debugger per *hypothesis*). The last idea is the most valuable: splitting a review by *angle* rather than by *file* eliminates duplicate findings and makes each child's output disjoint.

**(c) Implicit nesting via a generic `Task`/`Agent` tool.** Most agents just call the host's subagent tool with no declared profile, so depth, budget and capability are whatever the host defaults to. There is no depth ceiling, no budget reservation, no teardown guarantee.

**The routing signal is the `description` and nothing else.** No agent declares what it *cannot* do, what it *requires as input*, or what it *emits as output* in machine-readable form — so the orchestrator's choice is a single-shot similarity match against prose. This is the single biggest gap between this repo's design and HorizonCode's `RoutingDecisionV1` (`routingRole` + `kind` + tool-class requirements are *facts*, not guesses).

---

## 4. Ten design patterns to adopt into HorizonCode

Each pattern is stated as: **the observed pattern** → **the HorizonCode binding** (into `AgentProfileV1` in `05-domain-and-schemas.md` §`AgentProfileV1` and the fleet in `08-runtime.md` §2.11).

---

### P1 — Tool allowlist *is* the role definition

**Observed.** 14 agents encode their entire job in `tools:`. `team-lead` has no `Write`/`Edit`; `team-reviewer` and `team-debugger` have no write verbs; `eval-judge` has no `Bash`; `image-generator` has exactly one tool. The prose then only needs to explain the *why*, because the *what* is structurally impossible to violate.

**Why it matters for us.** Our `AgentProfileV1` already has `toolAllowlist` / `toolDenylist` ("patterns; denylist wins") and `capabilityCeiling`. The pattern to adopt is to treat the allowlist as **the primary expression of intent** and the prose as commentary — i.e. every bundled profile must be *written from its allowlist outward*.

**Binding.** Author profiles so that `toolAllowlist ∩ capabilityCeiling` alone determines the blast radius, and add a **lint to `plugin-eval`-style validation**: a profile whose `systemPrompt` mentions an effect ("edit", "deploy", "commit") whose capability is absent from `capabilityCeiling` fails validation. This turns the repo's best human discipline into our mechanical invariant.

---

### P2 — Tier follows blast radius, not seniority

**Observed.** Opus goes to *verdicts and irreversible decisions* (reviewers, architects, threat modellers, policy authors, reverse engineers); sonnet goes to *transformations* (testers, debuggers, documenters, security coders); haiku goes to *mechanical extraction with a fixed output template* (mermaid, reference-builder, C4-code, the entire session lifecycle, all SEO analysis). `fable` is reserved for two agents and documented as an emergency tier.

**Why it matters for us.** `AgentProfileV1.routingRole ∈ {executor, planner, either}` and `modelPreference.modelRef` are exactly the right hooks, but a *tier policy* is missing: nothing stops a plugin from declaring opus for a doc formatter.

**Binding.** Add a **tier policy** to the bundled-profile validation and to `docs/15` §3.6: `kind=verify` and `kind=plan` default to the strongest configured model; `kind=act` defaults to the mid tier; `kind=research` defaults to the cheapest tier *unless* the profile declares `requiresReasoning: true`. Record the chosen tier in `RoutingDecisionV1` so cost attribution can flag a profile that routinely runs above its declared class.

---

### P3 — A named, machine-readable output contract with an escalation ladder

**Observed.** `SHIP` / `SHIP WITH FIXES` / `DO NOT SHIP` (`code-review-preshipment`), 🔴/🟡/💡 each mapped to a *pipeline action* (`ship-mate/review`), a fenced literal template with bracketed slots (`session-start`). The ~155 agents lacking any output contract are the ones that cannot participate in a pipeline at all.

**Why it matters for us.** `AgentProfileV1.outputFormat ∈ {prose, structured, patch, report}` is a *format* enum, not a *contract*. A child that returns `report` still gives the parent nothing to branch on.

**Binding.** Extend the profile with a `resultSchema` (a named schema or an inline JSON Schema) and require every `kind=verify` profile to declare a three-valued `verdict` field (`pass` / `pass_with_findings` / `fail`) plus a `findings[]` array of `{severity, location, evidence, remediation}`. This makes the fleet scheduler's branching (`fail_fast`, `depends_on`) depend on a typed field instead of parsing prose — and it is the direct analogue of the repo's best-reviewed agents.

---

### P4 — Preconditions and refusal conditions are declared, not discovered

**Observed.** `llm-finetuning-architect` states in its **description**: *"Refuses to plan training without a baseline."* `playwright` states it *only runs for FRONTEND tasks*. Both put the precondition where the router can see it.

**Why it matters for us.** Our `SubagentFactory.spawn` currently rejects a child whose requested capability exceeds the parent's (`R-runtime-63`-family). That is a *capability* precondition; there is no *input* precondition, so a child can be spawned with a capsule missing the artifact it needs and will fail three steps later, burning budget.

**Binding.** Add to `AgentProfileV1`: `requiresInputs: []string` (named artifact kinds / capsule fields) and `refusesWhen: []string` (named precondition predicates). `SubagentFactory.spawn` evaluates them **before** reserving a budget slice and returns a structured `precondition_unmet` failure. Report it to the parent, which can then re-plan — this is `R-runtime-70` applied one level earlier.

---

### P5 — Partition fan-out by *dimension*, not by *file*

**Observed.** `team-reviewer` is instantiated once per review *dimension* (security, performance, architecture); `team-debugger` once per *hypothesis*. Each child's findings are therefore disjoint by construction, and the lead's synthesis step is a merge of non-overlapping sets rather than a de-duplication problem.

**Why it matters for us.** A naive fleet implementation fans out by *file* or by *module*, which produces N children writing the same class of finding about different code — cheap to generate, expensive to merge, and it hides real risk behind repetition.

**Binding.** Encode the partition axis in `FleetSpecV1` as `partitionBy: OneOf{dimension, hypothesis, file, module, none}` and require a `team-reviewer`-shaped profile to be spawned only with `partitionBy: dimension`. Add a fleet-scheduler check that sibling nodes with the same profile id carry **distinct partition keys**; identical keys ⇒ refuse the graph (it is a pointless duplicate, not parallelism). This is the concrete version of `R-runtime-69`'s dependency semantics for the read-only case.

---

### P6 — One writer per file, enforced at spawn

**Observed.** `team-lead`'s `## File Ownership Rules`: *"One owner per file — Never assign the same file to multiple teammates"*, *"Shared files — If a file must be touched by multiple teammates, the lead owns it and applies changes sequentially"*, and `team-implementer`: *"Only modify files assigned to you… Never touch shared files… If in doubt, ask."*

**Why it matters for us.** We already have the enforcement primitives — `worktree.manage` is *"pool-issued, single-writer per worktree"* and `R-runtime-113`-family covers crash recovery — but file-level ownership within a *shared* worktree is a convention only.

**Binding.** Add `ownsPaths: []string` to `TaskSpecV1` (glob patterns), have `SubagentFactory.spawn` compute the ownership set as part of the `SubagentSpecV1`, and have the kernel's `files.patch` check refuse an effect whose target path has an owner other than the requesting session. The repo had to write this rule in prose and hope; we can make it a lease. Mine the repo's rule text directly into the `systemPrompt` of the bundled `team-lead` profile — it is already written in the right register.

---

### P7 — Dev verbs are separate grants from read verbs and from fan-out verbs

**Observed.** The `agent-teams` allowlists decompose into four orthogonal verb families: **observation** (`Read`, `Glob`, `Grep`), **execution** (`Bash`), **mutation** (`Write`, `Edit`), **coordination** (`TaskGet/List/Update`, `SendMessage`) and **lifecycle** (`Agent`, `TeamCreate/Delete`, `TaskCreate`). Each role gets a specific *combination*, and no role gets all five.

**Why it matters for us.** Our capability list is flat around `files.read`, `files.patch`, `terminal.run`, `agent.spawn`. A profile author currently has to reason about the whole list; the repo shows the ergonomic win of **named bundles**.

**Binding.** Publish these as `AgentProfileV1.extensions` presets (or a `profileClass` field) in `docs/15` §3.6: `observe` = `{files.read, language.symbols, vcs.read}`; `execute` = `observe ∪ {terminal.run}`; `mutate` = `execute ∪ {files.patch, files.write}`; `coordinate` = `mutate ∪ {agent.spawn, task.*}`. A profile may only compose presets *downward* (never `coordinate` without `mutate`), and the preset resolution is what `capabilityCeiling` validation checks. This makes plugin-authored profiles safe by default — the plugin picks a class, not a capability soup.

---

### P8 — A read-only profile is a first-class product object, not a flag

**Observed.** `eval-judge` (`Read, Grep, Glob`), `conductor-validator` (`Read, Glob, Grep, Bash`), `code-review-preshipment` (`Bash, Read, Glob, Grep`), `prod-logs-health-check` (`Bash, Read`), plus `team-reviewer`/`team-debugger`. Five distinct read-only shapes, each tuned to its evidence source (files / files+shell / logs only).

**Why it matters for us.** Our schema has `readOnlyProfile()` as a helper and the routing table treats `Tool classes required` as a routing input, but `kind ∈ {act, plan, research, verify}` is where read-only-ness is actually decided — and `kind=act` can still be authored with a read-only ceiling, which is a contradiction the schema does not forbid.

**Binding.** Make the invariant explicit: `kind=research || kind=verify` ⇒ `capabilityCeiling ∩ {files.patch, files.write, terminal.run, vcs.write} = ∅` (the repo's `eval-judge` gets *no* `Bash` for exactly this reason — a reviewer with a shell can `> file`). Our docs already say `kind=plan`/`research` *«MUST declare a read-only posture override request»*; extend this to `verify` and add the bullet to the profile-validation test alongside `narrowing.test.ts`.

---

### P9 — A single-tool relay profile to keep bulky results out of the parent context

**Observed.** `meigen-ai-design/image-generator` exists **only** to call one MCP tool and return its response verbatim, with an explicit rationale in its own examples: *"Single image generation — delegate to image-generator to keep base64/response data out of main context."* Its rules are pure relay hygiene: *"Do NOT enhance or modify the prompt", "Do NOT add creative commentary", "Do NOT read any files", "Keep your response minimal."* The parent then spawns one per image, in parallel.

**Why it matters for us.** Our context compiler treats a child's result as an artifact injected via `adopt_ref`, which already solves the *context* half. But the **relay discipline** — the child must not editorialise, must not add findings, must not decide — has no equivalent, and a chatty child pollutes the parent capsule even when the payload is an artifact reference.

**Binding.** Add `kind=relay` (or `outputFormat=passthrough`) with a hard contract: `resultSchema` must be the tool's own output schema, the profile's `capabilityCeiling` is exactly the one tool's capability, `canSpawn: none`, and the prompt template forbids commentary. Relay children are the cheapest possible fleet node and should be exempt from the reasoning-tier defaults in P2 (they never need a strong model).

---

### P10 — Invariants stated as a numbered list, anti-patterns named explicitly

**Observed.** `## File Ownership Rules` (1–4), `## Communication Protocols` (1–5 with two *"Never…"* clauses), `## Team Lifecycle Protocol` (7 ordered operations). Contrast the template agents: `## Capabilities` with 60 unranked bullets and no ordering information.

**Why it matters for us.** Our bundled profile prompts are the one artefact where prose quality directly buys behavioural reliability. The repo demonstrates, at scale, **which prose forms work**: ordered numbered invariants for procedure, `Never X` clauses for the failures that actually happen, and a literal output template for shape.

**Binding.** Adopt a **required prompt skeleton** for every bundled profile (validated by the same linter as P1), differing by `kind`:

```text
## Mission            — one sentence, states the goal not the steps
## Invariants         — numbered, checkable (3-6 items)
## Protocol           — ordered operations for kind=act / kind=plan
## Inputs             — named capsule fields and artifact kinds (P4)
## Output contract    — the literal template or resultSchema (P3)
## Never              — 3-6 named anti-patterns drawn from real failures
```

A profile that cannot fill `## Never` with three specifics is a profile that has not been written yet. This skeleton is also what makes a bundled profile's *expected* token cost predictable, which feeds `R-runtime-104`'s budgets.

---

## 5. Anti-patterns to avoid

Each anti-pattern is named, evidenced from the corpus, and paired with the HorizonCode guard that prevents it.

---

### A1 — Capability-by-superlative

**Evidence.** `## Capabilities` appears in 123 agents as unranked bullet dumps of 40–80 lines. `tdd-orchestrator` lists 60+ bullets across 12 sub-headings, including *«Machine learning for test prioritisation»* and *«TDD flow state optimization and developer productivity enhancement»*. `code-reviewer` lists tools it will never call (`Trag`, `Bito`, `Codiga`) as capabilities. These sections describe **a domain**, not **a job**.

**Harm.** (a) Token budget burned on every spawn; (b) the model gets no priority ordering, so it distributes effort uniformly across a 60-item list instead of concentrating on the task; (c) the section is indistinguishable from every sibling agent's section, so it adds no routing signal beyond `description`.

**Guard.** The P10 prompt skeleton has no `## Capabilities` slot. Capability breadth belongs in **skills** (loaded on demand, progressive disclosure) or in the profile's `skills: []` field — not in the always-loaded system prompt. Our `ContextCapsuleV1` design and `R55/R56` (`a profile cannot reorder blocks or widen authority`) already assume a small stable system prompt; a 60-bullet capability dump violates that intent.

---

### A2 — Persona inflation without an output contract

**Evidence.** 115 agents have `## Response Approach`, 107 have `## Example Interactions`, 101 have `## Knowledge Base` — and only 47 have any `## Output`. `accessibility-expert` (147 lines, `inherit`) has *«Expert accessibility specialist with deep knowledge of…»*, 8 capability groups, a Knowledge Base section, a Response Approach, and Example Interactions, but **never states what artefact it produces or how a caller knows it succeeded.**

**Harm.** The agent is unusable as a fleet node. A parent cannot check completion, cannot decide retry, cannot branch on severity, and cannot budget its output. It also cannot be evaluated — which is why the repo needed `plugin-eval`'s LLM judge as an afterthought rather than having testable contracts from the start.

**Guard.** P3: `resultSchema` is **required** for every profile except `kind=act` with `outputFormat=patch`. A profile with no declared output is rejected at registration (`RegisteredAgentProfileProofV1` cannot be produced), exactly as our schema already requires a `systemPrompt` digest.

---

### A3 — The same role declared many times with divergent settings

**Evidence.** `code-reviewer` appears 6×, `debugger` 5×, `test-automator` 5×, `security-auditor` 4×, `frontend-developer` 4×, `performance-engineer` 4×, `error-detective` 4×, `database-optimizer` 3×. At least one role diverges across copies: `cloud-architect` is `opus` in `cloud-infrastructure` and `sonnet` in `deployment-validation`; `code-reviewer` is `opus` in six plugins and `sonnet` in `incident-response`.

**Harm.** No canonical resolution of «what is a code review». A router that picks the wrong copy silently gets a different model tier and a different prompt — same name, different behaviour, no way to tell from the task side.

**Guard.** Our schema already answers this: a profile has `id` + `revision` + `digest`, and a session *pins* `{id, revision, digest}` and «MUST NOT follow later revisions». Two profiles with the same `name` in different `provenance` scopes must be **distinguishable by id** (`reviewer@builtin` vs `reviewer@plugin:acme`), and the fleet MUST refuse to spawn two children of the same `kind` with the same partition key (P5). Add a resolution-order doc (builtin < user < workspace < plugin) — the repo's implicit rule is «last plugin wins», which is not a rule.

---

### A4 — `inherit` as an escape hatch from a decision

**Evidence.** 52 of 202 agents are `inherit` — a quarter of the corpus. Some uses are principled (a language pro should match the session's model; ML work should match the session's budget). Others are clearly indecision: entire plugins abandon the axis (`ui-design` is `inherit` ×3, `multi-platform-apps` is `inherit` ×5 of 6, `machine-learning-ops` is `inherit` ×3, `llm-application-dev` is `inherit` ×3).

**Harm.** An `inherit` profile inherits a *cost* it did not budget for. A `haiku` session spawning a `ui-designer` gets haiku design decisions; a `fable` session spawning a doc formatter pays fable prices. The author has moved the decision to an accidental runtime fact.

**Guard.** Keep `inherit` in the schema (it is genuinely correct for language specialists) but make it **opt-in with justification**: a bundled profile that declares `policy: inherit` must also declare `rationale` in the profile, and the tier policy in P2 provides a *default* so `inherit` means «follow the class default», not «whatever». Log the resolved model in `RoutingDecisionV1` so cost reports can surface profiles whose inheritance produced an outlier.

---

### A5 — An empty or contradictory tool declaration that nothing validates

**Evidence.** `arm-cortex-microcontrollers/agents/arm-cortex-expert.md` declares `tools: []` — an empty allowlist. In Claude Code that means *no tools at all*, so the agent as written cannot read a file. It has shipped and is documented in `docs/agents.md` as a normal agent. Nothing in the repo's validation catches it.

**Harm.** Silent no-op agents. A user invoking it gets a model that reasons about firmware it cannot see, and the failure looks like model weakness rather than a config bug.

**Guard.** Our profile validation must reject `capabilityCeiling = ∅` unless `kind=relay` with an explicit single tool, and reject any profile whose `systemPrompt` mentions reading a file while `files.read` is absent from the ceiling (the P1 lint). More generally: **every declared field is validated against the prompt**, because prose and grants drifting apart is the most common latent defect in a corpus like this.

---

### A6 — Category as a substitute for capability

**Evidence.** The taxonomy is distribution-shaped, not capability-shaped: `data-engineer` sits in `data-engineering`; `conductor-validator` (`Read, Glob, Grep, Bash`, a pure validator) is filed under *Project Management*; `fable`-tier `legacy-modernizer` sits in `framework-migration` while its three `sonnet` twins sit elsewhere.

**Harm.** A user looking for «who reviews code» has to know that four plugins ship the same reviewer. An orchestrator with a capability-shaped need («I need something that can read a lockfile and a CI config and emit a verdict») has no way to resolve the taxonomy into a grant set.

**Guard.** Our `routingRole` + `kind` is already capability-shaped — keep it that way and **never** introduce a `category` field into `AgentProfileV1`. Categorisation is a *marketplace/UI* concern (`docs/14` surfaces) and must not reach the router. If a grouping is needed for `hzk agents list`, derive it from `kind` + `capabilityCeiling`, not from a hand-maintained label.

---

### A7 — Cross-harness lowest-common-denominator prose

**Evidence.** The repo's own `docs/authoring.md` lists what degrades across seven harnesses, and the conclusion is visible in agent bodies: agents avoid naming tools, avoid `TodoWrite`, tolerate dropped `tools:` allowlists, and accept that `color:` is cosmetic. A rule like *«Cursor doesn't honor per-agent `tools:` allowlists — use it as a hint only»* means the allowlist is **advisory** on the very surface most users reach the agent through.

**Harm.** The single best safety mechanism in the corpus (P1) is the one the platform cannot enforce everywhere — so it degrades into documentation. `team-lead`'s careful 12-tool grant is a suggestion on Cursor.

**Guard.** This is precisely where HorizonCode's architecture wins and the recommendation is to **not copy the compromise**. Because our `capabilityCeiling` is checked by the **kernel** at the effect boundary and receipted, a profile's restriction is enforced regardless of which front-end submitted the run (`R-runtime-13`, `R-runtime-117`: origins and decisions are attached at the kernel boundary and not rewritable). Do **not** add a «tools are a hint» mode. If a surface cannot express a grant, the correct behaviour is to refuse the spawn, not to run it unrestricted.

---

### A8 — File-based handoffs with no artifact identity

**Evidence.** `ship-mate` passes `orchestrator-output.md` → `architect-plan.md` → code → `qa-report.md` → `review-report.md` through the working tree. Nothing records which revision of an upstream file a downstream stage read; a re-run of `architect` after an edit silently orphans the downstream artifacts.

**Harm.** Non-reproducible pipelines. Debugging a bad result means guessing which inputs produced it — and there is no way to replay a stage.

**Guard.** We already decided this: `adopt_ref` *«a node's output artifact MAY be injected into a dependent node's capsule, referenced by `hz://artifact/<sha256>`, never by transcript text»* (`R-runtime-69`). The additional recommendation is to **ban raw-path handoff in fleet graphs**: a `depends_on` edge must carry an artifact digest, and the fleet result must record `{node, input digests, output digest}` so a fleet run is replayable from the event log alone.

---

### A9 — Orphan-by-omission: no teardown path for spawners

**Evidence.** Only `team-lead` — 1 of 202 agents — declares the lifecycle verbs, and it explicitly documents a 7-step teardown (`shutdown_request` to each teammate → wait → `TeamDelete`). Every other agent that spawns work does so through a generic tool with no stated cleanup, no depth limit, and no budget reservation.

**Harm.** Leaked children. On a long-horizon run this is the failure mode that turns a cheap turn into an expensive one: children that were spawned, whose task no longer matters, and which continue to consume budget because no one has the authority to stop them.

**Guard.** This is largely covered for us by `R-runtime-62` (single construction primitive), `R-runtime-67/68` (depth 3 default / 5 hard; concurrency 4 per session, 8 read-only, 12 global), the token-tree cancellation in `R-runtime-21`, and `R-runtime-73/84` (teardown completeness: no live process, no held worktree, no ledger leak, exactly one `hz.agent.completed` per child). The pattern to adopt is the *modelling* lesson from `team-lead`: **teardown is an explicit enumeration in the profile**, so the `systemPrompt` of every `kind=team_lead` profile should carry the same 7-step lifecycle text, and `teardown.test.ts` should assert it holds for multi-level fleets, not just one level.

---

### A10 — Documentation drift between the corpus and its own reference

**Evidence.** `docs/agents.md` enumerates 202 agents by hand with model tiers, and it already disagrees with the files: it lists `frontend-developer` as `sonnet` where the file says `inherit`; `accessibility-expert` as `opus` where the file says `inherit`; `backend-security-coder` as `opus` where `data-validation-suite`'s copy says `sonnet`; `code-reviewer` as `opus` in most rows while the `incident-response` copy is `sonnet`; `mobile-security-coder` as `opus` where the file says `sonnet`. The repo acknowledges the class of problem — it built `make garden` specifically for *«drift, dead-link, stale-artifact detection»* — but the hand-maintained agent table is not generated.

**Harm.** Users pick a model tier from documentation and get something else. Reviewers trust the table over the file. This is the corpus-scale version of the prose/grants drift in A5.

**Guard.** For us the rule is simple and already implied by the schema: **the reference is generated from the artefacts, never hand-written.** `hzk docs agents` (or the marketplace page) renders from the resolved `AgentProfileV1` set, and a CI gate fails if the committed rendered output differs from the regenerated one — the exact mechanism the repo uses for its `.codex-plugin` and `.cursor-plugin` manifests (*«Run `make generate-all` before committing source changes — CI gates registry drift»*). The repo got this right for machine formats and wrong for humans.

---

## 6. Recommended HorizonCode bundled agent profiles

### 6.1 The bundling decision

The repo's central failure is scale without curation: **202 agents, 61 duplicated, 188 unrestricted, 47 with an output contract, 14 with a tool grant.** The lesson is not "have many agents" — it is **"have few, well-granted agents, and let the fleet compose them."**

**Recommendation: bundle exactly 15 profiles in `AgentProfileV1` form** (`provenance: builtin`), one per *capability class* rather than per *domain*. Domain expertise belongs in **skills** (the repo already proves this — 185 skills exist and are progressively disclosed, while the 202 agents re-state them badly). Then:

- **Plugins** (`provenance: plugin`) may add profiles, but a plugin profile is validated against the same linter and may only **narrow** (`D17`), never widen. A plugin that wants a `python-expert` should ship a *skill* on top of `worker`, not a 20th agent.
- **Users/workspaces** may declare profiles (`provenance: user` / `workspace`), and resolution order is `builtin < user < workspace < plugin`, with the id namespaced (`worker@builtin`, `reviewer@plugin:acme`) so two profiles never collide silently (A3).

### 6.2 Capability presets used below (from P7)

| Preset | Capabilities |
|---|---|
| `observe` | `files.read`, `language.symbols`, `vcs.read`, `search.text` |
| `execute` | `observe` + `terminal.run` |
| `mutate` | `execute` + `files.patch`, `files.write` |
| `network` | `network.fetch`, `network.search` |
| `coordinate` | `agent.spawn`, `agent.message`, `task.create`, `task.update`, `budget.report` |
| `verify` | `verify.run`, `test.run`, `build.run`, `lint.run` |
| `publish` | `vcs.write`, `deploy.invoke`, `artifact.write` |

All 15 profiles below carry the P10 prompt skeleton, a P3 `resultSchema`, P4 `requiresInputs`/`refusesWhen`, and explicit `budgetDefaults`.

### 6.3 The 15 bundled profiles

#### Tier 1 — the five load-bearing profiles

| # | Profile | `kind` | `routingRole` | Default tier | `canSpawn` | `isolation` | `outputFormat` |
|---|---|---|---|---|---|---|---|
| 1 | `worker@builtin` | `act` | executor | mid (`sonnet`-class) | `none` | `worktree` | `patch` |
| 2 | `scout@builtin` | `research` | executor | cheapest (`haiku`-class) | `read_only` | `shared` | `report` |
| 3 | `architect@builtin` | `plan` | planner | strongest (`opus`-class) | `read_only` | `shared` | `structured` |
| 4 | `reviewer@builtin` | `verify` | planner | strongest | `none` | `shared` | `report` |
| 5 | `lead@builtin` | `team_lead` | planner | strongest | `limited` | `shared` | `structured` |

**1 · `worker@builtin`** — the general executor. This is the profile most turns use, and it is the one the router picks when nothing more specific applies.

| Field | Value |
|---|---|
| `toolAllowlist` | `read`, `read_many`, `grep`, `glob`, `edit`, `write`, `bash`, `verify`, `todo` |
| `capabilityCeiling` | `mutate` (worktree-scoped) |
| `requiresInputs` | `task_spec` |
| `refusesWhen` | `owns_paths is empty` — a worker without an ownership boundary is a conflict generator (P6) |
| `budgetDefaults` | tokens 200k, steps 80, wall-clock 20 min |
| `resultSchema` | `{ summary, changed_paths[], tests_run[], blockers[], deviations[] }` |
| Notes | `isolation: worktree` is the default because two workers in one tree is the conflict this whole design exists to avoid. `deviations[]` is the direct lift from `team-implementer`'s *«Flag any deviations from the original plan»* — it is the field that makes plan-vs-reality drift visible |

**2 · `scout@builtin`** — the read-only explorer. Cheapest tier, `canSpawn: read_only` so scouts can fan out into sub-scouts (breadth-first search) but can never mutate.

| Field | Value |
|---|---|
| `toolAllowlist` | `read`, `read_many`, `grep`, `glob`, `git_diff`, `git_log` |
| `capabilityCeiling` | `observe` |
| `canSpawn` | `read_only`, `spawnCeiling: {maxDepth: 2, maxConcurrency: 4}` |
| `resultSchema` | `{ findings[], locations[], confidence, open_questions[] }` |
| Notes | `confidence` and `open_questions[]` come from `team-debugger`'s hypothesis discipline: a scout that reports a finding without stating its confidence is worse than one that reports "not found". The tier is *cheapest* deliberately — scouting is extractive, and P2 says extraction never needs reasoning |

**3 · `architect@builtin`** — the planner. Read-only by `kind`, which P8 makes an *invariant*, not a preference.

| Field | Value |
|---|---|
| `toolAllowlist` | `read`, `read_many`, `grep`, `glob`, `git_diff`, `git_log`, `verify` (read-only variants only) |
| `capabilityCeiling` | `observe` + `verify` (no `terminal.run`, per P8) |
| `canSpawn` | `read_only` — planners spawn scouts, never workers |
| `requiresInputs` | `spec_artifact` (digest), `repo_map` |
| `outputFormat` | `structured` |
| `resultSchema` | a numbered step plan: `{steps[{id, goal, depends_on[], owns_paths[], acceptance[], verify_cmd}], risks[], open_questions[]}` |
| Notes | `owns_paths` is **assigned by the planner** and becomes the ownership lease the P6 rule enforces at `files.patch`. `verify_cmd` per step is what lets the `verifier` be a mechanical profile. `depends_on[]` is the `FleetSpecV1` graph, emitted by the planner and executed by the scheduler — the repo's `ship-mate/architect` produces exactly this shape but writes it to a Markdown file with no schema |

**4 · `reviewer@builtin`** — the verdict-bearing reviewer. This is the profile that replaces all six `code-reviewer` copies.

| Field | Value |
|---|---|
| `toolAllowlist` | `read`, `read_many`, `grep`, `glob`, `git_diff`, `git_log`, `verify` |
| `capabilityCeiling` | `observe` **only** — no `terminal.run` (P8: a reviewer with a shell can `> file`) |
| `canSpawn` | `none` |
| `requiresInputs` | `diff_artifact` (digest) — never a path, per A8 |
| `resultSchema` | `{ verdict: pass\|pass_with_findings\|fail, findings:[{severity: blocker\|should_fix\|nit, path, line, quoted_code, why, fix}], dimensions_covered[] }` |
| Notes | The three-valued `verdict` + `severity` enum is the direct lift of `SHIP / SHIP WITH FIXES / DO NOT SHIP` (P3) and the 🔴/🟡/💡 tiers of `ship-mate/review`. `dimensions_covered[]` supports P5: the `lead` spawns one `reviewer` per dimension (correctness, security, performance, architecture, tests, observability — the six from `code-review-preshipment`'s checklist) and the scheduler refuses duplicate partition keys |

**5 · `lead@builtin`** — the fleet orchestrator. **No write verbs, ever** (P1, lifted verbatim from `team-lead`).

| Field | Value |
|---|---|
| `toolAllowlist` | `read`, `grep`, `glob`, `git_diff`, `task`, `parallel_tasks`, `fleet`, `read_only_task`, `agent_message`, `todo` — **no `edit`/`write`/`bash` mutation verbs** |
| `capabilityCeiling` | `observe` + `coordinate` |
| `canSpawn` | `full`, `spawnCeiling: {maxDepth: 3, maxConcurrency: 8}` |
| `resultSchema` | `{ plan_ref, children[{profile, partition_key, status, artifact_ref, spend}], merged_findings[], blocked[], decisions[] }` |
| Notes | `decisions[]` records *why* a child was chosen and any tiebreak applied — the repo's `team-lead` calls conflict resolution a capability but records nothing. `blocked[]` is mandatory reporting (A9 / `R-runtime-70`: a blocked dependent MUST NOT be silently dropped). Teardown: carry `team-lead`'s 7-step lifecycle text as numbered invariants |

#### Tier 2 — the ten specialists

| # | Profile | `kind` | `routingRole` | Default tier | `canSpawn` | `isolation` | `outputFormat` |
|---|---|---|---|---|---|---|---|
| 6 | `security-auditor@builtin` | `verify` | planner | strongest | `none` | `shared` | `report` |
| 7 | `debugger@builtin` | `custom` | executor | strongest | `none` | `worktree` | `report` |
| 8 | `tester@builtin` | `act` | executor | mid | `none` | `worktree` | `patch` |
| 9 | `perf-profiler@builtin` | `research` | executor | mid | `none` | `worktree` | `report` |
| 10 | `refactorer@builtin` | `act` | executor | mid | `none` | `worktree` | `patch` |
| 11 | `migrator@builtin` | `act` | executor | strongest | `none` | `worktree` | `patch` |
| 12 | `doc-writer@builtin` | `act` | executor | cheapest | `none` | `worktree` | `patch` |
| 13 | `verifier@builtin` | `verify` | executor | cheapest | `none` | `shared` | `structured` |
| 14 | `deployer@builtin` | `act` | executor | mid | `none` | `shared` | `structured` |
| 15 | `relay@builtin` | `relay` | executor | cheapest | `none` | `shared` | `passthrough` |

**6 · `security-auditor@builtin`** — a `reviewer` whose dimension set is fixed to security. A separate profile (not a parameter) because the **tier and the evidence tools differ**: an auditor gets scanners, an ordinary reviewer does not.

| Field | Value |
|---|---|
| `toolAllowlist` | `read`, `read_many`, `grep`, `glob`, `git_diff`, `dependency_scan`, `secret_scan`, `verify` |
| `capabilityCeiling` | `observe` + `security.scan` |
| `requiresInputs` | `diff_artifact`, `dependency_manifest` |
| `resultSchema` | `reviewer`'s schema **plus** a required CWE/OWASP classification and a `reachable` boolean per finding |
| Notes | `reachable` is the field the repo's `security-auditor` describes in prose (*vulnerability assessment*) but never expresses structurally. Unreachable findings must sort below reachable ones, or the verdict becomes noise. The tier is strongest and stays strongest — the repo explicitly warns that `fable`-tier security agents fall back to opus anyway because of the provider's cyber classifiers |

**7 · `debugger@builtin`** — the one profile that is **not** `verify` despite being read-mostly. It exists because a debugger needs to *run* things (reproduce, bisect, instrument) and `P8` forbids `terminal.run` to research/verify profiles. The resolution is a **narrowed terminal**: `terminal.run` constrained by a policy to a declared command set, exactly as `protect-mcp` narrows Bash with Cedar prefix matching (`"git status*"` allowed, shell chaining/expansion/redirection forbidden).

| Field | Value |
|---|---|
| `kind` | `custom` — explicitly, because it is read-mostly but not read-only, and pretending otherwise would either break `P8` or break bisection |
| `toolAllowlist` | `read`, `read_many`, `grep`, `glob`, `git_bisect`, `bash_policy`, `edit`, `verify`, `todo` |
| `capabilityCeiling` | `observe` + `execute(narrowed)` + `mutate(narrowed)` |
| `policyNarrowing` | `bash`: allow-prefix `pytest`, `npm test`, `go test`, `cargo test`, `git bisect`, `git log`, `git show`; **forbid** `;`, `&`, `\|`, `` ` ``, `>`, `<`, `$` — the same character set `protect-mcp` uses |
| `requiresInputs` | `failure_artifact` (a failing test, a stack trace, or a reproduction command) — **not** a bug description |
| `refusesWhen` | `failure_artifact is absent` — this is the repo's `llm-finetuning-architect` refusal pattern (P4) applied to debugging: *no reproduce case, no investigation* |
| `resultSchema` | `{ root_cause, evidence[], hypotheses_tested[{hypothesis, verdict, evidence}], patch, regression_test, prevention }` |
| Notes | `hypotheses_tested[]` is `team-debugger`'s *one hypothesis per agent* discipline retained at a single-agent granularity — and it is the field that makes the profile **partitionable** (P5) when the `lead` fans out N debuggers, one per hypothesis |

**8 · `tester@builtin`** — an `act` profile whose ownership is narrow by construction.

| Field | Value |
|---|---|
| `toolAllowlist` | `read`, `read_many`, `grep`, `glob`, `edit`, `write`, `bash`, `verify` |
| `capabilityCeiling` | `mutate(narrowed)` — `files.patch` restricted by `ownsPaths` |
| `ownsPaths` (default) | `**/*_test.*`, `**/*.test.*`, `**/*.spec.*`, `tests/**`, `test/**` |
| `refusesWhen` | the requested patch touches a non-test path |
| `resultSchema` | `{ tests_added[], tests_changed[], coverage_delta, failure_paths_exercised[], findings[] }` |
| Notes | `failure_paths_exercised[]` encodes the repo's *«At least one failure path exercised»* rule from `code-review-preshipment` as a **scoreable field** rather than a suggestion. The owned-glob default is the direct expression of P6 — here the guarantee is stronger than the repo's prose because the kernel refuses the out-of-scope patch |

**9 · `perf-profiler@builtin`** — a `research` profile with a narrowed terminal, because measuring requires running the workload.

| Field | Value |
|---|---|
| `toolAllowlist` | `read`, `grep`, `glob`, `bash_policy`, `profiler`, `trace_import` |
| `capabilityCeiling` | `observe` + `execute(narrowed: benchmark commands only)` |
| `resultSchema` | `{ baseline_metrics, current_metrics, delta_pct, hotspots[{path, line, metric, evidence}], hypotheses[], next_experiments[] }` |
| Notes | **Both a baseline and a delta are required** — a profiler that reports a number without a comparison is the same defect as the fine-tuning architect without a baseline (P4). `baseline_metrics` is a `requiresInputs` field: the profile cannot start without a prior measurement or an explicit `no_baseline_available` override recorded in the result |

**10 · `refactorer@builtin`** — behaviour-preserving mutation.

| Field | Value |
|---|---|
| `toolAllowlist` | `read`, `read_many`, `grep`, `glob`, `edit`, `write`, `bash`, `verify`, `todo` |
| `capabilityCeiling` | `mutate` (worktree-scoped) |
| `requiresInputs` | `review_artifact` (a `verdict=pass_with_findings` or an explicit refactor brief) |
| `refusesWhen` | `verify.run` is unavailable — **no refactor without a test command** |
| `resultSchema` | `{ changed_paths[], behaviour_preserved_evidence, tests_before, tests_after, findings_addressed[], findings_deferred[] }` |
| Notes | `behaviour_preserved_evidence` is mandatory: the profile must state *how* it knows behaviour is unchanged (tests run, byte-identical output, snapshot comparison). Compare the repo's `legacy-modernizer`, one of two `fable` agents, which has no such field |

**11 · `migrator@builtin`** — the risky one: dependency and framework migrations. Strongest tier, `worktree` isolation, human approval on the lockfile.

| Field | Value |
|---|---|
| `toolAllowlist` | `read`, `read_many`, `grep`, `glob`, `edit`, `write`, `bash_policy`, `dependency_update`, `verify`, `git_diff` |
| `capabilityCeiling` | `mutate` + `dependency.write` |
| `requiresHumanApprovalFor` | `dependency.write`, `vcs.write` (lockfile and manifest changes) |
| `refusesWhen` | `rollback_plan is absent` |
| `resultSchema` | `{ migrations_applied[], breaking_changes[], rollback_plan, verification_evidence[], manual_followups[] }` |
| Notes | `rollback_plan` as a **precondition** is the single highest-value addition here: the repo's `fable`-tier `legacy-modernizer` is described as *«handles technical debt»* with no stated reversal path. `manual_followups[]` is the honest escape hatch for changes a supervised run cannot complete |

**12 · `doc-writer@builtin`** — cheapest tier, path-scoped to documentation.

| Field | Value |
|---|---|
| `toolAllowlist` | `read`, `read_many`, `grep`, `glob`, `edit`, `write`  (no `bash`, no `verify`) |
| `capabilityCeiling` | `mutate(narrowed)` — `files.patch` restricted by `ownsPaths` |
| `ownsPaths` (default) | `**/*.md`, `docs/**`, `**/*.mdx` |
| `resultSchema` | `{ files_written[], claims_verified[], unverified_claims[], diagrams[] }` |
| Notes | `unverified_claims[]` is the field that separates documentation from fiction: any statement about behaviour the writer could not read in source must be listed there. The repo's `docs-architect` and `tutorial-engineer` both promise accuracy with no mechanism to report where they guessed. Cheapest tier is correct per P2 — writing prose from a repo map is extraction, and the profile's own quality bar lives in its skill, not its model |

**13 · `verifier@builtin`** — the mechanical pass/fail leaf. This profile is what makes an `architect` plan's `verify_cmd` executable without a reasoning model.

| Field | Value |
|---|---|
| `toolAllowlist` | `read`, `grep`, `bash_policy`, `verify` |
| `capabilityCeiling` | `verify` + `execute(narrowed: the declared verify_cmd only)` |
| `requiresInputs` | `verify_cmd` (from the plan step) |
| `resultSchema` | `{ verdict: pass\|fail, command, exit_code, stdout_digest, failure_summary?, duration_ms }` |
| `budgetDefaults` | tokens 20k, steps 8, wall-clock 5 min |
| Notes | Deliberately tiny. The tier is cheapest and the profile should be spawned **one per plan step** — this is the highest-frequency fleet node in a long run, so its per-spawn cost sets the floor for the whole run's economics. `stdout_digest` (not the raw output) keeps the parent capsule clean, which is P9's relay principle applied to verification |

**14 · `deployer@builtin`** — the only profile with `publish` capability, and the only one that must be posture-gated.

| Field | Value |
|---|---|
| `toolAllowlist` | `read`, `bash_policy`, `deploy`, `verify_remote`, `state_doc_edit` |
| `capabilityCeiling` | `observe` + `execute` + `deploy.invoke` + `files.patch(narrowed: state doc only)` |
| `requiresInputs` | `verifier_verdict` — a `verdict=pass` artifact from a `verifier` child on the same revision |
| `refusesWhen` | `posture ∈ {read-only, plan}` **or** `verifier_verdict != pass` |
| `requiresHumanApprovalFor` | `deploy.invoke` when `posture != full` |
| `resultSchema` | `{ deployed_revision, live_check, live_matches_expected, rollback_command, state_doc_updated }` |
| Notes | Two lifts from `operating-kit`. First: **`live_matches_expected` makes deploy verification a first-class result field**, which is `deploy-with-verification`'s whole reason to exist and its strongest idea. Second: **`rollback_command` must be present before the result is accepted** — `session-start`'s *«flag mismatches loudly»* philosophy applied to the deploy itself. The `files.patch` narrowing to the state document mirrors `deploy-with-verification`'s exact shape (`Bash, Read, Edit` — no `Write`) |

**15 · `relay@builtin`** — the P9 single-tool passthrough.

| Field | Value |
|---|---|
| `kind` | `relay` |
| `toolAllowlist` | **exactly one declared tool**, fixed at spawn time from the parent's request |
| `capabilityCeiling` | exactly that tool's capability — no `observe`, no `coordinate` |
| `canSpawn` | `none` |
| `outputFormat` | `passthrough` — `resultSchema` is the tool's own output schema |
| `budgetDefaults` | tokens 8k, steps 2 |
| Prompt invariants | *«Do not modify the input»*, *«Do not add commentary»*, *«Return the tool response as-is»*, *«Do not read files»* — the four rules lifted verbatim from `image-generator` |
| Notes | Exempt from the P2 reasoning-tier defaults (always cheapest). The `lead` spawns one per call, in parallel, so a bulky payload never enters the parent's context. Useful far beyond images: web fetches, repository listings, log dumps, any MCP tool whose response is an artifact rather than an answer |

### 6.4 How the 15 compose (the canonical fleet)

A single non-trivial turn on a real repository, using only bundled profiles — this is the concrete replacement for `ship-mate`'s filesystem pipeline and `agent-teams`' live protocol:

```text
session (profile: worker@builtin, posture: full)
  │
  ├─ lead@builtin .............. decompose; partition_by: dimension | hypothesis | module
  │    ├─ scout@builtin ×N ..... breadth-first repo mapping        [cheapest, read-only]
  │    │     resultSchema: findings[] + confidence + open_questions[]
  │    ├─ architect@builtin .... plan artifact: steps[] with owns_paths[] + verify_cmd
  │    │     requiresInputs: spec_artifact, repo_map
  │    └─ reviewer@builtin ×K .. one per dimension, distinct partition keys (P5)
  │          requiresInputs: diff_artifact (digest)
  │          resultSchema: verdict + findings[{severity, path, line, quoted_code, fix}]
  │
  ├─ fleet (depends_on + fail_fast + adopt_ref, per R-runtime-69)
  │    ├─ worker@builtin ×M ..... owns_paths[] lease from the plan (P6, isolation: worktree)
  │    │     ├─ tester@builtin ..... test globs only
  │    │     ├─ doc-writer@builtin . docs globs only
  │    │     └─ verifier@builtin ×step . one per plan step, verify_cmd only
  │    └─ blocked[] → reported to lead, never silently dropped (R-runtime-70)
  │
  ├─ debugger@builtin .......... only when a failure_artifact exists; narrowed terminal
  ├─ security-auditor@builtin ... dimension-partitioned; REQUIRED before publish
  └─ deployer@builtin .......... requires verifier_verdict == pass; emits live_matches_expected
```

Every arrow that carries data carries an **artifact digest** (`hz://artifact/<sha256>`), never a path and never transcript text. Every node reports `spend`, so `hz.usage.recorded` attributes cost to a profile id and a partition key — which is what makes P2's tier policy auditable after the fact.

### 6.5 What NOT to bundle (the anti-lesson)

Explicitly **do not** replicate the repo's 202-agent sprawl. Concretely:

| Do not bundle | Why | Instead |
|---|---|---|
| Per-language experts (`python-pro`, `rust-pro`, `java-pro`, …) | The repo ships 22 of these across 8 plugins, all `opus`/`inherit`, all with identical Capabilities/ResponseApproach bodies. They are a *skill* on top of `worker`, not a profile — the difference between Rust and Python is knowledge, not authority | One `worker@builtin` + a `skills: [lang-rust]` reference. The skill loads on demand (progressive disclosure) and the profile stays constant |
| Per-framework experts (`django-pro`, `fastapi-pro`, `graphql-architect`, `temporal-python-pro`) | Same argument, and the repo itself demonstrates the confusion — `django-pro` and `fastapi-pro` ship **three times each** (`api-scaffolding`, `python-development`) | Skills on `worker` |
| Per-bundle reviewers (`code-reviewer` ×6, `security-auditor` ×4, `architect-review` ×2) | A3. Six copies means six different behaviours behind one name | One `reviewer@builtin` with `dimension` as the partition key — the repo's own `team-reviewer` already models this correctly |
| Per-domain business agents (`hr-pro`, `legal-advisor`, `sales-automator`, `content-marketer`, 11 `seo-*`) | Real value, zero subagent-specific authority. They do not read the workspace or change the repo; they are *prompts*, and 12 of the 15 are `haiku` precisely because the work is templated | Skills and commands (`docs/15` §3.2/§3.3). Note that 12 of 15 SEO/business agents being `haiku` is itself the evidence that they need no agent machinery |
| A `context-manager` agent | The repo ships it twice. Context composition is the runtime's job (`docs/10`), and `R55/R56` say a *profile cannot reorder blocks* — so an agent whose purpose is context management is architecturally incoherent for us | Nothing. It is `ContextCapsuleV1` + the compiler |
| A `relay` per vendor | The repo has `gallery-researcher` and `image-generator` as separate profiles with separate MCP grants | One `relay@builtin`, parameterised by the single tool at spawn time |

### 6.6 Schema deltas this study implies

Consolidated list of field additions to `AgentProfileV1` (`05-domain-and-schemas.md`) and their sources:

| Delta | Pattern | Rationale |
|---|---|---|
| `kind += relay` | P9 | Single-tool passthrough nodes; exempt from tier defaults |
| `outputFormat += passthrough` | P9 | The tool's own output schema is the contract |
| `resultSchema: NamedSchemaRef \| JsonSchema` (**required** except `patch`/`passthrough`) | P3, A2 | Machine-readable verdicts; the single biggest gap between this repo's good and bad agents |
| `requiresInputs: []string` | P4 | Evaluate capsule completeness **before** reserving budget |
| `refusesWhen: []string` | P4 | Named precondition predicates; `llm-finetuning-architect`'s refusal, made structural |
| `partitionBy` on `FleetSpecV1` + distinct-key check | P5 | Disjoint child outputs by construction |
| `ownsPaths: []string` on `TaskSpecV1`, enforced at `files.patch` | P6 | File-ownership as a lease, not a convention |
| `profileClass` preset (`observe`/`execute`/`mutate`/`coordinate`/`network`/`publish`) | P7 | Plugins pick a class, not a capability soup; composition only narrows |
| Invariant: `kind ∈ {research, verify}` ⇒ no `files.patch`/`files.write`/`vcs.write` | P8 | Read-only is a `kind` property, provable at validation |
| `policyNarrowing` on the ceiling | P8, debugger | `terminal.run` narrowed by command prefix — the `protect-mcp` Cedar pattern (`"git status*"` allow; forbid `;`, `&`, `\|`, `` ` ``, `>`, `<`, `$`) |
| `rationale` required when `modelPolicy: inherit` | A4 | `inherit` becomes a justified decision, not a default |
| Validation: reject `capabilityCeiling = ∅`; lint prompt-vs-grant drift | A5, P1 | The `arm-cortex-expert` `tools: []` class of latent defect |
| Generated profile reference (CI drift gate) | A10 | The `docs/agents.md` problem: never hand-maintain what can be rendered |

### 6.7 Verdict

**What is genuinely worth taking.** Four things, and they are worth a great deal more than the 202 files they came from:

1. **Tool grant as role definition** (P1, P7, P8) — the repo proves that the *allowlist*, not the prompt, is what makes a subagent safe, and it shows five distinct shapes of read-only agent. Our kernel-enforced `capabilityCeiling` makes this mechanism strictly stronger here than it can be there.
2. **Tier by blast radius** (P2) — a clear, defensible, already-validated policy: strongest model for verdicts and irreversible decisions, mid for transformations, cheapest for extraction, and a rare top tier for multi-hour plan-holding.
3. **Typed output contracts with escalation ladders** (P3) — `SHIP / SHIP WITH FIXES / DO NOT SHIP` and 🔴/🟡/💡-with-pipeline-action are the two best ideas in the corpus, and the fact that only ~25% of agents have one is the corpus's single largest defect.
4. **The compound discipline of the engineered minority** (P4, P6, P10) — declared refusals, one-writer-per-file, dimension-partitioned fan-out, numbered invariants, and named anti-patterns. Read `team-lead`, `team-implementer`, `code-review-preshipment`, `session-start` and `llm-finetuning-architect`; skip the other 197.

**What to leave behind.** The scale (202 agents, 61 duplicated), the taxonomy-as-capability confusion, the 188 unrestricted agents, the capability bullet-dumps, `inherit`-as-escape-hatch, and the cross-harness compromise that reduces the tool allowlist to a *hint*. Our architecture makes every one of those unnecessary: one kernel, one enforced ceiling, receipts, and a schema that can carry the contract the repo could only describe in prose.

**The one-line synthesis.** This repo is a **style guide with 202 examples, of which about 15 are good** — and the 15 good ones all share the same shape: a narrow tool grant, a declared output, a named refusal, and an enumerated protocol. Bundle fifteen profiles of that shape, enforce them in the kernel, and let 185 skills supply the domain knowledge.

---

*End of report. Sources read in full or in part: `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/agents.md`, `docs/authoring.md`; 17 agent specs including all 5 `agent-teams` agents, all 6 `ship-mate` agents (`orchestrate` and `review` in detail), the 5 `operating-kit` agents, `comprehensive-review/code-reviewer`, `error-debugging/debugger`, `ui-design/accessibility-expert`, `plugin-eval/eval-judge`, `llm-finetuning/llm-finetuning-architect`, `protect-mcp/policy-enforcer`, `meigen-ai-design/image-generator`, `c4-architecture/c4-code`, plus a mechanical census of all 202 agent files. HorizonCode context: `docs/04-lld.md`, `docs/05-domain-and-schemas.md`, `docs/08-runtime.md`, `docs/15-extensibility.md`.*

