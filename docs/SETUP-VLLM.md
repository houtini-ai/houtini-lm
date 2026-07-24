# Setup: vLLM as a houtini-lm backend

vLLM is the throughput option — continuous batching, real tool-calling, KV-cache
quantization for long context. It serves an OpenAI-compatible API that houtini-lm
talks to directly. This guide gets it running and wired, and covers the handful of
traps that make a delegated call come back empty or garbled if you miss them.

> For the deeper "why it behaves this way" reference (reasoning-model token budgets,
> the router topology, parser dialects), see [VLLM-BACKEND.md](./VLLM-BACKEND.md).
> Prefer a desktop GUI with zero config? Use [SETUP-LMSTUDIO.md](./SETUP-LMSTUDIO.md)
> instead — vLLM is worth it when you want throughput, parallel agents, or big context.

## Prerequisites

- An NVIDIA GPU with enough VRAM for your model + KV cache (a 4-bit ~30B needs ~20GB; a 4-bit ~80B needs two cards).
- Docker with the NVIDIA Container Toolkit (or a native Python install of vLLM).
- Recent NVIDIA drivers. On Windows this means Docker Desktop + WSL2.

## 1. Start the server

The minimal Docker invocation — one model, OpenAI API on port 8000:

```bash
docker run --gpus all -p 8000:8000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  vllm/vllm-openai:latest \
  --model Qwen/Qwen3-Coder-30B-A3B-Instruct \
  --served-model-name coder \
  --enable-auto-tool-choice --tool-call-parser hermes \
  --max-model-len 65536
```

- `--served-model-name` gives the model a **short, stable alias** (here `coder`). houtini-lm and every client use this name; it stays constant when you change the underlying quant. Remember it — it matters in step 3.
- `-v ...huggingface` caches weights so restarts don't re-download.
- Watch startup with `docker logs -f <container>`. It's ready when you see `Application startup complete`.

Verify it's serving:

```bash
curl http://localhost:8000/v1/models      # lists the served-model-name
curl http://localhost:8000/health         # 200 when live
```

> `/v1/models` answering is **not** proof the model is resident and fast — only a real
> completion is. See the cold-start note under Traps.

## 2. Match the tool-call parser to the model family

vLLM translates each model's native tool dialect to the standard OpenAI `tool_calls`
schema — **but only if you pass the right parser.** The wrong one makes tool calls
leak into `content` as raw XML/JSON text (this was the classic "local tool-calling is
broken" symptom).

| Model family | `--tool-call-parser` | `--reasoning-parser` |
|---|---|---|
| Qwen3 / Qwen3-Coder | `qwen3_xml` (alias `qwen3_coder`) | `qwen3` (thinking models) |
| Gemma 3/4 | `gemma4` | `gemma4` |
| Hermes / many Instruct | `hermes` | — (no thinking) |
| Llama 3.x | `llama3_json` | — |

If tool calls misbehave, check `docker logs` for a parser warning before blaming the model.

## 3. Point houtini-lm at it

Set these in houtini-lm's `env` (in your Claude Code / Claude Desktop MCP config):

```json
{
  "HOUTINI_LM_ENDPOINT_URL": "http://localhost:8000",
  "HOUTINI_LM_THINKING": "off",
  "HOUTINI_LM_SERIALISE": "0"
}
```

- **`HOUTINI_LM_ENDPOINT_URL`** — the vLLM address. On Windows/PowerShell use
  `http://127.0.0.1:8000` (not `localhost` — WSL2 mirrored networking resolves it to
  IPv6 and times out). From another container, use `http://host.docker.internal:8000`.
- **`HOUTINI_LM_THINKING=off`** — **the most important setting, and the one that bites.**
  See the trap below.
- **`HOUTINI_LM_SERIALISE=0`** — vLLM batches natively, so let parallel calls through
  instead of queueing them one at a time (the default `1` is for single-stream backends).

Restart Claude after changing MCP config. Then confirm from inside a session:

```
houtini-lm discover        # shows the model, context, and — after one call — measured speed
```

## Traps (each one has produced a silent failure in the wild)

### Thinking models return empty content unless you force no-think
A thinking model (Qwen3, DeepSeek-R1, GLM-4, gpt-oss) spends its output budget on
hidden reasoning *before* the visible answer. With thinking on, the answer lands in
`reasoning_content` and `content` comes back **empty** — looks like a model failure,
isn't. Two parts to the fix, both handled by **`HOUTINI_LM_THINKING=off`**:
- vLLM only honours the no-think toggle when it's **nested** in
  `chat_template_kwargs: {enable_thinking: false}` — a top-level `enable_thinking` is
  silently ignored. houtini-lm sends the nested shape.
- houtini-lm decides *whether* to send it by identifying the model from Hugging Face
  metadata — but your `--served-model-name` alias (e.g. `coder`) resolves to nothing on
  HF, so a real thinking model looks non-thinking and the toggle never fires. `off`
  forces it regardless. **This is required for any aliased vLLM model.**

Leave it `off` whenever an orchestrator (Claude) does the reasoning and the local model
only executes — it's also ~4× faster.

### Don't cap `max_tokens` low
The budget counts reasoning + answer together, so a low cap is burned on reasoning and
returns empty content. houtini-lm inflates small caps and vLLM sizes to the context
window, so normally pass nothing. If you set it, be generous (16k+; 32k for
thinking-heavy work). A ceiling is not consumption — the model stops when done.

### One model at a time
vLLM loads a single model. Switching means restarting the container with a new
`--model` (~1–2 min once weights are cached). `/v1/models` reports only the loaded one.

### Cold start / timeouts
Big reasoning responses take minutes; a model reloaded from idle can take ~30–60s
before the first token. Use generous client timeouts (houtini-lm defaults are already
generous; if you front vLLM with a proxy, give it ≥600s). A slow first call is normal,
not a failure.

### Slow decode on RTX 4090 / Ada? It's the quant format
If an official FP8 checkpoint decodes at ~18 tok/s, check `docker logs` for
"Using default W8A8 Block FP8 kernel config. Performance might be sub-optimal!".
**Block-format FP8 is a Hopper/Blackwell format with no tuned kernel on Ada (SM89).**
On a 4090, prefer **AWQ INT4** (Marlin kernels) or **FP8-dynamic** weights, and plain
`fp8` for the KV cache. This alone is often a 3× decode speedup.

## Verify end to end

Warm it, then run a real delegated task:

```
houtini-lm chat  message="Reply with exactly one word: ok"       # warms the model
houtini-lm chat  message="Write a Python function that reverses a string. Code only."
```

Non-empty `content` on the second call means the wiring — endpoint, parser, no-think —
is correct. If `content` is empty but `reasoning_content` is full, re-check
`HOUTINI_LM_THINKING=off`.
