# Changelog

## [3.3.3] - 2026-09-24

### Fixed
- **Claude Code never received delegated answers (3.3.0-3.3.2).** Every inference result carried a `structuredContent` block, and Claude Code shows the model only that block when a result has one, even with no `outputSchema` declared. So `chat`, `custom_prompt`, `code_task` and `code_task_files` delivered token counts and timings, and the answer itself never arrived. `structuredContent` is now off by default; set `HOUTINI_LM_STRUCTURED=1` to turn it on for your own scripts and orchestrators, and when it's on the block carries the answer as well. A new end-to-end test spawns the server against a mock endpoint and checks what a client actually receives in both modes. Found by the content-machine session's cost test and reproduced in a Claude Code session through the Docker gateway.

### Changed
- **The footer's counter is labelled "Offloaded", not "Claude quota saved".** It counts the other model's prompt and completion tokens, hidden reasoning included, which is work Claude didn't do rather than Claude tokens saved; the README's benchmark measures the saving itself. The optional structured block's `quotaSaved` field is now `offloaded`.
- **`server.json` points at `github.com/houtini-ai/houtini-lm`**, so the MCP registry entry shows the renamed repo.
- **The Docker guide recommends `docker run -i`** for houtini-lm, drops `longLived`/`--long-lived` (workers piled up on an always-on gateway), replaces `--allow-unauthenticated` with a Bearer token, prefers Docker's secret store to a plain-text secrets file, and notes that pinning the package doesn't pin its dependencies.

## [3.3.2] - 2026-09-24

### Fixed
- **OpenAI's hosted reasoning models are sent only what they accept.** GPT-5, GPT-6 and the o-series reject `max_tokens` (deprecated in favour of `max_completion_tokens`, which also counts reasoning tokens), and GPT-6 returns a 400 on `temperature`. houtini-lm now recognises these families by name, directly or behind a router alias, and sends `max_completion_tokens` only, leaving out the sampling controls (`temperature`, `top_p`, `top_k`, `repeat_penalty`) and the open-weight thinking toggles, which OpenAI rejects as unrecognised arguments. They skip the `HOUTINI_LM_THINKING` path, since they manage their own reasoning, and the server log lists what was left out. Until now this only worked behind a LiteLLM route configured to strip the parameters; pointed straight at OpenAI, these models would have failed. Verified live on gpt-5.2 (through a route with no stripping) and gpt-6-astra, and against a mock of OpenAI's API that rejects the same parameters. OpenRouter is unchanged, since it normalises parameters itself.
- **A plain OpenAI endpoint listed everything as a chat model.** OpenAI's `/v1/models` returns image, speech, transcription and moderation models beside the chat ones, untyped, so `discover` and routing treated DALL-E and Whisper as candidates. On endpoints without router metadata, those families are now left out by name, and embedding models are typed as embeddings. The filter is deliberately narrow, so an unfamiliar name is kept rather than hidden.
- **A model's unreported output cap caused a hard failure.** OpenAI's model list doesn't include output caps, so the default budget could overshoot a small one (`gpt-4o-mini`: 16,384) and fail with "max_tokens is too large". houtini-lm now reads the cap from that error, retries once, and remembers it for the model for the rest of the session.
- **`json_schema` failed on OpenAI and DeepSeek.** OpenAI's strict structured outputs reject any object without `additionalProperties: false`, and houtini-lm passed the caller's schema through as-is, so a typical schema 400'd on GPT-5 and GPT-6. Schemas are now prepared for strict mode (`additionalProperties: false` added where missing; a schema with optional properties is sent non-strict rather than rewritten). DeepSeek doesn't support `json_schema` at all, so a 400 about the response format now triggers one retry in plain JSON mode with the schema written into the system prompt. Verified live on gpt-6-astra, gpt-5.2 and deepseek-v4-flash.
- **Errors from every backend were labelled "LM Studio API error".** They now name the backend that was actually called.
- **Older OpenAI models were described as "local model".** The hosted-OpenAI profile only matched GPT-5 and GPT-6, so `gpt-4o-mini` or `gpt-3.5-turbo` behind a router fell through to a fallback that called them local. The profile now covers GPT-3.5 to GPT-6 and the o-series (gpt-oss keeps its own), and a cached pre-3.3 profile for a router alias is described as the alias it is.
- **Models without a profile printed an empty "Best for:" line** in `discover` and `list_models`. It's left out now.
- **Models weren't profiled if the endpoint was down at startup.** Profiling ran once at boot, so a GPU box still booting (or vLLM still loading) meant no profiles, and no thinking detection from them, for the whole session. It now runs on the first model list that has anything in it.

### Changed
- **OpenAI is a headline backend in the docs**, with its own install section, endpoint row and a "What's new in 3.3" summary in the README.
- **The docs no longer claim cloud endpoints skip the request queue.** Only OpenRouter does; every other endpoint queues calls one at a time unless `HOUTINI_LM_SERIALISE=0`, because houtini-lm can't tell a cloud API from a GPU box by its URL. The OpenAI and router install examples now set it.
- **Runtime output uses spaced hyphens instead of em-dashes** (the footer, tool descriptions, error messages), matching the docs.

## [3.3.1] - 2026-09-23

### Fixed
- **`HOUTINI_LM_THINKING=on` now forces thinking.** It was documented but ignored: any model detected as supporting the thinking toggle was sent `enable_thinking: false` whatever the setting, because detection was ORed straight into the `off` check. `on` now sends `enable_thinking: true` in both the top-level and `chat_template_kwargs` shapes, and still inflates the output budget, since forced thinking is exactly when reasoning eats it. `off` and `auto` behave as before. The three-state resolver comes from PR #34 by @pinboxltd, moved into `src/pure.ts` with a unit test.
- **Literal models refused open-ended writing.** Every system prompt carried "base your answer only on the information provided in this conversation", and literal models (gpt-6-astra, deepseek-v4-flash) took it at its word, declining tasks that needed their own knowledge and listing what was "missing". The grounding line now applies to supplied code, files and data, and leaves everything else to the model. Reported from the Docker deployment; verified live on gpt-6-astra.

### Added
- **`discover` shows the houtini-lm version** on its first line, so you can confirm an upgrade actually took (useful with `npx` caching and Docker images).
- **A user manual split by task:** [install](manual/install.md), [Docker](manual/docker.md) (plain `docker run -i`, and HTTP behind Docker's MCP Gateway, including the measured finding that the gateway build we run doesn't forward progress notifications), [how houtini-lm handles different models](manual/models.md) (with thinking as the user's choice: when `auto`, `off` and `on` are each worth it) and [configuration](manual/configuration.md). The README now gives the overview and links to them.

## [3.3.0] - 2026-09-23

Router-aware, and properly tested. Verified live against a LiteLLM router fronting a local vLLM model plus hosted DeepSeek and OpenAI tiers.

### Added
- **LiteLLM router support.** houtini-lm now reads a router's `/model/info` alongside `/v1/models` and uses what it finds. Aliases resolve to the real model behind them (`local` → `qwen3.6-27b`), so profiles, prompt hints and thinking detection work on the real name - a thinking model behind an alias now gets the no-think toggle automatically, where before it needed `HOUTINI_LM_THINKING=off`. Hosted models bring their true context window and output cap. Models that can't chat (image, video, audio, realtime, moderation - 128 of 239 entries on the test router) are left out of `discover`, `list_models` and routing. Routers get 429/5xx backoff by default. Detection is best-effort: no key, a 401, or a non-LiteLLM endpoint behaves exactly as before, and a definitive "not a router" answer is remembered so plain vLLM/llama.cpp endpoints don't pay for the probe twice.
- **Structured tool output.** The five inference tools (`chat`, `custom_prompt`, `code_task`, `code_task_files`, `embed`) return `structuredContent` alongside the text - model id, token usage (prompt / completion / reasoning / cached), TTFT and tok/s, quality flags, finish reason and the running quota counters (`embed` returns the embedding object). An orchestrator can branch on these without parsing the footer. The answer stays in the text block, so nothing is duplicated, and no `outputSchema` is declared yet (see TODO) so every client renders the answer exactly as before.
- **`HOUTINI_LM_RETRY_RATELIMIT=1`** opts any backend into 429/5xx backoff, for proxies other than OpenRouter and LiteLLM that front a rate-limited API. `HOUTINI_LM_PROVIDER=litellm` forces router handling.
- **Unit tests and CI.** A `node:test` suite (21 tests) over the new side-effect-free modules `src/pure.ts` and `src/litellm.ts`, plus the prefill fit and alias thinking detection in `model-cache`. `npm test` builds and runs it; a GitHub Actions workflow runs it with the overflow and lock tests on Node 22 and 24. Two of the three test files were drafted by a delegated model through houtini-lm itself and reviewed before commit.
- **Model profiles** for DeepSeek, Google Gemma and OpenAI's hosted GPT-5/6 family; the Kimi profile now covers K3 as well as K2.

### Fixed
- **Budgets were sized from the wrong model.** The output budget came from whichever model the backend listed *first*, not the model the call was sent to - so on any multi-model backend (a router, OpenRouter, LM Studio with two models loaded) a pinned call was sized from someone else's context window. Budgets now come from the targeted model.
- **Budgets could exceed a model's output cap.** Reading a hosted model's real context window (e.g. 922k) would have made the 25%-of-context default ~230k tokens, past a 128k output cap and into a 400. Every budget - including the thinking-model inflation - is now clamped to the model's declared max output as well as to the room beside the prompt.
- **`code_task_files` falsely refused large inputs to hosted models.** With fewer than five timing samples the pre-flight estimator falls back to a ratio (total prompt tokens ÷ total TTFT), which folds fixed network and queueing overhead into the rate. Two 72-token calls to a hosted model at ~3.5s TTFT read as "20 tok/s", and extrapolating that 190× predicted ~11 minutes of prefill for a 14k-token review the model then completed in 40 seconds. A ratio estimate may now only refuse a call while it's interpolating - the input within 4× of the largest prompt actually measured. Found by running this release's own code review through `code_task_files`.
- **`fitPrefillLinear` returned a garbage fit instead of `null` for identical prompt sizes.** Since recency weighting landed, floating-point error left the variance at ~1e-26 rather than 0, so the zero-variance guard never fired. The R² ≥ 0.5 gate kept it from ever refusing a call, but the contract was broken. Found by the new unit tests.
- **`discover` could list hundreds of models.** On a router or OpenRouter it now shows the first dozen and a count; `list_models` switches to one line per model past 30. Both show the real model behind an alias and the output cap.
- **`discover` showed ○ ("not loaded") for every model** on backends that don't report load state, under a "● ready to use" heading. It now shows ●.
- **`discover` claimed a 100,000-token context it had made up.** When the backend doesn't report a window it now says so and points at `HOUTINI_LM_CONTEXT_WINDOW`.
- **`server.json` was a version behind.** It still said 3.2.3 while 3.2.4 was on npm, so the MCP registry manifest lagged the package. Both now read 3.3.0.

### Changed
- **`discover` reports the model unpinned calls will actually land on**, flags `HOUTINI_LM_MODEL` when pinned, and warns when nothing is pinned on a multi-model backend - on a tie, unpinned work goes to the first listed model, which on a router is often a local GPU.
- **Routing** never sends a chat/code/analysis task to an embedding model, and the code-task bonus now reads profiles auto-generated from HuggingFace, not just the hardcoded list.
- **The model list is cached for 30 seconds** for inference and routing, so a router isn't queried twice per call. `discover` and `list_models` always fetch live.
- **Internals:** `formatFooter` no longer records usage as a side effect (callers record once, explicitly); the side-effect-free helpers moved out of `index.ts` into `src/pure.ts` so they can be tested.

### Documented
- LiteLLM router behaviour (README, VLLM-BACKEND), SGLang as the backend for repeated-context agent loops (GETTING-STARTED), and three new troubleshooting entries: work landing on the wrong model behind a router, stats resetting every session under the Docker MCP Gateway, and gateway-hop timeouts.

## [3.2.4] - 2026-08-15

### Fixed
- **Inference-lock hang.** The cross-process lock's acquire loop is now bounded on every path (including the steal path), and the lock file descriptor no longer leaks when a write fails (#33).
- **LICENSE file said MIT** while `package.json` and the README said Apache-2.0; the file now matches.

### Documented
- The manual (`manual/tools.md`, `delegation.md`, `troubleshooting.md`), an Ollama setup guide, a registry-ready `server.json` with an OIDC publish workflow, and a repo tidy for a public audience.

## [3.2.3] - 2026-08-03

### Fixed
- **Context-overflow self-heal.** Strict backends (vLLM) reject `prompt + max_tokens > context` with a 400 instead of clamping. houtini-lm sizes its output budget from the context reported by `/v1/models` — but that number is wrong when a proxy sits in front (e.g. a LiteLLM router advertising a generic 100k window over a model actually loaded at 64k), producing a spurious 400 (`max_completion_tokens=99002 … max_model_len=65536`). houtini-lm now parses the real limit from the backend's own error and **retries once** with a corrected budget — robust even when the advertised context is wrong, and self-correcting across vLLM / OpenAI / llama.cpp error shapes. New `src/context-overflow.ts` (unit-tested via `npm run test:overflow`). The parser also tolerates thousands separators in the limit (`max_model_len=65,536`).

## [3.2.2] - 2026-07-24

Docs-only release (no code change). Ships the README addition documenting
`HOUTINI_LM_THINKING`; the substantive backend notes below live in
`docs/VLLM-BACKEND.md` on GitHub (docs/ is not part of the npm tarball).

### Documented
- **Backend setup guides**: new step-by-step [SETUP-VLLM.md](docs/SETUP-VLLM.md) and [SETUP-LMSTUDIO.md](docs/SETUP-LMSTUDIO.md), each carrying the traps that cause silent failures (no-think toggle, tool-call parser, cold-start timeouts, the Ada block-FP8 kernel trap). Linked from the README quick start and endpoints table.
- **README**: the `HOUTINI_LM_THINKING` env var now appears in the configuration table on npm.
- **LiteLLM router topology** — houtini-lm can sit behind a LiteLLM router that fronts local vLLM + DeepSeek V4 behind one endpoint, selecting tier per call via the `model` param. The router must keep `drop_params: false` so the nested `chat_template_kwargs` no-think toggle reaches vLLM.
- **Reasoning-model token budgets** generalised from Qwen to every reasoning model (Qwen, DeepSeek V4): the `max_tokens` cap counts reasoning + answer together, so a low cap returns empty content; a generous ceiling is not consumption. (Kimi/Moonshot evaluated and dropped for hanging on large non-streamed requests.)

## [3.2.1] - 2026-07-22

### Added
- **`HOUTINI_LM_THINKING`** (`auto` | `off` | `on`, default `auto`) — forces the no-think path regardless of model detection. Required when vLLM serves a thinking model under an alias (e.g. `coder-next`) that Hugging Face detection can't identify, so the toggle would otherwise never fire. `off` is the right default when an orchestrator (Claude) does the reasoning and the local model only executes.

### Fixed
- **vLLM thinking models returned empty content** — two causes. (1) `enable_thinking:false` was sent only as a top-level param, which vLLM silently ignores (it reads the toggle from `chat_template_kwargs`); now sent in both shapes. (2) HF-metadata detection can't see vLLM's arbitrary served-names, so a real thinking model looked non-thinking and the toggle-branch never ran — addressed by `HOUTINI_LM_THINKING=off`. Together the answer now lands in `content`, not `reasoning_content`. Regression-guarded by `test-vllm-thinking.mjs`; verified end-to-end against live Qwen3-Coder-Next.

## [3.2.0] - 2026-07-18

### Added
- **`max_tokens` floor** (`HOUTINI_LM_MIN_TOKENS`, default 4096) — caller-supplied budgets below the floor are ignored and the dynamic 25%-of-context budget applies instead. MCP clients habitually pass tiny caps like 256 that strangle reasoning models. Set to `0` to honour any value (deliberate micro-chunking on slow hardware). Tool schema descriptions rewritten to match.
- **vLLM backend documentation** (docs/VLLM-BACKEND.md).

### Fixed
- **Output budget capped to context** — requested/inflated `max_tokens` is clamped to `context − estimated prompt`; strict backends (vLLM) previously rejected the ×4-inflated thinking-model budget with a 400 when it exceeded the context window.
- **Prefill estimator regime changes** — the linear fit is recency-weighted (half-life 6 samples) so a backend restart with different performance settings stops poisoning the estimate; a low-confidence fit (R² < 0.5) can no longer refuse a call.

### Changed
- Dependencies updated in-range (`@modelcontextprotocol/sdk` 1.29.0).

## [3.1.0] - 2026-07-17

### Added
- **Per-request sampling controls** on `chat`, `custom_prompt`, `code_task`, `code_task_files`: `seed`, `stop`, `top_p`, `top_k`, `repeat_penalty`, `frequency_penalty`, `presence_penalty`. All are range-validated server-side and forwarded only when set (unknown fields are ignored by backends that don't support them). `seed` gives reproducible output for testing.
- **Prefix-cache telemetry** — `usage.prompt_tokens_details.cached_tokens` (KV-reuse hits) is now captured and surfaced in the footer, a strong "this delegation was nearly free" signal when re-sending shared context.
- **`content_filter` finish-reason** is flagged distinctly in the quality line — a refusal, not a length truncation, so the orchestrator handles it differently.
- **`max_tokens` floor** (`HOUTINI_LM_MIN_TOKENS`, default 4096) — caller-supplied budgets below the floor are ignored and the dynamic 25%-of-context budget applies instead. MCP clients habitually pass tiny caps like 256 that strangle reasoning models (hidden thinking burns the budget before any visible output). Set `HOUTINI_LM_MIN_TOKENS=0` to honour any value, e.g. deliberate micro-chunking on slow hardware. Tool schema descriptions rewritten to match.

### Fixed
- **`json_schema`** now accepts both the documented wrapper `{name, schema, strict}` and a bare JSON Schema; a bare schema previously produced `undefined` name/schema and silently unconstrained output.
- **`max_tokens` / `temperature`** are range-validated before reaching the upstream request.
- **Prefill estimator** derives its ratio fallback from the same per-call `(prompt_tokens, ttft)` samples as the linear fit, instead of mixing populations (which skewed the rate and could mis-fire the pre-flight refusal).
- **Prefill estimator regime changes** — the linear fit is now recency-weighted (half-life 6 samples), so a backend restart with different performance settings stops poisoning the estimate within a few calls; and a low-confidence fit (R² < 0.5) no longer refuses the call — the keepalive/timeout machinery handles a false-ok, whereas a false refusal blocked valid tiny inputs outright.
- **Output budget capped to context** — requested/inflated `max_tokens` is clamped to `context − estimated prompt`, fixing a 400 from strict backends (vLLM) when the dynamic 25% budget was then ×4-inflated for thinking models to the full context window. Previously masked by callers passing tiny caps.

## [3.0.0] - 2026-07-17

**Breaking:** minimum Node is now **>=22.5** (recommended **>=22.13**), for `node:sqlite`.

### Changed
- **Model cache migrated from sql.js to `node:sqlite`** (Node's built-in SQLite) in WAL mode. Multiple houtini-lm processes sharing one cache file now get real cross-process concurrency — per-row writes and proper locking instead of whole-file snapshots — which fixes stats being clobbered under multi-agent fan-out. Still no third-party native dependency, no build step. Existing sql.js databases open unchanged. If `node:sqlite` is unavailable (e.g. Node 22.5–22.12 without `--experimental-sqlite`), the cache is disabled and the server runs without persistence rather than crashing.

### Added
- **Cross-process inference lock** — an advisory file lock serialises inference across processes on the same machine (opt out with `HOUTINI_LM_CROSS_PROCESS_LOCK=0`), so multiple agents don't hammer one loaded model in parallel. Fail-open: never blocks a call indefinitely.
- **`code_task_files` read guards** — per-file size cap (`HOUTINI_LM_MAX_FILE_MB`, default 10) and optional root confinement (`HOUTINI_LM_FILE_ROOTS`, symlink-resolved).

### Fixed
- Mid-stream backend `error` events are surfaced instead of returned as a silent empty success; per-token progress notifications are time-throttled so a fast model can't flood stdio; `tok/s` is measured over the decode window (excludes prefill); `discover` reports "no model loaded" instead of presenting an unloaded model as active; the `stats` tool no longer crashes when called with no arguments; endpoint URLs are redacted before display. See docs/CODE-REVIEW-2026-07.md and docs/AUDIT-2026-07.md for the full list.

## [2.13.2] - 2026-04-21

### Fixed
- **Pre-fetch progress heartbeat** — streaming keepalive used to start only after the upstream LLM returned HTTP response headers. On slow backends (big prompt, heavy prefill, cold model) the POST to `/v1/chat/completions` can sit open for 30–60+ seconds before headers flush, and that window was silent — tripping MCP clients with the default 60s request timeout before any progress notification could fire. `chatCompletionStreamingInner` now sends a progress notification immediately on tool-call receipt (resetting the client clock as soon as the call is acknowledged) plus a 10s heartbeat while awaiting upstream response headers. The existing post-fetch prefill keepalive is preserved. Clients that honour `resetTimeoutOnProgress` (Claude Desktop and similar) will now survive multi-minute prefills cleanly.

## [2.13.1] - 2026-04-21

### Changed
- **`HOUTINI_LM_MODEL` is now a genuine override**, not just a routing fallback. When set, every tool call uses that model id without running through the scoring path. Previously the env var was only consulted when routing failed entirely, which meant that on OpenRouter (where all 343 models report as "loaded") the router would pick essentially at random regardless of the user's configured preference. Backwards-compatible: if the env var is unset, routing behaves exactly as before.

### Added
- **Optional `model` parameter on `chat`, `custom_prompt`, `code_task`, `code_task_files`** — lets the caller pin a specific model id per-tool-call, overriding both routing and `HOUTINI_LM_MODEL`. Especially useful on OpenRouter: pass `model: "nvidia/nemotron-3-nano-30b-a3b:free"` or `model: "moonshotai/kimi-k2.6"` directly from the MCP client. `embed` already had a `model` parameter.

## [2.13.0] - 2026-04-21

### Added
- **`HOUTINI_LM_*` env var namespace** — now that multiple providers are supported the `LM_STUDIO_*` prefix is misleading. New preferred names: `HOUTINI_LM_ENDPOINT_URL`, `HOUTINI_LM_API_KEY`, `HOUTINI_LM_MODEL`, `HOUTINI_LM_PROVIDER`, `HOUTINI_LM_CONTEXT_WINDOW`. Legacy `LM_STUDIO_URL` / `LM_STUDIO_MODEL` / `LM_STUDIO_PASSWORD` / `LM_PASSWORD` / `OPENROUTER_API_KEY` / `LM_CONTEXT_WINDOW` remain accepted indefinitely — existing configs keep working untouched.
- **OpenRouter support** — detected automatically when `LM_STUDIO_URL` contains `openrouter.ai`, or forced via `HOUTINI_LM_PROVIDER=openrouter`. Attribution headers (`HTTP-Referer`, `X-Title`) are sent per request. Auth via `LM_STUDIO_PASSWORD` / `LM_PASSWORD` / `OPENROUTER_API_KEY` (all three names accepted).
- **Provider-profile layer** — small central registry (`getProviderProfile()`) gates per-backend behaviour: extra request headers, inference serialisation, 429/5xx retry policy, and reasoning-model output handling. Keeps per-provider divergence in one place so adding Groq/Together/Fireworks later is a config change, not a scavenger hunt across the file.
- **Jittered retry-with-backoff on 429/5xx** for remote providers (`fetchWithRetry`). Honours `Retry-After` header (seconds or HTTP-date) with a 10s ceiling. Local providers are unchanged — still a single-shot fetch.
- **End-to-end MCP smoke test** (`test-mcp-e2e.mjs`) — spawns the built server over stdio and drives real tool calls. Used to validate provider paths against both LM Studio and OpenRouter without mocking.

### Changed
- **Inference semaphore is now provider-gated** — only serialises requests for local/LM-Studio/Ollama backends (where a single GPU is being contended for). Remote providers bypass the lock and can serve parallel calls, which OpenRouter and similar multi-host backends handle natively.
- **Reasoning-model handling branches on provider**. Local thinking models still get `enable_thinking:false` + `reasoning_effort` + max_tokens inflation. OpenRouter gets `reasoning: { exclude: true }` (which the provider normalises across Nemotron, DeepSeek R1, Qwen3, Claude thinking etc.) plus the same max_tokens inflation to defend against providers that bill reasoning tokens against the cap before exclude filtering.
- **Model listing short-circuits for OpenRouter** — skips LM Studio `/api/v0/models` and Ollama `/api/tags` probes and goes straight to `/v1/models`, which on OpenRouter already returns `context_length` and `architecture.input_modalities` at the richness our routing needs.
- **`test.mjs` honours `LM_PASSWORD` / `OPENROUTER_API_KEY`** for bearer auth, so the same suite can run against remote providers for smoke testing.

## [2.12.0] - 2026-04-21

### Fixed
- **Ollama `delta.reasoning` capture** — Ollama's OpenAI-compatible streaming emits reasoning on `delta.reasoning`, not `delta.reasoning_content` (which LM Studio uses). The field was silently dropped, so Ollama thinking models like `qwen3:4b` produced empty `content` with `finish_reason=length` at default `max_tokens`. Now captured identically to LM Studio's channel — routing, safety-net fallback, and the `reasoning-only` quality flag all fire for Ollama.
- **Qwen3 base models detected as thinking-capable** — `qwen3:4b`, `qwen3-8b`, `qwen3-14b-instruct` etc. ship with `enable_thinking=true` hardcoded in their Jinja template (Ollama ignores the API flag). `detectThinkingSupportFromArch()` now flags any `qwen3*` model except coder / VL / embedding variants, so `max_tokens` inflation fires on first call. Previously only `qwen3-thinking`-tagged variants were recognised.
- **Auto-inject `model` field** — Ollama returns HTTP 400 ("model is required") when the field is absent; LM Studio accepted it and picked the loaded default. Inference path now resolves the active model from the backend before sending, so either backend behaves identically when the caller omits the model.

## [2.11.1] - 2026-04-20

### Changed
- **Pre-flight estimator now uses ordinary-least-squares linear regression** over the most recent 100 `(prompt_tokens, TTFT_ms)` samples per model. Fits `TTFT ≈ α + β·prompt_tokens` so fixed per-request overhead (α) is separated from genuine per-token prefill cost (β). The previous ratio-of-averages estimator (`totalPromptTokens / totalTtftMs`) systematically under-predicted for inputs much larger than the historical mean because small-prompt TTFT is dominated by the α term. Verified against real data: a mixed-size sample set containing one 6,955-token call and six ≤230-token calls fits α=668ms, β=1.49ms/token (R²=0.999); predicts 7,000-token TTFT as 11.1s, matching the observed 11.0s within 1%. Falls back to the ratio estimator when fewer than 5 samples exist, then to a conservative default for unknown models.

### Added
- **`model_prefill_samples` SQLite table** — stores individual `(prompt_tokens, ttft_ms)` observations per model. Capped at 100 samples per model with oldest-first pruning on each insert. Written fire-and-forget alongside `model_performance` so a DB hiccup never stalls a tool response.
- **`fitPrefillLinear()`** in `model-cache.ts` — reusable OLS implementation exposed so the `shakedown.mjs` script and any future consumers can reason about prefill characteristics of the workstation.
- **Richer refuse diagnostic** — when `code_task_files` refuses a too-large input, the error message now shows whether the estimate came from the linear fit (with α, β, R², n) or the ratio fallback, so the caller can judge confidence in the refusal.

## [2.11.0] - 2026-04-20

### Added
- **`stats` MCP tool** — compact markdown dump of session + lifetime totals, per-model performance, and reasoning-token overhead. Optional `model` filter. Cheap to call repeatedly to watch the 💰 counter climb.
- **Lifetime performance persistence** — a new `model_performance` SQLite table accumulates calls, TTFT, tok/s, prompt tokens, completion tokens, and reasoning tokens across sessions. Footer now reads `this session: X · lifetime: Y`. `discover` shows both session and lifetime speed lines, with a `last used` date. Data lives in `~/.houtini-lm/model-cache.db` alongside the existing profile cache.
- **Backend detection** — startup probe distinguishes LM Studio (`/api/v0/models`), Ollama (`/api/tags`), and generic OpenAI-compatible (`/v1/models`). Surfaced in `discover` output. Inference stays on the portable `/v1/chat/completions` path regardless — detection only steers enrichment and the per-backend `reasoning_effort` mapping.
- **`delta.reasoning_content` capture** — LM Studio's "Separate reasoning_content" dev toggle, DeepSeek R1, and Nemotron stream reasoning via this vendor-extension field. Previously discarded → silent empty bodies when the model exhausted its output budget on reasoning. Now captured into a buffer and returned as a last-ditch fallback with a `reasoning-only` quality flag so the caller sees *something*.
- **Prefill keep-alive** — a timer fires `notifications/progress` every 10s while waiting for the first chunk, preventing the MCP client's ~60s request timeout from firing during long prompt processing on slow hardware with big inputs.
- **Split prefill vs mid-stream timeouts** — `PREFILL_TIMEOUT_MS` (180s) applies until the first chunk arrives; `READ_CHUNK_TIMEOUT_MS` (30s) takes over afterwards. New `PREFILL-STALL` quality flag when truncation happens before any chunk.
- **Pre-flight token estimator for `code_task_files`** — uses measured per-model prefill rate from SQLite to refuse obviously-over-budget inputs early with a concrete diagnostic (estimated prefill seconds, tokens, sample count) instead of letting them silently hang. Only fires after ≥2 measured samples — first-time callers are never refused.
- **Reasoning-token split in footer** — when `usage.completion_tokens_details.reasoning_tokens` arrives, the token block reads `prompt→total (reasoning / visible)`. Diagnoses "why is the body empty despite hit-max-tokens?" instantly.
- **`reasoning_effort` + `max_completion_tokens` in request body** — sent alongside `enable_thinking: false` and `max_tokens` for broader compatibility. `reasoning_effort` value is backend-mapped: `'none'` on LM Studio + Ollama (hardest off-switch), `'low'` on generic OpenAI-compatible.
- **`shakedown.mjs` end-to-end self-test** — runs all seven tools in sequence, prints a markdown summary with real TTFT / tok/s / token counts / reasoning-token split. Wired as `npm run shakedown`. Not shipped in the npm tarball.
- **`SHAKEDOWN.md`** — canonical natural-language test prompt for conversational test runs via Claude.
- **`DEVELOPER.md`** — internals guide: streaming pipeline, reasoning-model handling, backend detection, SQLite schema, pre-flight estimator, adding tools/backends, release process, quality-flag reference.

### Fixed
- **`reasoning_effort: 'low'` caused HTTP 400 on Nemotron via LM Studio** — the LM Studio adapter accepts `none | minimal | low | medium | high | xhigh`, and Nemotron's narrower set would reject `'low'` with a silent fallback to `'on'` (maximum reasoning — opposite of intent). Backend-mapped value (`'none'` on LM Studio) is accepted by every model variant and is the hardest off-switch available.
- **Silent empty bodies on reasoning models** (Nemotron, DeepSeek R1, LM Studio with "Separate reasoning_content") — previously `delta.reasoning_content` was tracked for progress notifications but never accumulated into a content buffer, so when the model exhausted `max_tokens` on reasoning before emitting any `delta.content`, the response was empty and no safety flag fired. Now captured and returned via `reasoningFallback` with a clear preamble and flag.
- **Thinking-model detection was Gemma-4-only** — now covers Nemotron, DeepSeek R1, GLM-4, gpt-oss, and `qwen3-thinking` / `*-thinking` patterns. Arch + id + HF chat_template signals are OR'd.
- **Stale cache masked new thinking detection** — `getThinkingSupport` now re-applies the arch/id fallback at read time, so entries cached before the detection list was broadened still pick up flags without a manual cache flush.
- **`max_tokens` inflation used wrong base** — was `DEFAULT_MAX_TOKENS` (16k), now `effectiveMaxTokens` (context-aware 25%), so inflation sizes correctly on big-context models.
- **README `code_task_files` parameter name** — was documented as `file_paths`, actual parameter is `paths`.

### Changed
- **Footer format updated** to show `this session: X · lifetime: Y` and `tokens (reasoning / visible)` splits where applicable.
- **`discover` per-model speed line** now shows session and/or lifetime variants; the "not yet benchmarked" fallback only appears for models with no prior use on the workstation.
- **`code_task_files` tool description** mentions the size ceiling and pre-flight estimator behaviour.
- **`.gitignore` / `.npmignore`** add explicit `memory/` and `MEMORY.md` entries.

## [2.10.0] - 2026-04-20

### Changed
- **Tool descriptions reframed from pitch to peer** — removed "FREE, parallel worker", "delegate generously — it costs nothing", and similar salesy framing from `chat`, `custom_prompt`, `code_task`, and `code_task_files`. Descriptions now state the honest trade (local inference is typically 3-30× slower than frontier models, but doesn't bill against the user's Claude quota) and let the caller decide task-by-task. Positions houtini-lm as a sidekick — a capable peer for bounded work — rather than a blanket offload target.
- **Session savings line promoted** — the cumulative offloaded-token line now appears on its own line below the response footer with a 💰 prefix and "Claude quota saved this session" framing, instead of being pipe-separated among six other fields. Reads as value rather than accounting.
- **`discover` connection latency relabelled** — the ms number in discover is now labelled "Connection latency (does not reflect inference speed)" to avoid the prior misreading that it measured how fast the model generates tokens.

### Added
- **Session-level sidekick instructions** — the MCP `Server` now sends an `instructions` string at initialisation that frames houtini-lm as a local LLM sidekick, states when to delegate vs when not to, and directs Claude to `discover` for model speed. Surfaced once per session by the MCP client, so it sets baseline expectations rather than relying on per-tool descriptions being re-read.
- **First-call speed benchmark** — on the first measured call per model per session, the response footer adds a prominent line (`📊 First measured call on <model>: X tok/s, Yms to first token`). No synthetic warmup — the number reflects a real task. Gives Claude honest speed data for calibrating subsequent delegation decisions.
- **`discover` surfaces measured speed** — the active model's measured tok/s and TTFT appear prominently near the top of the discover output, averaged over the session. Shows "not yet benchmarked" when no real call has run, rather than inventing a number from an artificial probe.

### Fixed
- **Streaming reader cleanup on abrupt disconnect** — the `finally` block now races `reader.cancel()` against a 500ms timer before `releaseLock()`, so abrupt client disconnects free the upstream socket sooner without blocking the tool response path. Previously `releaseLock()` alone could leave a wedged upstream connection until the per-chunk timeout fired.
- **Average TTFT denominator** — per-model `avgTtftMs` (in `discover`, the `houtini://metrics/session` resource, and the session performance block) now divides `totalTtftMs` by a dedicated `ttftCalls` counter rather than `calls`. Previously, calls that reported no TTFT still counted toward the divisor, under-reporting the average. Surfaced by the new prominent speed line in `discover`.
- **Footer no longer swallows session line when `parts` is empty** — if every other footer field is absent but the session savings line or first-call benchmark exists, the footer now renders those instead of returning an empty string.

## [2.9.0] - 2026-04-16

### Added
- **`code_task_files` tool** (#4) — accepts absolute file paths; the server reads and concatenates them server-side so source never passes through the MCP client's context window. Uses `Promise.allSettled` so one unreadable file doesn't sink the call; failures are surfaced inline.
- **Dynamic `max_tokens`** (#5) — derived from the active model's loaded context window (25%, e.g. 262K ctx → 65K output) when the caller doesn't pass an explicit budget. Falls back to 16384 when context is unknown.
- **Progress notifications during reasoning** (#5) — each streamed chunk sends a progress notification during the thinking phase too, resetting the client's 60s clock so big-input + slow-TTFT calls don't time out.
- **Thinking-model detection for gated HuggingFace repos** — including Gemma 4.

### Fixed
- **Empty response body from thinking models** (#6) — two-layer fix:
  1. For models that support thinking toggle, inflate `max_tokens` by 4× (minimum +2000) so reasoning doesn't starve content generation. Gemma 4 hardcodes `enable_thinking=true` in its Jinja template and ignores the API flag, so this inflation is the real fix.
  2. Safety net: if the `<think>` stripper still ends up with an empty `cleanContent` (MLX/GGUF quants that ignore the flag entirely), return the raw output with a `think-strip-empty` quality flag instead of an empty body + lone footer.
- **Default soft timeout** raised to 5 minutes — progress notifications reset the MCP client's 60s clock, so the soft timeout is now a safety net rather than the primary limit.

## [2.8.0] - 2026-03-18

### Added
- **Quality metadata** — every response includes structured quality signals (truncation, think-block detection, token estimation, finish reason) so Claude can make informed trust decisions about local LLM output
- **Session metrics resource** — `houtini://metrics/session` MCP resource exposes cumulative offload stats and per-model performance as JSON, enabling proactive routing feedback
- **Request semaphore** — inference calls are serialised to prevent stacked timeouts when parallel requests hit a single-model server

### Fixed
- **SQLite statement leak** in `getCachedProfile` — statement was not freed if `getAsObject()` threw (now wrapped in try/finally)
- **Unflushed SSE buffer** — the final streaming chunk (often containing usage data) could be stranded in the buffer after loop exit, causing missing token counts on truncated responses
- **Session stats on truncated responses** — token counts now estimated from content length (~4 chars/token) when the usage chunk is lost, instead of silently showing zero

## [2.7.0] - 2026-03-14

### Added
- **Model routing** — automatically picks the best loaded model for each task type (code, chat, analysis, embedding)
- **Per-model prompt hints** — temperature, output constraints, and think-block flags tuned per model family (GLM, Qwen, LLaMA, Nemotron, Granite, GPT-OSS)
- **`stream_options: { include_usage: true }`** — enables accurate tok/s measurement from SSE streams
- Model routing suggestions when a better model is downloaded but not loaded

### Changed
- `code_task` temperature now set by routing hints (e.g. 0.1 for Qwen Coder) instead of hardcoded 0.2
- `chat` and `custom_prompt` inject output constraints into system prompts for models that need them
- Perf averaging now divides by calls with actual data, not all calls
- `profileModelsAtStartup` batches DB writes (single flush instead of per-model)
- Removed unused `dirname` import from model-cache.ts
- Test suite auto-detects loaded model instead of hardcoding

### Fixed
- tok/s was always `?` because `stream_options` wasn't set
- Perf averages inflated by calls without usage data

## [2.6.0] - 2026-03-14

### Added
- **Model discovery** — loaded vs available models, context window reporting, capability profiles
- **SQLite cache** (sql.js, pure WASM) — auto-profiles models via HuggingFace API, 7-day TTL
- **Performance stats** — TTFT and tok/s measured from SSE stream timing
- **Structured output** — `json_schema` parameter for grammar-constrained JSON
- **Embeddings tool** — `/v1/embeddings` endpoint support
- **Think-block stripping** — removes `<think>` blocks from GLM, Nemotron, Qwen3
- **12 static model profiles** — Nemotron, Granite, Qwen3, LLaMA, GLM-4, GPT-OSS, and more
- Session-level token accounting across all calls

## [2.0.1] - 2026-02-23

### Changed
- Rewrote README — clearer install instructions, use cases, and tool docs

## [2.0.0] - 2026-02-23

### Changed
- **Complete rewrite** — stripped the bloated plugin/prompt architecture down to a clean ~190-line MCP server
- Replaced `@lmstudio/sdk` with plain `fetch()` to the OpenAI-compatible API
- Removed `puppeteer`, `css-tree`, `jest`, and all unused dependencies
- Updated MCP SDK from `^1.17.3` to `^1.26.0`
- Enabled TypeScript strict mode

### Removed
- Plugin system, prompt library, caching layer, security module, template engine
- All "lite" variants and their build scripts
- Diagnostic tools, test files, development docs

### Tools
- `chat` — send a message and get a response
- `custom_prompt` — structured prompt with system message, context, and instruction
- `list_models` — list models loaded in LM Studio
- `health_check` — verify connectivity
