# How houtini-lm handles different models

**No two open source LLMs are the same. They differ in context window, output cap, prompt template, whether they think before they answer and how much of that they report, so a lot of houtini-lm's code is about working out what it's talking to and adjusting for it. This page covers what it does on its own, and the handful of decisions that are yours to make.**

## Model discovery at startup

At startup houtini-lm asks your server for every model available, loaded and downloaded, then looks each one up on HuggingFace's free API for its architecture, licence, download count and chat template. All of that goes into a local SQLite cache (`~/.houtini-lm/model-cache.db`, refreshed every 7 days) so later startups are instant.

For the families I know well there's a curated profile with specific strengths and weaknesses: Qwen, Nemotron, Granite, LLaMA, GLM, GPT-OSS, DeepSeek, Gemma, Kimi and the hosted GPT-5/6 models. Anything else gets a profile generated from the HuggingFace lookup, so a model houtini-lm has never seen still gets described sensibly. `list_models` shows the lot.

## Per-family prompt hints

Each model family carries its own temperature, output constraints and think-block flags, so GLM gets told "no preamble, no step-by-step reasoning" while Qwen Coder gets a low temperature for focused code output. Unknown models get sensible defaults.

Every call also carries a short grounding line in its system prompt: when the task depends on code, files or data you've supplied, the model works from that material and says what's missing rather than inventing it, and for everything else it answers from its own knowledge. (Before 3.3.1 the line told the model to answer only from the conversation, and literal models like GPT-6 and DeepSeek V4 took that at its word and refused open-ended writing.)

## Thinking: auto, off or on

Thinking models reason before they answer, and that reasoning comes out of the same output budget as the answer. Whether you want it depends on the job, so houtini-lm gives you three settings through `HOUTINI_LM_THINKING`, and the choice is yours.

**`auto` (the default)** switches thinking off for any model houtini-lm detects as supporting the toggle (Qwen3, Gemma 4, Nemotron, DeepSeek R1, GLM-4, gpt-oss), and leaves every other model to its backend's default. This suits the way houtini-lm is usually used, with Claude doing the reasoning and the other model doing the drafting, where hidden reasoning is mostly wasted wall-clock.

**`off`** forces the no-think request on every call, detected or not. Use it when your backend serves a model under a name detection can't recognise (vLLM started with `--served-model-name coder-next`, for example), because otherwise a real thinking model looks like a plain one, never gets the toggle, and hands back its answer in `reasoning_content` with an empty reply.

**`on`** forces thinking on. It's worth it for work where the model's own reasoning improves the answer, like hunting a subtle bug, checking an argument or planning something with several moving parts, and on a fast endpoint it's a good way to get a stronger second opinion. The cost is time and tokens: in one call to GPT-6 through my router, 326 of the 496 output tokens went on reasoning. houtini-lm still inflates the output budget when thinking is forced on, so the reasoning doesn't eat the answer, but on slow local hardware a thinking call can run past the MCP client's timeout, so keep `on` for the tasks that need it.

`HOUTINI_LM_THINKING` controls the `enable_thinking` toggle that open-weight chat templates understand. Hosted reasoning models (GPT-5/6, o-series, and anything on OpenRouter) manage their own reasoning, and on OpenRouter houtini-lm always asks for the reasoning to be left out of the reply.

### How the no-think path works

Suppression happens in three layers, because no single one is reliable across backends. First, houtini-lm sends `enable_thinking: false` both at the top level and inside `chat_template_kwargs` (vLLM only honours the nested form). Second, the output budget is inflated (4x, or plus 2,000 tokens, whichever is bigger) because some templates ignore the flag; Ollama's Qwen3 template hardcodes `enable_thinking=true`, for example. Third, reasoning is captured from `delta.reasoning_content` and `delta.reasoning`, inline `<think>` blocks are stripped from the answer, and if the reasoning still ate the whole budget you get the captured reasoning back rather than a silent empty body. The footer's quality line tells you when any of that happened.

## Output budgets

When you don't pass `max_tokens`, houtini-lm gives the call 25% of the target model's context window, falling back to 16,384 when the context isn't reported. It never goes above the model's declared output cap or the room left in its context after your prompt, which means a hosted model with a 128k output cap doesn't get sent a request it'll reject.

There's also a floor, because MCP clients habitually pass tiny caps like 256 that strangle reasoning models mid-thought. Any `max_tokens` below 4,096 is ignored and the dynamic budget applies instead. If you deliberately want small outputs (micro-chunking on slow hardware, say), set `HOUTINI_LM_MIN_TOKENS=0`.

## Routing and pinning

With several models loaded, houtini-lm scores each one against the task type (code, chat, analysis, embedding) and picks the best. It never swaps models at runtime, because loading a model takes minutes and an MCP call times out long before that. If a better model is sitting downloaded but not loaded, the footer suggests it.

Scoring works well with a handful of models. On a big catalogue (OpenRouter, or a router with dozens of aliases) unknown models all score the same and ties go to whichever is listed first, so you'll want to pin. Pass `model` on any individual call, or set `HOUTINI_LM_MODEL` for every call from that server process; the per-call parameter wins, and leaving both unset lets the router pick.

## Behind a LiteLLM router

Point houtini-lm at a [LiteLLM](https://docs.litellm.ai) router and it reads the router's `/model/info` alongside `/v1/models`. That's where the useful facts live: which real model sits behind each alias (my `local` alias is `qwen3.6-27b`), what kind of model it is, and for hosted models the true context window and output cap. Each alias is profiled as the model it actually is, a thinking model behind an alias gets the no-think toggle automatically, every call is sized from that model's own limits, and the TTS, image, video, realtime and moderation models a real router lists by the dozen are left out of `discover`, `list_models` and routing. Routers usually front rate-limited cloud tiers, so 429s are retried with backoff too.

LiteLLM reports limits for hosted API models but not for self-hosted ones (`hosted_vllm/*`), so for those houtini-lm falls back to guessing 100,000 tokens, and `discover` says it's guessing. Give each self-hosted alias its real limits in the router config, matching the `--max-model-len` vLLM actually runs with:

```yaml
model_list:
  - model_name: local
    litellm_params:
      model: hosted_vllm/qwen3.6-27b
      api_base: http://host.docker.internal:8000/v1
    model_info:
      max_input_tokens: 131072
      max_output_tokens: 131072
```

That's better than setting `HOUTINI_LM_CONTEXT_WINDOW`, which is one number for every model. One more thing to watch out for: if your router lists a local GPU model first, that's where unpinned work lands, so pin `HOUTINI_LM_MODEL` to the alias you actually want.

## Models that reject parameters

Some hosted reasoning models refuse parameters that every other model accepts. GPT-6 returns a 400 on `temperature` and `max_tokens`, both of which houtini-lm sends, and LiteLLM's wildcard `drop_params` doesn't catch them because it only drops parameters it already knows a model rejects. The fix on a LiteLLM router is a named route that strips them:

```yaml
  - model_name: astra
    litellm_params:
      model: openai/gpt-6-astra
      api_key: os.environ/OPENAI_API_KEY
      drop_params: true
      additional_drop_params: ["temperature", "top_p", "max_tokens", "logprobs",
                               "enable_thinking", "chat_template_kwargs"]
```

If you're pointing houtini-lm straight at a provider with no router in between, and a model rejects a parameter, the error comes back in the tool result with the provider's own message; open an issue with it and I'll add the family to the list houtini-lm adjusts for.

## Request queuing

A single-GPU host can only serve one request at a time, so on local providers houtini-lm queues parallel tool calls and runs them one at a time, which gives each call its full timeout rather than stacking them. On remote providers the queue is skipped because the upstream handles parallelism itself. If you run vLLM, TGI or SGLang, which batch natively, or a router in front of cloud models, set `HOUTINI_LM_SERIALISE=0` to turn the queue off.
