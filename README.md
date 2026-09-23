<div align="center">
  <img src="https://raw.githubusercontent.com/houtini-ai/houtini-lm/main/assets/logo.png" width="120" height="120" alt="Houtini LM" />
</div>

# Houtini LM (@houtini/lm) - Offload Work from Claude Code to a Local LLM, a Router or a Cheaper Cloud Model

[![npm version](https://img.shields.io/npm/v/@houtini/lm.svg?style=flat-square)](https://www.npmjs.com/package/@houtini/lm)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue?style=flat-square)](https://registry.modelcontextprotocol.io)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Known Vulnerabilities](https://snyk.io/test/github/houtini-ai/houtini-lm/badge.svg)](https://snyk.io/test/github/houtini-ai/houtini-lm)

**Houtini LM is an MCP server that lets Claude (or any MCP client) hand bounded work to another model - a local LLM on your GPU, a LiteLLM router, OpenRouter or a cheap cloud API - while you carry on working in the AI platform you already like. It cuts your token bill, and it gives you a second model to review your code whenever you want one.**

<p align="center">
  <a href="https://glama.ai/mcp/servers/@houtini-ai/lm">
    <img width="380" height="200" src="https://glama.ai/mcp/servers/@houtini-ai/lm/badge" alt="Houtini LM MCP server" />
  </a>
</p>

> **Quick Navigation**
>
> [Why use it](#why-use-houtini-lm) | [Install](#install) | [How it handles different models](#how-houtini-lm-handles-different-models) | [What to hand over](#what-to-hand-over) | [Tools](#the-tools) | [Reading the footer](#reading-the-footer) | [Configuration](#configuration) | [Endpoints](#compatible-endpoints) | [The manual](#the-manual)

I built this because I kept leaving Claude Code running overnight on big refactors and the token bill was painful. A huge chunk of that spend went on bounded tasks any decent model handles fine - generating boilerplate, code review, commit messages, format conversion, the sort of work that doesn't need Claude's reasoning or its tool access.

So Claude stays the architect, doing the planning, the multi-file changes and the judgement calls, and houtini-lm passes the drafting to whatever model you've got running. That could be Qwen on a GPU box under your desk, a model behind a LiteLLM router, one of OpenRouter's 300+ models or DeepSeek at pennies per million tokens. Claude QAs everything that comes back.

I wrote a [full walkthrough of why I built this and how I use it day to day](https://houtini.com/how-to-cut-your-claude-code-bill-with-houtini-lm/) if you'd like the longer story.

## Why use houtini-lm?

The bottom line before we go deep: you keep your favourite AI platform, and you stop paying frontier prices for work that doesn't need a frontier model.

The obvious win is cost. When Claude delegates a review with `code_task_files`, the source files are read by the houtini-lm process and sent straight to the other model, so they never enter Claude's context window at all. Claude sends a short tool call and reads back a short answer. I benchmarked this on real TypeScript source files:

| Task | Claude reads it directly | Delegated | Saved |
|------|--------------|-----------|-------|
| Code review (1,352 lines) | 14,466 tokens | 769 tokens | 95% |
| Architecture review (2,022 lines) | 20,014 tokens | 983 tokens | 95% |
| External repo review (581 lines) | 5,344 tokens | 741 tokens | 86% |
| Code explanation (833 lines) | 8,678 tokens | 744 tokens | 91% |

<p align="center">
  <img src="docs/token-savings-chart.svg" alt="Bar chart of Claude token use with and without delegation across four review tasks, averaging 93.3% saved" />
</p>

That averages out at 93.3% saved across the session. To be fair, small tasks like a one-line question or a commit message don't save much, because the tool call overhead (around 250 tokens) is about the same size as the answer. Anything that involves reading files, which is most of a real coding session, pays for itself straight away. You can run the same benchmark against your own setup with `LM_STUDIO_URL=http://your-server:1234 node scripts/benchmark.mjs`.

The less obvious win is a second opinion. A different model reads your code with different blind spots, and it costs you next to nothing to ask. As it happens, the 3.3.0 release of this repo is a decent example: I had Claude point houtini-lm at `gpt-6-astra` (through my LiteLLM router) and ask it to review the release's own 14,000-token diff. It came back with three real bugs - a router probe that cached a temporary 429 as a permanent "not a router", an output cap that got overwritten, and a race in the model list cache - and all three were fixed before the release shipped. Two of the three new test files were drafted the same way, then reviewed by Claude before commit.

Code review is where this pays off hardest, because reviews are exactly the bounded, read-a-lot-write-a-little work that a cheaper model does well. From there the list keeps growing: test stubs, docstrings, commit messages, changelog drafts, format conversion, mock data, type definitions, embeddings for a RAG pipeline, a quick sanity check on a regex, brainstorming three approaches before Claude commits to one, and so on.

The trade-off is wall-clock time. Local inference is typically 3-30x slower than a frontier model, so delegation wins on bounded, self-contained tasks rather than everything. A local model keeps your code private and costs nothing per token, a cloud model is cheap, and neither touches your Claude quota or its rate limits.

## How it works

```
Claude Code, Claude Desktop, Cursor... (orchestrator)
   |
   |-- Reasoning, planning, architecture, tool use --> your main AI platform
   |
   +-- Bounded grunt work --> houtini-lm --HTTP/SSE--> any OpenAI-compatible endpoint
       . Code review & second opinions       LM Studio, Ollama, vLLM, SGLang, llama.cpp
       . Test stubs & boilerplate            LiteLLM routers
       . Commit messages & docs              OpenRouter (300+ models)
       . Format conversion & mock data       DeepSeek, Groq, Cerebras, OpenAI...
       . Embeddings for RAG pipelines
```

Claude's the architect, the other model's the drafter, and Claude checks everything that comes back.

## Install

You'll need two things before you start:

- Node 22.5 or newer (22.13+ recommended - the model cache uses Node's built-in `node:sqlite`, and on older Node the server still runs, just without the cache)
- An OpenAI-compatible endpoint: LM Studio, Ollama, vLLM, a LiteLLM router or a cloud API key

New to local models? Start with [Getting started](./docs/GETTING-STARTED.md), which covers installing LM Studio or a Docker endpoint, what the smaller models are good at and which models fit on 16, 32, 64, 96 or 128 GB of VRAM. Each backend also has its own step-by-step guide with the traps that cause silent failures: [LM Studio](./docs/SETUP-LMSTUDIO.md) (easiest, desktop), [Ollama](./docs/SETUP-OLLAMA.md) (two commands) and [vLLM](./docs/SETUP-VLLM.md) (throughput, long context).

### Claude Code

```bash
claude mcp add houtini-lm -- npx -y @houtini/lm
```

That's it. If LM Studio's running on `localhost:1234` (the default), Claude can start delegating straight away.

### A model on a different machine

I've got a GPU box on my local network, and if you've got a similar setup, point the URL at it:

```bash
claude mcp add houtini-lm -e HOUTINI_LM_ENDPOINT_URL=http://192.168.1.50:1234 -- npx -y @houtini/lm
```

### A cloud API

Anything speaking the OpenAI format works. DeepSeek is very cheap, Groq is quick and Cerebras will give you thousands of tokens per second:

```bash
claude mcp add houtini-lm \
  -e HOUTINI_LM_ENDPOINT_URL=https://api.deepseek.com \
  -e HOUTINI_LM_API_KEY=your-key-here \
  -- npx -y @houtini/lm
```

### OpenRouter

OpenRouter gives you 300+ models through one endpoint. houtini-lm spots it from the URL and switches on the attribution headers, `reasoning.exclude` and retry-with-backoff for you. Pin a model, because with a catalogue that size every candidate scores the same:

```bash
claude mcp add houtini-lm \
  -e HOUTINI_LM_ENDPOINT_URL=https://openrouter.ai/api \
  -e HOUTINI_LM_API_KEY=sk-or-v1-... \
  -e HOUTINI_LM_MODEL=nvidia/nemotron-3-nano-30b-a3b:free \
  -- npx -y @houtini/lm
```

### A LiteLLM router

This is how I run it at home, with local GPU models and hosted models behind one router. Point houtini-lm at the router and pin the alias you want unpinned work to go to:

```bash
claude mcp add houtini-lm \
  -e HOUTINI_LM_ENDPOINT_URL=http://localhost:4000 \
  -e HOUTINI_LM_API_KEY=your-litellm-key \
  -e HOUTINI_LM_MODEL=your-alias \
  -- npx -y @houtini/lm
```

### Claude Desktop and other MCP clients

For Claude Desktop, drop this into your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "houtini-lm": {
      "command": "npx",
      "args": ["-y", "@houtini/lm"],
      "env": {
        "HOUTINI_LM_ENDPOINT_URL": "http://localhost:1234"
      }
    }
  }
}
```

Any other MCP client (Cursor, VS Code, Codex, Gemini CLI and so on) takes the same command, arguments and environment variables in its own config format.

To check everything's wired up, ask Claude to run houtini-lm's `discover` tool. It tells you which endpoint it found, which model is active and how big its context window is.

## How houtini-lm handles different models

No two open source LLMs are the same. They differ in context window, output cap, prompt template, whether they think before they answer and how they report any of it, so a lot of houtini-lm's code is about working out what it's talking to and adjusting for it.

### Model discovery at startup

At startup houtini-lm asks your server for every model available, loaded and downloaded, then looks each one up on HuggingFace's free API for its architecture, licence, download count and chat template. All of that goes into a local SQLite cache (`~/.houtini-lm/model-cache.db`, refreshed every 7 days) so later startups are instant.

For the families I know well there's a curated profile with specific strengths and weaknesses: Qwen, Nemotron, Granite, LLaMA, GLM, GPT-OSS, DeepSeek, Gemma, Kimi and the hosted GPT-5/6 models. For anything else, the HuggingFace lookup generates a profile, so a Mistral model houtini-lm has never seen still gets described sensibly. Run `list_models` and you get the whole picture:

```
Loaded models (ready to use):

  nvidia/nemotron-3-nano
    type: llm, arch: nemotron_h_moe, quant: Q4_K_M, format: gguf
    context: 200,082 (max 1,048,576), by: nvidia
    Capabilities: tool_use
    NVIDIA Nemotron: compact reasoning model optimised for step-by-step logic
    Best for: analysis tasks, code bug-finding, math/science questions
    HuggingFace: text-generation, 1.7M downloads, MIT licence

Available models (downloaded, not loaded):

  qwen3-coder-30b-a3b-instruct
    type: llm, arch: qwen3moe, quant: BF16, context: 262,144
    Qwen3 Coder: code-specialised model with agentic capabilities
    Best for: code generation, code review, test stubs, refactoring
    HuggingFace: text-generation, 12.9K downloads, Apache-2.0
```

### Per-family prompt hints

Each model family carries its own temperature, output constraints and think-block flags, so GLM gets told "no preamble, no step-by-step reasoning" while Qwen Coder gets a low temperature for focused code output. Unknown models get sensible defaults.

### Thinking models

Thinking models spend part of their output budget on hidden reasoning before they answer, and left alone a small one at a default `max_tokens` will happily spend the whole budget thinking and hand back an empty reply. houtini-lm deals with that in three layers.

First, it reads each model's chat template for thinking support, and models that support the `enable_thinking` toggle (Qwen3, Gemma 4, Nemotron, DeepSeek R1, GLM-4, gpt-oss) get thinking switched off at inference time. Second, the output budget is quietly inflated (4x, or plus 2,000 tokens, whichever is bigger) because some templates ignore the flag - Ollama's Qwen3 template hardcodes `enable_thinking=true`, for example. Third, reasoning is captured from `delta.reasoning_content` and `delta.reasoning`, inline `<think>` blocks are stripped from the answer, and if the reasoning still ate the whole budget you get the captured reasoning back rather than a silent empty body.

On OpenRouter it's simpler, because houtini-lm sends `reasoning: { exclude: true }` and the provider never sends the reasoning at all. Set `HOUTINI_LM_THINKING=off` if you want the no-think path forced on every call (useful when Claude does the reasoning and the other model only executes), and see [vLLM backend notes](./docs/VLLM-BACKEND.md) for the one case where you need it: vLLM served directly under an alias, where there's no real model name to detect.

### Output budgets

When you don't pass `max_tokens`, houtini-lm gives the call 25% of the target model's context window, falling back to 16,384 when the context isn't reported. It never goes above the model's declared output cap or the room left in its context after your prompt, which means a hosted model with a 128k output cap doesn't get sent a request it'll reject.

There's also a floor, because MCP clients habitually pass tiny caps like 256 that strangle reasoning models mid-thought. Any `max_tokens` below 4,096 is ignored and the dynamic budget applies instead. If you deliberately want small outputs (micro-chunking on slow hardware, say) set `HOUTINI_LM_MIN_TOKENS=0`.

### Routing and pinning

With several models loaded, houtini-lm scores each one against the task type (code, chat, analysis, embedding) and picks the best. It never swaps models at runtime, because loading a model takes minutes and an MCP call times out long before that. If a better model is sitting downloaded but not loaded, the footer suggests it instead.

Scoring works well with a handful of models. On a big catalogue, unknown models all score the same and ties go to whichever is listed first, so you'll want to pin. Pass `model` on any individual call, or set `HOUTINI_LM_MODEL` for every call from that server process; the per-call parameter wins, and leaving both unset lets the router pick.

### Behind a LiteLLM router

Point houtini-lm at a [LiteLLM](https://docs.litellm.ai) router and it reads the router's `/model/info` alongside `/v1/models`. That's where the useful facts live: which real model sits behind each alias (my `local` alias is `qwen3.6-27b`), what kind of model it is, and for hosted models the true context window and output cap. So each alias is profiled as the model it actually is, a thinking model behind an alias gets the no-think toggle automatically, every call is sized from that model's own limits, and the TTS, image, video, realtime and moderation models a real router lists by the dozen are left out of `discover`, `list_models` and routing. Routers usually front rate-limited cloud tiers, so 429s are retried with backoff too.

One more thing to watch out for: if your router lists a local GPU model first, that's where unpinned work lands. Pin `HOUTINI_LM_MODEL` to the alias you actually want, and `discover` will warn you when it spots the problem.

### Request queuing

A single-GPU host can only serve one request at a time, so on local providers houtini-lm queues parallel tool calls and runs them one at a time, which gives each call its full timeout rather than stacking them. On remote providers the queue is skipped because the upstream handles parallelism itself. If you run vLLM, TGI or SGLang, which batch natively, set `HOUTINI_LM_SERIALISE=0` to turn the queue off.

## What to hand over

The best candidates are bounded and well defined, with a clear input and a clear output:

| Task | Why it works on another model |
|------|---------------------|
| Code review | Paste the full source (or pass the paths), ask for bugs |
| A second opinion on a plan | Doesn't commit to anything, costs next to nothing |
| Generate test stubs | Source in, tests out |
| Explain a function | Summarisation doesn't need tool access |
| Draft commit messages | Diff in, message out |
| Convert formats | JSON to YAML, snake_case to camelCase |
| Generate mock data | Schema in, data out |
| Write type definitions | Source in, types out |
| Structured JSON output | Grammar-constrained, valid by construction |
| Text embeddings | Semantic search, RAG pipelines |

Anything that needs reasoning across the codebase, tool access or multi-step orchestration stays on Claude: architectural decisions, reading and writing files, running tests and interpreting the results, multi-file refactoring plans and anything that has to call other tools. The tool descriptions are written to nudge Claude into planning delegation at the start of a big task, rather than only using it when it happens to remember.

## The tools

There are eight of them. The full parameter reference is in [The tools, in depth](./manual/tools.md).

| Tool | What it's for |
|------|---------------|
| `chat` | The workhorse. Send a task, get an answer. |
| `custom_prompt` | System, context and instruction kept separate, which consistently beats stuffing everything into one message on local models. I tested this properly one weekend with the same batch of review tasks run both ways, and the three-part version won every round. |
| `code_task` | Code analysis with a code-tuned system prompt and per-family temperature. |
| `code_task_files` | Like `code_task`, but houtini-lm reads the files from disk itself, so the source never passes through Claude's context. Unreadable files are reported inline rather than sinking the call, and a pre-flight estimator refuses inputs that measured data says would time out. |
| `embed` | Text embeddings via `/v1/embeddings` (Nomic Embed is a solid choice). |
| `discover` | Health check: endpoint, active model, context window, output cap, and measured speed once there's a real call to measure. |
| `list_models` | Everything on the server, loaded and downloaded, with profiles. |
| `stats` | Session and lifetime offload totals and per-model performance, without the model catalogue. |

The inference tools (`chat`, `custom_prompt`, `code_task`, `code_task_files`) all take an optional `model` to pin the call, `max_tokens`, and sampling controls (`temperature`, `seed`, `stop`, `top_p`, `top_k`, `repeat_penalty`, `frequency_penalty`, `presence_penalty`). `chat` and `custom_prompt` also take a `json_schema`, which forces the answer to conform to a JSON Schema; on LM Studio that's grammar-based sampling, so there's no hoping the model remembers to close its brackets:

```json
{
  "json_schema": {
    "name": "code_review",
    "schema": {
      "type": "object",
      "properties": {
        "issues": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "line": { "type": "number" },
              "severity": { "type": "string" },
              "description": { "type": "string" }
            },
            "required": ["line", "severity", "description"]
          }
        }
      },
      "required": ["issues"]
    }
  }
}
```

Each inference result also carries a `structuredContent` block (model, tokens, timing, quality flags) for clients and scripts that would rather read JSON than parse the footer.

## Reading the footer

Every response ends with a footer computed from the SSE stream itself:

```
---
Model: nvidia/nemotron-3-nano | 279→303 tokens (12 reasoning / 291 visible) | TTFT: 485ms, 58.0 tok/s, 5.2s
📊 First measured call on nvidia/nemotron-3-nano: 58.0 tok/s, 485ms to first token — use this to gauge whether to delegate longer tasks.
💰 Claude quota saved — this session: 4,283 tokens / 7 calls · lifetime: 147,432 tokens / 213 calls
```

The first-call line appears once per model per session, and it's a benchmark from a real task rather than a synthetic warm-up. The savings line updates every call. When a model reports its reasoning tokens, the token count splits into reasoning and visible, so you can see when a thinking model is burning budget on hidden reasoning.

When something went wrong, a quality line says so: `TRUNCATED` for a partial result (a stalled connection gives you what arrived rather than a timeout error), `hit-max-tokens` when the budget ran out, `think-blocks-stripped` when reasoning was removed and `tokens-estimated` when the server didn't report usage. Clean output gets no quality line at all.

Per-model speed and token counts persist in `~/.houtini-lm/model-cache.db`, so `discover` shows your measured tok/s and time to first token from the first call of a new session, and `stats` gives you the lifetime totals. That data is specific to your workstation on purpose, because delegation decisions should reflect your hardware rather than somebody else's benchmark. In practice, Claude delegates more the longer a session runs; after about 5,000 offloaded tokens it starts hunting for more work to push over.

## Getting good results

Qwen, Llama, Nemotron and GLM score brilliantly on coding benchmarks now, and the gap between a good and a bad result is almost always the prompt rather than the model. I've spent a fair bit of time on this, and the short version goes like this. Send complete code, because local models make up details when the input is truncated, so send the whole function rather than a snippet with `...` in the middle. Be explicit about the output format ("return a JSON array"), since smaller models need it. Give the model a specific persona ("expert Rust developer who cares about memory safety" does noticeably better than "helpful assistant"), state what not to do as well as what to do, and for code generation include the imports, types and signatures around the function body.

Keep long jobs in chunks, too. Most MCP clients time a tool call out at around 60 seconds, and although houtini-lm sends a progress notification on every streamed chunk to keep the clock reset, not every client or gateway passes those through. Calls of roughly 500-900 output tokens finish comfortably inside the limit. [The craft of delegation](./manual/delegation.md) goes much deeper, including the verbatim-echo pattern I use for fixes.

## Check your install

```bash
npm run shakedown
```

[`scripts/shakedown.mjs`](./scripts/shakedown.mjs) runs seven of the eight tools end to end (everything except `stats`) and prints a table of real TTFT, tok/s, token counts and reasoning split for each call. It takes under a minute on a decent rig:

```
Summary

   7/7 steps passed on LM Studio, model=nvidia/nemotron-3-nano

| Tool              | OK  | TTFT (ms) | tok/s  | Tokens in→out        | Reasoning | Notes
| chat              | ✅  |      891  |   36.9 | 48→104               |        —  | answered
| custom_prompt     | ✅  |      872  |   43.9 | 170→333              |        —  | 5 valid items
| code_task         | ✅  |      857  |   41.6 | 180→189              |        —  | tests generated
| code_task_files   | ✅  |   11028   |   39.5 | 6891→3000            |        —  | cross-referenced
| embed             | ✅  |      —    |     —  | —                    |        —  | 768-dim vector

   Tokens offloaded: 10,915 (prompt: 7,289, completion: 3,626, reasoning: 0)
```

If you'd rather have a quality review than latency numbers, paste [SHAKEDOWN.md](./docs/SHAKEDOWN.md) into a Claude session with houtini-lm attached and Claude will drive the same steps and write you a report on the output as well as the speed.

## Configuration

| Variable | Default | What it does |
|----------|---------|-------------|
| `HOUTINI_LM_ENDPOINT_URL` | `http://localhost:1234` | Base URL of the OpenAI-compatible API. Legacy alias: `LM_STUDIO_URL`. |
| `HOUTINI_LM_API_KEY` | *(none)* | Bearer token for authenticated endpoints. Legacy aliases: `LM_STUDIO_PASSWORD`, `LM_PASSWORD`, `OPENROUTER_API_KEY`. |
| `HOUTINI_LM_MODEL` | *(auto-detect)* | Pin a model for every call from this process. Leave blank to let routing pick. Legacy alias: `LM_STUDIO_MODEL`. |
| `HOUTINI_LM_PROVIDER` | *(auto-detect)* | Force provider handling: `openrouter` (attribution headers, `reasoning.exclude`, no serialisation) or `litellm` (router handling, 429 backoff). Otherwise OpenRouter is detected from the URL and LiteLLM from its `/model/info` endpoint. |
| `HOUTINI_LM_CONTEXT_WINDOW` | `100000` | Fallback context window when the API doesn't report one (`discover` says when it's guessing). Legacy alias: `LM_CONTEXT_WINDOW`. |
| `HOUTINI_LM_RETRY_RATELIMIT` | *(off)* | Set to `1` to retry 429/5xx with jittered backoff on any backend. Already on for OpenRouter and LiteLLM routers; use it for other proxies that front a rate-limited API. |
| `HOUTINI_LM_FILE_ROOTS` | *(unset)* | Optional `:` or `,` separated allowlist of directories `code_task_files` may read from (symlinks resolved). Unset means any absolute path. |
| `HOUTINI_LM_MAX_FILE_MB` | `10` | Per-file size cap for `code_task_files`. |
| `HOUTINI_LM_CROSS_PROCESS_LOCK` | `1` | Set to `0` to disable just the cross-process inference lock (the in-process queue stays). |
| `HOUTINI_LM_SERIALISE` | `1` | Set to `0` to disable the queue entirely, for backends that batch natively (vLLM, TGI, SGLang). |
| `HOUTINI_LM_MIN_TOKENS` | `4096` | Floor for caller-supplied `max_tokens`; anything lower is ignored in favour of the dynamic budget. Set to `0` to honour any value. |
| `HOUTINI_LM_THINKING` | `auto` | `auto` detects thinking support per model, `off` forces the no-think path on every call, `on` forces thinking. Required as `off` for vLLM served directly under an alias; behind a LiteLLM router the alias is resolved and `auto` works. It only ever suppresses thinking, never fabricates it. |

## Compatible endpoints

Anything that speaks the OpenAI `/v1/chat/completions` API will work:

| What | URL | Notes |
|------|-----|-------|
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234` | Default, zero config, rich metadata via its v0 API. [Setup guide](./docs/SETUP-LMSTUDIO.md) |
| [Ollama](https://ollama.com) | `http://localhost:11434` | Thinking models (qwen3, deepseek-r1) handled via Ollama's `delta.reasoning` channel. [Setup guide](./docs/SETUP-OLLAMA.md) |
| [vLLM](https://docs.vllm.ai) | `http://localhost:8000` | Native OpenAI API. [Setup guide](./docs/SETUP-VLLM.md) |
| [SGLang](https://github.com/sgl-project/sglang) | `http://localhost:30000` | Good for repeated-context work. See [Getting started](./docs/GETTING-STARTED.md) |
| [LiteLLM](https://docs.litellm.ai) router | `http://localhost:4000` | Auto-detected: aliases resolved, real limits read, non-chat models filtered, 429 backoff |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | `http://localhost:8080` | Server mode |
| [OpenRouter](https://openrouter.ai) | `https://openrouter.ai/api` | 300+ models, auto-detected, parallel requests allowed |
| [DeepSeek](https://platform.deepseek.com) | `https://api.deepseek.com` | Very cheap per token |
| [Groq](https://groq.com) | `https://api.groq.com/openai` | Fast |
| [Cerebras](https://cerebras.ai) | `https://api.cerebras.ai` | Very fast |
| Any OpenAI-compatible API | Any URL | Set the URL and API key |

## The manual

This README is the overview, and the depth lives in these pages:

| Page | What's in it |
|---|---|
| [Getting started](./docs/GETTING-STARTED.md) | Local models from zero: LM Studio or Docker, what small models are good at, which fit your VRAM |
| [The tools, in depth](./manual/tools.md) | All eight tools: the parameters, reading the footer, the max_tokens floor |
| [The craft of delegation](./manual/delegation.md) | What to hand off and how to brief it, the verbatim-echo pattern, micro-chunking, reasoning-model budgets |
| [Troubleshooting](./manual/troubleshooting.md) | Symptom > cause > fix for empty responses, timeouts, context-length 400s, queuing and routers |
| [LM Studio](./docs/SETUP-LMSTUDIO.md), [Ollama](./docs/SETUP-OLLAMA.md) and [vLLM](./docs/SETUP-VLLM.md) setup | Backend guides, each with the traps that cause silent failures |
| [vLLM backend notes](./docs/VLLM-BACKEND.md) | Router topology, thinking toggles, token budgets and what houtini-lm reads from a router |
| [Shakedown test](./docs/SHAKEDOWN.md) | The end-to-end check, as a script or as a prompt for Claude |
| [CLI mode](./docs/CLI-MODE.md) | Scoped, not built yet: running houtini-lm as a command without the MCP timeout |
| [Developer guide](./DEVELOPER.md) | Architecture, contributing, release process |

## Development

```bash
git clone https://github.com/houtini-ai/houtini-lm.git
cd houtini-lm
npm install
npm test             # build + unit tests
npm run shakedown    # end-to-end self-test against a live endpoint
```

[DEVELOPER.md](./DEVELOPER.md) covers the architecture, the reasoning-model pipeline, backend detection, the SQLite performance cache and how to add new tools or backends. If you find a model family houtini-lm handles badly, open an issue with the `discover` output and I'll take a look.

Good luck, and let me know how you get on!

## Licence

Apache-2.0
