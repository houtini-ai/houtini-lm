# vLLM backend — integration notes and caveats

The local model now runs on vLLM in Docker (dual RTX 4090 48GB rig, `C:\dev\local-llm\vllm`), replacing LM Studio. These are the verified behaviours houtini-lm must account for — the "caveats" for the current version, and requirements for the optimised future version.

## Connection

As of 2026-07-23 houtini-lm no longer talks to vLLM directly — it points at a **LiteLLM router** (`C:\dev\local-llm\litellm`, Docker, port 4000) that fronts the whole fleet behind one OpenAI-compatible endpoint. This unlocks per-call model selection across local *and* cheap API tiers, which a single vLLM endpoint can't do.

- Endpoint: `http://127.0.0.1:4000` (set `HOUTINI_LM_ENDPOINT_URL`). Use `127.0.0.1`, not `localhost` — WSL2 mirrored networking resolves `localhost` to IPv6 and times out.
- Auth: the router requires a master key. Set `HOUTINI_LM_API_KEY` to the value of `LITELLM_MASTER_KEY` in `C:\dev\local-llm\litellm\.env`.
- Model names are now **router-level aliases**, selectable per call via the `model` param (all houtini-lm tools accept it):

| Tier | `model` value | Cost | Notes |
|---|---|---|---|
| free / local | `local` | free | whatever preset vLLM currently serves (default `coder-next`); swapping the vLLM preset changes what `local` means |
| cheapest API | `deepseek-v4-flash`, `deepseek-v4-pro` | ~$ | reasoning models — leave `max_tokens` unset (see Caveat 1) |
| mid tier | `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k3` | ~$3/$15 | Moonshot, 1M context; `k2.7-code*` are non-thinking, `k3` reasons |

**The routing ladder** (cheapest capable tier first):

1. **`local`** — free, bounded execution: review, boilerplate, tests-from-spec, extraction, conversion. Volume costs nothing.
2. **`deepseek-v4-flash` / `-pro`** — cheapest API, high-volume general text when local is busy.
3. **`kimi-k2.7-code` / `k3`** — stronger mid-tier, huge context; substantial modules, long documents, reasoning over a large pasted corpus.
4. **Claude (don't delegate)** — orchestration, cross-file reasoning, tool use, anything expensive if wrong.

Direct-to-vLLM still works for local-only setups; everything below about vLLM behaviour applies to the `local` alias, since the router passes straight through to it.

### The router must not strip `chat_template_kwargs`

LiteLLM's `drop_params` defaults can silently remove non-standard fields. The config sets `drop_params: false` precisely so the nested `chat_template_kwargs: {enable_thinking: false}` reaches vLLM — without it every `local` call returns blank content (the exact trap in "RESOLVED in v3.2.1" below). Verified 2026-07-23: `local` returns clean content *through the router* with the nested toggle, and empty without it. If local delegation ever goes blank again, re-test this first.

## Caveat 1 — reasoning model token budgets (the big one)

Qwen3.6 **thinks before answering**: 100–400+ reasoning tokens on trivial prompts, thousands on hard ones, consumed from `max_tokens` *before any visible output*.

- Too-low `max_tokens` → HTTP 200 with **empty/truncated `content`** and the budget burned on thinking. Looks like a model failure; it's a client config bug. (Verified: `max_tokens=200` → empty content.)
- The raw `/v1/completions` endpoint defaults `max_tokens` to **16** when unset — never rely on defaults.
- The `HOUTINI_LM_MIN_TOKENS` floor (default 4096) is the right *floor*, but real budgets should be far higher — `max_tokens` is a runaway brake, not a throttle; unused budget costs nothing. Working numbers: 8k for no-think execution calls, **32k for generation and thinking-enabled calls** (a single 1,000-line file is ~13k tokens; Qwen themselves recommend ~32k output headroom for hard reasoning). Only real constraint: prompt + output ≤ 131k context, and vLLM caps automatically.
- The response carries a separate `reasoning` field (server runs `--reasoning-parser qwen3`): `content` = the answer, `reasoning` = chain-of-thought. Don't concatenate them into results; optionally expose reasoning for debugging.

## Thinking mode is client-controllable — default it OFF for orchestrated calls

Qwen3.6's thinking can be disabled per-request via the standard vLLM passthrough:

```json
{ "chat_template_kwargs": { "enable_thinking": false } }
```

Measured on the same server, same tool-call request: **thinking=true → 135 tokens, 3.7s; thinking=false → 26 tokens, 0.8s** — identical correct structured tool call. When Claude orchestrates (Claude does the strategic reasoning, the local model executes), no-think is the right default: ~4x faster responses and far smaller token budgets needed. Expose thinking as an opt-in per call for genuinely hard standalone subtasks (tricky refactors, maths). With thinking off, the empty-content trap in Caveat 1 also largely disappears — but keep the min-tokens floor anyway for thinking-enabled calls.

## RESOLVED in v3.2.1 — vLLM thinking models returned empty content

Two causes, both fixed in source and verified end-to-end against live Qwen3-Coder-Next:

1. **Wrong param shape.** houtini-lm sent `enable_thinking:false` only at the top level (correct for LM Studio/Ollama), which vLLM's OpenAI server silently ignores — it reads the toggle from `chat_template_kwargs`. Now sent in **both** shapes. The answer no longer lands in `reasoning_content` with empty `content`.
2. **Detection gap.** houtini-lm decides whether to send the toggle by identifying the model as a thinking model from Hugging Face metadata — but vLLM serves under arbitrary aliases (e.g. `coder-next`) that resolve to nothing on HF, so a genuine thinking model looked non-thinking and the toggle-branch never ran.

**Fix for the detection gap: `HOUTINI_LM_THINKING`** (`auto` | `off` | `on`, default `auto`).
- `off` forces the no-think path for every call regardless of detection — the correct setting when Claude orchestrates and the local model only executes, and **required** for any vLLM model served under an alias.
- `auto` keeps HF-metadata detection (fine for LM Studio / Ollama where the model id is the real one).
- `on` forces thinking on.

Set it in the MCP server's `env` (Claude config) alongside `HOUTINI_LM_ENDPOINT_URL`. Regression-guarded by `test-vllm-thinking.mjs` (`npm run test:vllm`).

> Note: `HOUTINI_LM_THINKING=off` only *suppresses* thinking; it never fabricates it. For genuinely hard standalone subtasks that want the model's own reasoning, leave it `auto` and rely on detection, or run a second endpoint with thinking on.

## Caveat 2 — tool calls

- Server-side parsers translate each model's native dialect to the standard OpenAI `tool_calls` schema (per-model parser matrix in `C:\dev\local-llm\docs\vllm-setup.md`). Client needs **zero** model-specific handling — but when `tool_calls` is present, `content` is typically `null`; handle that.
- Verified working with `--tool-call-parser qwen3_xml`. With a wrong server parser the calls leak into `content` as raw XML/text — if that's ever observed, it's a *server preset* bug, not a model limitation.

## Caveat 3 — speed expectations (current version)

- Official Qwen FP8 checkpoint on Ada: measured **18.8 tok/s** decode (block-FP8 hits untuned kernels on 4090s). With thinking overhead, first visible output can take 10–20s.
- **Set generous HTTP timeouts**: a 4k-token reasoning-heavy response can take 3–5 minutes at current speed. Recommend ≥ 600s.
- AWQ INT4 + TurboQuant KV requant (in progress) targets 40–50 tok/s; MTP speculative decoding may add more. Timeouts can tighten after the tuning session — check `C:\dev\local-llm\vllm\bench-results.jsonl` for measured numbers.

## Caveat 4 — one model at a time

- vLLM loads a single model; swapping = container restart (~1–2 min): `C:\dev\local-llm\vllm\swap-model.ps1 <preset>` (no args lists presets: coding / vision / general / fast-MoE).
- `/v1/models` only reports the *loaded* model. What's on disk: `list-models.ps1`.
- During a swap the endpoint is down — houtini-lm should surface a clear "backend restarting" error rather than retry-storming.

## Design note for the optimised future version — prefix caching

The tuning plan enables vLLM prefix caching, which reuses KV for **byte-identical prompt prefixes**. To exploit it, houtini-lm should:

1. Keep system prompts **byte-stable** across calls (no timestamps, request IDs, or reordered tool schemas in the system prompt).
2. Put stable content (system prompt, tool definitions, standing context) *first*, variable content (user task, pasted code) *last*.
3. For multi-turn delegation, resend identical history prefixes verbatim.

Done right, TTFT on repeated 16k-token delegation contexts drops from seconds to near-zero — this is the single biggest UX win available for the future version.

## Routing spec (for the optimised version — "something that just knows")

The measured fleet (see `C:\dev\local-llm\docs\MODELS.md`) maps cleanly onto houtini-lm's task types:

| Task profile | Served model | Measured |
|---|---|---|
| extraction / JSON / format / translate | `lfm2.5-8b` | 200 tok/s, strip `<think>` |
| TypeScript / MCP / Workers codegen | `fable-coder-12b` | correct handlers in ~12s |
| general drafts / summaries / bulk | `qwen3.6-35b-a3b` | 133 tok/s (boot default) |
| hard debugging / review (thinking ON) | `qwen3.6-27b` | accuracy flagship |
| image input | `qwen3-vl-32b` | OCR verified |

Design: (1) static map from tool/task-type first; (2) for ambiguous calls, a sub-second LFM2.5 classification request picks the role (~50 tokens — the fleet routes the fleet); (3) single-GPU reality: routing = swap-or-settle — only trigger a swap (`vllm/swap-model.ps1`, ~2 min) when the queued work amortises it, else settle for the loaded generalist; (4) post-second-GPU: two models warm simultaneously, routing becomes free per-request. Surface the chosen model in the response footer so users can audit routing.

## Concurrency

vLLM continuous-batches natively — the LM Studio-era "one call at a time" rule can relax in the future version. Measured aggregate throughput at 4 concurrent requests is in `bench-results.jsonl`. Modest parallelism (2–4) is fine; single-stream latency degrades gracefully.
