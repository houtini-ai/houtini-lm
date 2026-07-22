# vLLM backend — integration notes and caveats

The local model now runs on vLLM in Docker (dual RTX 4090 48GB rig, `C:\dev\local-llm\vllm`), replacing LM Studio. These are the verified behaviours houtini-lm must account for — the "caveats" for the current version, and requirements for the optimised future version.

## Connection

- Endpoint: `http://localhost:8000` (OpenAI-compatible, paths `/v1/chat/completions` etc.)
- Model name: use the **served name** `qwen3.6-27b` — it stays stable when the underlying quant changes (FP8 → AWQ). Auto-detect via `/v1/models` also works: vLLM reports exactly one model (the loaded one).
- No auth (localhost only).

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

## BUG (found 2026-07-22, dist-patched, needs source fix)

**vLLM ignores top-level `enable_thinking`; it must be nested in `chat_template_kwargs`.** `src` (compiled to `dist/index.js` ~line 881) sets `body.enable_thinking = false` — correct for LM Studio/Ollama, silently ignored by vLLM. Result on a vLLM thinking model (Qwen3-Coder-Next, Qwen3.6): the answer comes back in `reasoning_content` with **empty `content`** (houtini-lm's think-strip-empty fallback then surfaces raw reasoning — ugly, and breaks code_task output). Verified: same request with `chat_template_kwargs:{enable_thinking:false}` returns clean content.

**Fix (apply in `src`, rebuild dist):** in the `supportsThinkingToggle` branch, alongside `body.enable_thinking = false`, also set:
```js
body.chat_template_kwargs = Object.assign({}, body.chat_template_kwargs, { enable_thinking: false });
```
Keep the top-level flag too (LM Studio/Ollama compat). The dist was hand-patched on Richard's machine as a stopgap; a rebuild will overwrite it, so land this in source.

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
