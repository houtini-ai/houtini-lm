# Setup: LM Studio as a houtini-lm backend

LM Studio is the easiest backend — a desktop app (macOS / Windows / Linux) with a
built-in model downloader and a one-click OpenAI-compatible server. It's the fastest
way to get houtini-lm delegating, and its default settings just work.

> Want throughput, parallel agents, or long context instead? See
> [SETUP-VLLM.md](./SETUP-VLLM.md). For the deeper behaviour reference, see
> [VLLM-BACKEND.md](./VLLM-BACKEND.md) (much of it applies to any thinking model).

## 1. Install and download a model

1. Get LM Studio from [lmstudio.ai](https://lmstudio.ai) and install it.
2. In the **Discover** (search) tab, download a model. Good starting points for
   delegation:
   - **Qwen3-Coder-30B-A3B** (or a smaller Qwen coder) — strong at code, fast MoE.
   - A 7–14B instruct model if you're on ≤16GB VRAM.
3. **Choosing a quant**: `Q4_K_M` is the usual sweet spot (near-full quality, ~half
   the memory). Go higher (`Q5`/`Q6`) if it fits comfortably; drop to `Q3` only if you
   must. LM Studio shows an estimated memory fit next to each download.

## 2. Start the server

1. Open the **Developer** tab (the `>_` icon) → **Local Server**.
2. Select the model to load at the top.
3. Click **Start Server**. It serves an OpenAI-compatible API at
   **`http://localhost:1234`** by default.
4. **Turn on "Separate reasoning content"** in the server settings if your model is a
   thinking model — this splits reasoning from the answer so houtini-lm can read the
   `content` cleanly. (Without it, some models bury the answer under their thinking.)

To serve to another machine on your network, set the server to bind `0.0.0.0` and note
the host's LAN IP (e.g. `http://192.168.1.50:1234`).

Headless / no GUI? LM Studio ships a CLI:

```bash
lms server start           # start the server
lms load <model>           # load a model
lms ps                     # what's loaded
```

Verify it's up:

```bash
curl http://localhost:1234/v1/models
```

## 3. Point houtini-lm at it

`http://localhost:1234` is houtini-lm's **default** endpoint, so if LM Studio is
running there, you may not need to set anything. To be explicit (in your Claude Code /
Claude Desktop MCP config `env`):

```json
{
  "HOUTINI_LM_ENDPOINT_URL": "http://localhost:1234"
}
```

- On a different machine: use its LAN URL (`http://192.168.1.50:1234`).
- If you set a server API key in LM Studio, pass it as `HOUTINI_LM_API_KEY`.
- **Thinking control** — unlike vLLM, LM Studio reports real model ids, so houtini-lm's
  auto-detection identifies thinking models correctly and handles the toggle for you.
  Leave `HOUTINI_LM_THINKING` at its `auto` default, or set it to `off` when Claude is
  doing the reasoning and the local model should just execute (faster, smaller budgets).

Restart Claude after changing MCP config, then confirm:

```
houtini-lm discover        # shows the loaded model, context, and measured speed after one call
```

## Why LM Studio is the low-friction choice

- **Rich metadata.** LM Studio's v0 API exposes architecture, quant, and context per
  model, which houtini-lm reads to route and to detect thinking support — no manual
  config.
- **Grammar-guaranteed JSON.** LM Studio uses grammar-based sampling, so houtini-lm's
  `json_schema` parameter yields valid structured output every time.
- **One model at a time is fine** for delegation — LM Studio hot-swaps models from the
  GUI without a restart.

## Notes and gotchas

- **Small thinking models returning empty replies?** Enable "Separate reasoning
  content" (step 2) and don't cap `max_tokens` low — reasoning is spent from the same
  budget as the answer, so a tiny cap leaves nothing for the reply. houtini-lm inflates
  small caps automatically; if you set one, be generous.
- **LM Studio does not run in Docker** — it's a GUI/Electron app. For a headless
  container backend, use vLLM, Ollama, or llama.cpp instead.
- **Serialisation**: leave `HOUTINI_LM_SERIALISE` at its default `1` — a single-GPU
  LM Studio host serves one request at a time, so queueing parallel calls is correct
  (this is the opposite of vLLM, which batches natively and wants `0`).

## Verify end to end

```
houtini-lm chat  message="Reply with exactly one word: ok"
houtini-lm chat  message="Write a Python function that reverses a string. Code only."
```

Non-empty `content` on the second call means you're wired up. If a thinking model
returns empty content, enable "Separate reasoning content" and retry.
