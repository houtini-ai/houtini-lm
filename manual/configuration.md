# Configuration

**Everything is set through environment variables on the server process, and most setups need only the first two or three. Pass them with `-e` on `claude mcp add`, in the `env` block of a JSON config, or in a Docker catalog or `docker run` line.**

## Environment variables

| Variable | Default | What it does |
|----------|---------|-------------|
| `HOUTINI_LM_ENDPOINT_URL` | `http://localhost:1234` | Base URL of the OpenAI-compatible API, without `/v1`. Legacy alias: `LM_STUDIO_URL`. |
| `HOUTINI_LM_API_KEY` | *(none)* | Bearer token for authenticated endpoints. Legacy aliases: `LM_STUDIO_PASSWORD`, `LM_PASSWORD`, `OPENROUTER_API_KEY`. |
| `HOUTINI_LM_MODEL` | *(auto-detect)* | The model every call uses unless it names one with `model`. Leave blank to let routing pick. Legacy alias: `LM_STUDIO_MODEL`. |
| `HOUTINI_LM_THINKING` | `auto` | `auto` switches thinking off for models detected as supporting the toggle, `off` forces the no-think request on every call, and `on` forces thinking on. Your call, and [Thinking: auto, off or on](models.md#thinking-auto-off-or-on) covers when each is worth it. |
| `HOUTINI_LM_PROVIDER` | *(auto-detect)* | Force provider handling: `openrouter` (attribution headers, `reasoning.exclude`, no serialisation) or `litellm` (router handling, 429 backoff). Otherwise OpenRouter is detected from the URL and LiteLLM from its `/model/info` endpoint. |
| `HOUTINI_LM_CONTEXT_WINDOW` | `100000` | Fallback context window when the API doesn't report one (`discover` says when it's guessing). It applies to every model, so behind a router give each model its real limits there instead. Legacy alias: `LM_CONTEXT_WINDOW`. |
| `HOUTINI_LM_MIN_TOKENS` | `4096` | Floor for caller-supplied `max_tokens`; anything lower is ignored in favour of the dynamic budget. Set to `0` to honour any value. |
| `HOUTINI_LM_SERIALISE` | `1` | Set to `0` to turn off the request queue entirely, for cloud APIs (OpenAI, DeepSeek and the like), routers in front of cloud models, and backends that batch natively (vLLM, TGI, SGLang). OpenRouter skips the queue automatically. |
| `HOUTINI_LM_CROSS_PROCESS_LOCK` | `1` | Set to `0` to disable just the cross-process lock (the in-process queue stays). |
| `HOUTINI_LM_RETRY_RATELIMIT` | *(off)* | Set to `1` to retry 429/5xx with jittered backoff on any backend. Already on for OpenRouter and LiteLLM routers; use it for other proxies that front a rate-limited API. |
| `HOUTINI_LM_FILE_ROOTS` | *(unset)* | Optional `:` or `,` separated allowlist of directories `code_task_files` may read from (symlinks resolved). Unset means any absolute path. |
| `HOUTINI_LM_MAX_FILE_MB` | `10` | Per-file size cap for `code_task_files`. |

## Per-call settings

The inference tools (`chat`, `custom_prompt`, `code_task`, `code_task_files`) take a few settings on each call that override the environment for that call alone. `model` pins the call to a specific model, and wins over `HOUTINI_LM_MODEL`. `max_tokens` caps the output, subject to the floor above; leave it unset and the budget is sized from the model (see [Output budgets](models.md#output-budgets)). `temperature` on `chat` and `custom_prompt` defaults to 0.3 (0.1 suits code); the two code tools set it per model family.

They also accept the sampling set, each range-checked and forwarded only when you set it: `seed`, `stop`, `top_p`, `top_k`, `repeat_penalty`, `frequency_penalty` and `presence_penalty`. An out-of-range value is ignored and the backend's default applies. `seed` with `temperature: 0` gives byte-identical output across calls, which is handy for regression-testing a prompt.

The full parameter reference for each tool is in [The tools, in depth](tools.md).

## Where state lives

houtini-lm keeps its model profiles, lifetime stats and prefill timing samples in `~/.houtini-lm/model-cache.db`, plus a lock file in the same folder. It's all specific to your workstation on purpose, because delegation decisions should reflect your hardware. Delete the folder to start fresh; in a container, mount a volume there or it's lost with every new container ([Docker](docker.md)).
