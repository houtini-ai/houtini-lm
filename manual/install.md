# Installing houtini-lm

**houtini-lm runs as an MCP server that your AI client starts for you, so installing it is one command in Claude Code or a few lines of JSON everywhere else. The only thing to decide is which endpoint it should send work to.**

You'll need two things before you start:

- Node 22.5 or newer (22.13+ recommended). The model cache uses Node's built-in `node:sqlite`; on older Node the server still runs, just without the cache.
- An OpenAI-compatible endpoint: LM Studio, Ollama, vLLM, SGLang, llama.cpp, a LiteLLM router or a cloud API key

New to local models? [Getting started](../docs/GETTING-STARTED.md) covers installing LM Studio or a Docker endpoint and which models fit your VRAM, and each backend has its own guide with the traps that cause silent failures: [LM Studio](../docs/SETUP-LMSTUDIO.md), [Ollama](../docs/SETUP-OLLAMA.md) and [vLLM](../docs/SETUP-VLLM.md). If you'd rather run houtini-lm itself in a container, see [Running houtini-lm in Docker](docker.md).

## Claude Code, with LM Studio on the same machine

```bash
claude mcp add houtini-lm -- npx -y @houtini/lm
```

That's it. LM Studio's server listens on `localhost:1234` by default, which is where houtini-lm looks first, so Claude can start delegating straight away. Make sure the server is actually started (in LM Studio, the Developer tab), because the app running isn't the server running.

## A model on another machine

If your GPU lives in another box on your network, point the URL at it. The URL is the base address, without `/v1`, because houtini-lm adds that itself:

```bash
claude mcp add houtini-lm -e HOUTINI_LM_ENDPOINT_URL=http://192.168.1.50:1234 -- npx -y @houtini/lm
```

Ollama listens on port 11434, vLLM on 8000 and SGLang on 30000 by default.

## A cloud API

Anything speaking the OpenAI format works. Add the key alongside the URL:

```bash
claude mcp add houtini-lm \
  -e HOUTINI_LM_ENDPOINT_URL=https://api.deepseek.com \
  -e HOUTINI_LM_API_KEY=your-key-here \
  -- npx -y @houtini/lm
```

## OpenRouter

houtini-lm recognises OpenRouter from the URL and switches on the attribution headers, `reasoning.exclude` and retry-with-backoff for you. Pin a model, because with 300+ in the catalogue every candidate scores the same:

```bash
claude mcp add houtini-lm \
  -e HOUTINI_LM_ENDPOINT_URL=https://openrouter.ai/api \
  -e HOUTINI_LM_API_KEY=sk-or-v1-... \
  -e HOUTINI_LM_MODEL=nvidia/nemotron-3-nano-30b-a3b:free \
  -- npx -y @houtini/lm
```

## A LiteLLM router

Point houtini-lm at the router with its key, and pin the alias you want calls to use when they don't name a model:

```bash
claude mcp add houtini-lm \
  -e HOUTINI_LM_ENDPOINT_URL=http://localhost:4000 \
  -e HOUTINI_LM_API_KEY=your-litellm-key \
  -e HOUTINI_LM_MODEL=your-alias \
  -e HOUTINI_LM_SERIALISE=0 \
  -- npx -y @houtini/lm
```

`HOUTINI_LM_SERIALISE=0` lets calls run in parallel, which a router in front of cloud models handles fine. [How houtini-lm handles different models](models.md#behind-a-litellm-router) explains what it reads from the router and how to give self-hosted aliases their real limits.

## Claude Desktop

Head to Settings > Developer > Edit Config, which opens `claude_desktop_config.json`, and add the server:

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

Restart Claude Desktop afterwards, because MCP servers load at launch.

## Other MCP clients

Cursor, VS Code, Codex, Gemini CLI and the rest all take the same three things in their own config format: the command `npx`, the arguments `-y @houtini/lm`, and whichever environment variables you need from [Configuration](configuration.md).

## Check it worked

Ask Claude to run houtini-lm's `discover` tool. It reports the houtini-lm version, the endpoint it found and the backend type, the active model with its context window and output cap, and a `Routing:` warning if unpinned calls are going somewhere you might not expect. If it says the endpoint is offline, [Troubleshooting](troubleshooting.md#discover-says-the-endpoint-is-offline) has the usual causes.

For a fuller check, `npm run shakedown` in a clone of the repo exercises seven of the eight tools and prints real timings; [the shakedown guide](../docs/SHAKEDOWN.md) has the details.

## Updating

`npx` keeps a cached copy and doesn't always check for a newer one. To pick up a new release, put the version in the arguments (`@houtini/lm@latest`, or a specific version like `@houtini/lm@3.3.1`) and restart your client. The first line of `discover` shows the version that's answering.
