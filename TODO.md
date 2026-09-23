# TODO

Backlog for houtini-lm. Substantive work lives as **GitHub issues** (so CI, PRs
and discussion attach to it); this file is the quick index plus anything too
small to warrant an issue. Effort tags: **S** small, **M** medium, **L** large.

Most of the Sept 2026 platform review
([docs/PLATFORM-REVIEW-2026-09.md](docs/PLATFORM-REVIEW-2026-09.md)) shipped in
3.3.0, and 3.3.1-3.3.2 cleared most of what was left - see the Done lists at
the bottom. What's left:

## Open

### Declare `outputSchema` on the inference tools (S, needs client testing)

`structuredContent` ships without `outputSchema`, deliberately: on the low-level
`Server` a declared schema invokes client-side validation and risks an
outputSchema-aware client rendering *only* the structured object and dropping the
answer text. Test against Claude Desktop and Claude Code: if the answer still
renders from `content` with `outputSchema` present, add permissive schemas to the
`TOOLS` entries; if a client hides `content`, carry the answer inside
`structuredContent` first. The live fleet runs the npm build through the Docker
MCP Gateway, so this needs a published (or locally mounted) build to test.

### Verify-and-escalate cascade (M) - the differentiator

Delegate to the local/cheap tier, apply a cheap verifier (JSON-schema check,
compile/lint for code, or a fast yes/no "did this answer the task" pass), and
escalate to a bigger router tier only on failure. The RouteLLM cascade pattern,
and the token-saving mission done properly - most tasks stay free, only the hard
ones cost. 3.3.0 laid the groundwork: houtini-lm now knows each router alias's
real model and limits, which the escalation policy needs. Design the
verifier-per-task policy in an issue before any code.

### Remote / stateless HTTP transport (L) - demoted

Found on 2026-09-23: this fleet already serves houtini-lm over HTTP by running it
under the **Docker MCP Gateway** (`docker/mcp-gateway`, which wraps the stdio
server). So the team-endpoint need is met at the infra layer, and native support
for the 2026-07-28 stateless Streamable HTTP transport (SDK 2.x) drops to "only if
someone needs it without a gateway". If it's ever built: the cross-process file
lock means nothing across instances, and state goes handle-based.

### Interception / proxy mode (L, spike only)

The full agent-gateway idea: sit as an MCP proxy in front of other servers and
transparently farm delegatable tool calls out. Biggest moat, biggest risk (fights
the client's own routing). The cascade is the tractable 80% - spike this, don't
commit to it.

### Docker MCP Gateway: progress relay (S, upstream)

Measured 2026-09-23: through `docker/mcp-gateway:latest` (July 2026 build)
houtini-lm sent 140 `notifications/progress` during a 75s call and the HTTP client
received none, so the client's ~60s timeout still kills long calls. The gateway's
current `main` has relay code (`pkg/mcp/mcp_client.go`); re-pull and re-run the
probe. If it's still broken, file upstream. This is also the one argument for
reviving native HTTP transport (below). Volume, pinned model and the 3.3.0 image
are done on the fleet and documented in manual/docker.md.

### Finish extracting from `index.ts` (M)

3.3.0 moved the side-effect-free helpers into `src/pure.ts` (and the router
parsing into `src/litellm.ts`), which is what made them testable. Still inside
the ~2,900-line `index.ts`: `routeToModel`, `formatFooter`, `assessQuality`,
`buildStructured`, `getReasoningEffortValue` and the provider profile. They lean
on module state (session counters, the detected backend), so extracting them
means passing that state in - worth it for test coverage of routing in particular.

### Derive prompt settings from the model card (M) - next headline feature

`getPromptHints()` is a hand-maintained regex table, and a model newer than the
table falls through to defaults that can be actively wrong. Measured 2026-08-12 on
Nemotron 3 Super 120B, six-phase build, same prompts and hardware: defaults
finished 2/6 phases on 58,747 output tokens; the model card's own settings
(temperature 1.0, `enable_thinking: false`, an explicit "fence your code") finished
6/6 on 18,481. `lookupHF()` never fetches the README, which is where that guidance
lives. The prototype is `scripts/derive-prompt-schema.mjs <hf-id>` (PR #32).

Integration: extend `PromptHints` with `topP`, `reasoningOff`, `reasoningParser`,
`toolParser`, `likelyStripsFences`; run the deriver on a cache miss before the
regex table; persist beside the profile in SQLite. 3.3.0 makes this better than
when it was prototyped: behind a router, derive from `upstream_model` (the real
HF id), not the alias. Two findings to design around - model cards go stale
(Nemotron's card names the `super_v3` parser, which vLLM now rejects in favour of
`nemotron_v3`), and cards document deprecated methods beside current ones (the
deriver flags that as `ambiguous`). Derive automatically, verify against the
runtime before trusting.

### Local mode: hardware-aware model choice, download and loading (L) - scoped, leaning no

The question (2026-09-23): for people on LM Studio or Ollama rather than vLLM,
should houtini-lm know what their hardware can run, recommend the right quant,
download it and load it? Today it lists downloaded-but-not-loaded models (LM
Studio's v0 API, Ollama's `/api/tags`) with their quant, suggests a better one
when it exists, and never loads anything, because a load takes minutes and an
MCP call times out at ~60s. It knows nothing about VRAM.

What it would take:

- **A configurable harness with hardware detection.** `nvidia-smi` for NVIDIA,
  `rocm-smi` for AMD, unified memory on Apple Silicon, multi-GPU splits, and
  Windows/WSL quirks, with a manual override for everything detection gets wrong.
  The catch is that houtini-lm often isn't on the GPU's machine at all: a remote
  endpoint, a GPU box on the LAN, a container. Probing the MCP host would report
  the wrong hardware, so the numbers would have to come from the backend or from
  config.
- **Fit estimation.** Weights (the GGUF file size per quant, from the HF repo's
  file listing) plus KV cache for the chosen context (layers x KV heads x head
  dim x context x bytes) plus runtime overhead, so "Q4_K_M fits with 32k context,
  Q6_K needs part-offloading".
- **Download.** Multi-GB, resumable, `HF_TOKEN`-authenticated pulls with a
  disk-space check. This absorbs the old "model download and local store" item
  (from the 2026-08-10 Muse Glimmer test, where vLLM's in-container loader
  stalled twice in anonymous HF rate-limit retries).
- **Loading.** LM Studio can load over its API or `lms load`; Ollama loads on
  first request. Either way it's fire-and-poll: start the load, return
  immediately, let `discover` report progress.

The case against, and why it's leaning no: LM Studio already shows which quants
fit your hardware and handles GPU offload, and Ollama picks offload for you, so
this rebuilds their UX inside an MCP server. It turns houtini-lm from "a client
for any OpenAI-compatible endpoint" into a model manager with OS-specific code
paths CI can't test. The OpenAI-compatible API is a sensible stopping point.

The cheap middle ground, if anything (S): report what the backend already knows,
with no hardware probing. Ollama's `/api/tags` gives each model's size and
`/api/ps` gives `size_vram` for loaded models, so `list_models` could say "loaded
partly on CPU, expect it to be slower" when `size_vram` is below `size`, and point
at the VRAM table in GETTING-STARTED. Check the LM Studio API for the same
fields before building it.

### Generator/critic pairs (M)

When two models are up at the same time (two single-GPU models, or a local model
plus a cloud tier), one can draft and the other critique, then re-check the
revision. Today that pattern lives only in prose in the `delegate` skill; a
`pair_review` tool, or `discover` pointing out "these two can pair", would let any
session use it without re-deriving it. Overlaps with the verify-and-escalate
cascade above - design them together.

### Small

- **Model knowledge base as data.** `MODEL_PROFILES` / `PROMPT_HINTS` are code;
  a data file would date more gracefully. 3.3.0 refreshed the contents
  (DeepSeek, Gemma, hosted GPT-5/6, Kimi K3) but not the format.

## Done in 3.3.1 and 3.3.2

`HOUTINI_LM_THINKING=on` honoured (PR #34) · grounding line scoped so literal
models stop refusing open-ended writing · `discover` shows the version · the
manual split by task (install, Docker, models, configuration) · parameter policy
for OpenAI's hosted reasoning models (`max_completion_tokens` only, no sampling
controls or chat-template toggles) · the hosted-OpenAI profile covers GPT-4 to
GPT-6 and the o-series · stale "local model" descriptions on router aliases ·
empty "Best for:" lines · lazy re-profiling when the endpoint was down at startup
· spaced hyphens instead of em-dashes in runtime output.

## Done in 3.3.0

Router alias resolution via `/model/info` (the old top item here) · real
context and output limits from the router · non-chat models filtered from
discover/list/routing · 429 backoff for routers + `HOUTINI_LM_RETRY_RATELIMIT`
opt-in · budgets sized from the targeted model, not the first listed · budgets
clamped to the model's declared max output (this replaced the "clamp the 25%
default" item - a cap tied to the model beats an arbitrary ceiling, since the
budget is headroom, not consumption) · `structuredContent` on the inference tools
· `recordUsage` decoupled from `formatFooter` · unit tests (`node:test`, 21) + CI
on Node 22/24 · routing reads auto-generated profiles for the coder bonus · named
chars-per-token constants · `fitPrefillLinear` zero-variance bug (found by the new
tests) · discover capped and honest about guessed context · SGLang guidance ·
model profile refresh · 3.2.4 changelog backfill · CLAUDE.md brought up to date.
