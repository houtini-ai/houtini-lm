# Running houtini-lm in Docker

**houtini-lm is a stdio MCP server, and there are two ways to run it in a container. The simple one is `docker run -i`, where your MCP client starts the container itself and talks to it over stdio. The other puts it behind Docker's MCP Gateway, which serves it over HTTP so any client on the machine can reach it by URL. For houtini-lm, use Option 1. The gateway drops houtini-lm's progress notifications, so long generations time out at about 60 seconds (details [below](#long-calls-behind-the-gateway)). Option 2 is here for people who already run the gateway for other servers; everything on this page was built and measured on my own setup.**

Before you start, you'll need:

- Docker Desktop (or Docker Engine on Linux), running
- An OpenAI-compatible endpoint the container can reach: LM Studio, Ollama, vLLM, a LiteLLM router or a cloud API
- The `claude` CLI, if you're using Claude Code

One thing to know before you choose: a container can't see your host's files, so `code_task_files` only works on folders you've mounted into it, at the path the container sees. On Windows that means a `C:\...` path from Claude won't exist inside a Linux container. If `code_task_files` on your own code is the main reason you want houtini-lm, install it natively with `npx` ([Install](install.md)) and keep Docker for the servers that don't need your filesystem.

## Build the image

There's no official image yet, so build a small one. Pin the version, because `@latest` plus a cached layer is how you end up not knowing what's running:

```dockerfile
FROM node:22-slim
RUN npm install -g @houtini/lm@3.3.3 && npm cache clean --force
```

```bash
docker build --no-cache -t houtini-lm:3.3.3 .
```

Check the right version went in:

```bash
docker run --rm --entrypoint sh houtini-lm:3.3.3 -c 'npm ls -g @houtini/lm'
```

Use 3.3.3 or later. In 3.3.0 to 3.3.2 every answer came back with a `structuredContent` block, and Claude Code showed the model only that block, so delegated answers never arrived.

Pinning `@houtini/lm@3.3.3` pins houtini-lm itself, not its dependencies. The package doesn't ship an `npm-shrinkwrap.json`, so a rebuild months later can pull newer versions of the libraries underneath it. If you need a byte-identical rebuild, keep the image you built rather than rebuilding it.

The image runs as root, so its home directory is `/root` and houtini-lm keeps its state in `/root/.houtini-lm`. That's the path the volume goes on below.

## Option 1: docker run -i (stdio), recommended

Claude Code starts the container on demand and talks to it over stdin and stdout, exactly as it would with `npx`:

```bash
claude mcp add houtini-lm -- docker run -i --rm \
  -e HOUTINI_LM_ENDPOINT_URL=http://host.docker.internal:1234 \
  -v houtini-lm-state:/root/.houtini-lm \
  houtini-lm:3.3.3 houtini-lm
```

The `-i` is the important flag, because without it there's no stdin and the server exits. `host.docker.internal` is how a container reaches a server on your machine; Docker Desktop provides it automatically, and on Linux you add `--add-host=host.docker.internal:host-gateway` to the `docker run` line. The named volume keeps your stats and model profiles between sessions.

Add your API key and model pin the same way if you need them (`-e HOUTINI_LM_API_KEY=...`, `-e HOUTINI_LM_MODEL=...`). For Claude Desktop and other clients, the command is `docker` and the arguments are everything after it.

Progress notifications travel straight through on this route, so long generations keep the client's timeout reset just as they do with a native install.

## Option 2: behind the Docker MCP Gateway (HTTP)

Use this only if you already run the gateway for other servers and want houtini-lm alongside them, and read [Long calls behind the gateway](#long-calls-behind-the-gateway) first.

The gateway (`docker/mcp-gateway`) reads a catalog of server definitions, starts each server's container itself, and serves the tools over streamable HTTP. I run one small gateway per server, so the client entry can be called `houtini-lm` and the tools keep their `mcp__houtini-lm__*` names; a single shared gateway puts every server under one namespace (`mcp__MCP_DOCKER__*`), which breaks prompts that name the tools.

Start from an empty directory. Every command below is in the order I ran it.

### Define the server in a catalog

Save this as `~/.docker/mcp/catalogs/houtini.yaml`, swapping in your own endpoint and default model:

```yaml
registry:
  houtini-lm:
    description: Houtini LM (@houtini/lm), offloading to an OpenAI-compatible endpoint
    title: Houtini LM
    type: server
    image: houtini-lm:3.3.3
    command: [houtini-lm]
    secrets:
      - name: houtini-lm.api_key         # the value lives in a secret store, never here
        env: HOUTINI_LM_API_KEY
    env:
      - name: HOUTINI_LM_ENDPOINT_URL
        value: http://host.docker.internal:4000
      - name: HOUTINI_LM_MODEL           # the default for calls that don't name a model
        value: astra
      - name: HOUTINI_LM_SERIALISE       # 0 for routers and batching backends
        value: "0"
    volumes:
      - 'houtini-lm-state:/root/.houtini-lm'
```

There are three settings in there that each cost time to learn. Pin `HOUTINI_LM_MODEL`, because behind a router every alias scores the same and an unpinned call lands on whichever the router lists first (on my rig that was the local GPU model, which a voice assistant was busy with). Use a named volume rather than a bind mount, because on Windows SQLite on a bind mount fails with disk I/O errors and the gateway refuses `C:` paths anyway; the cache runs in WAL mode, so several containers sharing one volume is fine. And keep the API key out of the catalog: it goes in a secret store under the dotted name the catalog refers to.

There's deliberately no `longLived: true` here, and no `--long-lived` flag on the gateway below. Long-lived containers aren't removed until the gateway stops, and a gateway that runs as a service never stops, so every client session leaves another worker behind. I found 23 of them after one day. houtini-lm keeps its state on the volume, so a fresh container per session loses nothing.

### Store the API key

The preferred route is Docker Desktop's secret store, which keeps the key in your OS keychain:

```bash
docker mcp secret set houtini-lm.api_key="$YOUR_API_KEY"
```

The gateway reads that store when you run it with Docker's own `docker mcp gateway run`. I couldn't confirm whether a gateway running inside a compose container, as below, can reach it, because the store didn't work at all on my Windows machine: every `docker mcp secret` command failed with `engine.sock: An invalid argument was supplied`. If yours does the same, or you're using the compose setup, fall back to a secrets file:

```bash
printf 'houtini-lm.api_key=%s\n' "$YOUR_API_KEY" > gateway-secrets.env
```

That file is your API key in plain text. Keep it out of any git repository, lock its permissions down, and don't put it anywhere that syncs to the cloud.

### Run the gateway

Save this as `docker-compose.yml`:

```yaml
services:
  mcp-houtini-lm:
    image: docker/mcp-gateway:latest
    container_name: mcp-houtini-lm
    restart: unless-stopped
    ports: ["127.0.0.1:8911:8911"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock   # it starts the server container itself
      - ~/.docker/mcp:/root/.docker/mcp:ro          # the catalog
      - ./gateway-secrets.env:/.env:ro
    environment:
      - MCP_GATEWAY_AUTH_TOKEN=${MCP_GATEWAY_AUTH_TOKEN}   # clients must send this as a Bearer token
    extra_hosts: ["host.docker.internal:host-gateway"]
    command: ["--port=8911", "--transport=streaming", "--host=0.0.0.0",
              "--secrets=/.env",
              "--additional-catalog=houtini.yaml", "--servers=houtini-lm"]
```

The gateway requires a Bearer token on HTTP. That's Docker's defence against DNS rebinding: without it, any web page open in your browser could make requests to a server on `localhost` and spend your API key. You'll see `--allow-unauthenticated` in older examples (mine included); it switches that protection off, so don't use it. Generate a token and put it next to the compose file, where compose picks it up:

```bash
echo "MCP_GATEWAY_AUTH_TOKEN=$(openssl rand -hex 32)" > .env
```

That's compose's own `.env`, separate from `gateway-secrets.env`, and it's a secret too; keep it out of git. The port stays bound to `127.0.0.1` as well, so nothing off the machine can reach it at all.

```bash
docker compose up -d
docker logs mcp-houtini-lm 2>&1 | grep 'houtini-lm:'
```

You're looking for `houtini-lm: (8 tools) (1 resources)`.

### Check the endpoint and connect Claude Code

Load the token into your shell, then send an `initialize` call with it. It should come back with a 200 and an `Mcp-Session-Id` header:

```bash
source .env
curl -s -X POST http://localhost:8911/mcp \
  -H "Authorization: Bearer $MCP_GATEWAY_AUTH_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  -D - | grep -iE 'HTTP/|mcp-session-id'
```

Run it once more without the `Authorization` line; you should get a 401. If you get a 200, the gateway is running unauthenticated. When I tested this, no token and a wrong token both returned 401 and the right token returned 200.

Then register it with the token, and restart Claude, since MCP servers load at launch:

```bash
claude mcp add --transport http --scope user houtini-lm http://localhost:8911/mcp \
  --header "Authorization: Bearer $MCP_GATEWAY_AUTH_TOKEN"
```

Test this in Claude Code before you point anything else at the gateway: after the restart, `/mcp` should list houtini-lm as connected. If it shows as failed, the header didn't make it into the config (`claude mcp get houtini-lm` shows what was saved).

Ask Claude to run houtini-lm's `discover` tool. With the catalog above you should see `Active model: astra → openai/gpt-6-astra (pinned via HOUTINI_LM_MODEL)` with its real context window and no `Routing:` warning, and in your next session the lifetime stats should still be there (that's the volume doing its job).

### Long calls behind the gateway

houtini-lm sends an MCP progress notification on every streamed chunk so the client keeps resetting its tool timeout. On the gateway build I run (`docker/mcp-gateway:latest` as of July 2026) those notifications never reach the client. I traced it with a 63,000-character generation on DeepSeek: houtini-lm sent 140 progress notifications and returned the full result, the gateway logged the call as taking 1m15s and passed the answer on, and the client had already given up at around 60 seconds. A raw HTTP probe of the gateway received no progress events at all, then the whole result in one piece. The gateway has no per-call timeout of its own to raise.

The gateway's current source does include progress relaying, so a newer image may well fix this; I haven't tested one yet. Until one does, this is why Option 1 is the recommendation for houtini-lm: long generations are the whole point of the server. If you stay on the gateway, raise the client's tool timeout (in Claude Code, set `MCP_TOOL_TIMEOUT` in milliseconds, since the gateway will happily wait) or keep long work in chunks of roughly 500-900 output tokens. Calls that finish inside the client's limit are fine at any size; an 11,700-token call that finished in 51 seconds went through without trouble.

## Upgrading

Bump the version in the Dockerfile, rebuild with `--no-cache` (otherwise Docker reuses the old layer), update the image tag in the catalog, then recreate the gateway:

```bash
docker compose up -d --force-recreate
```

The named volume keeps your stats and profiles through the upgrade. Run `discover` afterwards; its first line shows the version that's answering (from 3.3.1 on).

## When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Calls quietly land on the wrong model | No `HOUTINI_LM_MODEL`, so the first listed alias wins | Pin it in the catalog or the `docker run` line |
| Stats reset every session | No volume on `/root/.houtini-lm` | Add the named volume |
| Every model shows a 100,000 context | Pre-3.3.0 image, or a router that doesn't report the model's limits | Upgrade; on LiteLLM, add `model_info` to self-hosted aliases ([Models](models.md#behind-a-litellm-router)) |
| `Unsupported parameter: max_tokens` or `temperature` | The upstream model rejects a parameter houtini-lm sends | See [models that reject parameters](models.md#models-that-reject-parameters) |
| Tools missing in Claude | The server was added after Claude started | Restart Claude |
| The call dies at about 60 seconds | Progress notifications not forwarded by the gateway | Use Option 1, or see [Long calls behind the gateway](#long-calls-behind-the-gateway) |
| `401` from the gateway, or houtini-lm shows as failed in `/mcp` | Missing or wrong Bearer token | Check the `--header` in `claude mcp get houtini-lm` matches `MCP_GATEWAY_AUTH_TOKEN` |
| Dozens of `houtini-lm` containers running | `longLived: true` or `--long-lived` | Remove both; workers then go when the session ends |
| `code_task_files` can't find a file | The container can't see host paths | Mount the folder, or install natively |

## Handing the build to an agent

If you'd rather have a coding agent do the setup, this prompt carries everything above except your key and endpoint:

> Set up the `@houtini/lm` MCP server in Docker for Claude Code using `docker run -i` over stdio, talking to my OpenAI-compatible endpoint at `<URL>`. (1) Build an image `houtini-lm:<version>` from `node:22-slim` with `npm install -g @houtini/lm@<version>` pinned, never `@latest`, and confirm it with `npm ls -g @houtini/lm` inside the image. (2) Register it with `claude mcp add houtini-lm -- docker run -i --rm -e HOUTINI_LM_ENDPOINT_URL=<URL> -e HOUTINI_LM_API_KEY=<key> -e HOUTINI_LM_MODEL=<default model> -v houtini-lm-state:/root/.houtini-lm houtini-lm:<version> houtini-lm` (on Linux add `--add-host=host.docker.internal:host-gateway` if the endpoint is on this machine). (3) After I restart Claude Code, check `/mcp` lists houtini-lm as connected and the `discover` tool reports the pinned model. Don't use Docker's MCP Gateway for this server: it drops progress notifications and long calls time out. Report each step's actual output, and if a step fails, show the error and stop.
