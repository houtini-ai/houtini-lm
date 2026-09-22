# TODO

Backlog for houtini-lm. Substantive work lives as **GitHub issues** (so CI, PRs
and discussion attach to it); this file is the quick index plus anything too
small to warrant an issue.

## Resolve router aliases to real model names

**Problem.** When the endpoint is a LiteLLM router, `/v1/models` returns the
router's *aliases*, not the models behind them. On a live fleet that looks like:

```
local, gemma-a, gemma-b, deepseek-v4-flash, deepseek-v4-pro
```

None of those exist on HuggingFace, so `profileModelsAtStartup()` finds no card
for any of them and every model in `discover` / `list_models` comes back as
"No HuggingFace card found" with an empty **Best for**. The capability profiles
and task routing - the thing that makes `list_models` worth reading - are dead
weight for anyone running a router.

**The mapping already exists; we just do not read it.** LiteLLM exposes
`GET /model/info`, which returns `litellm_params.model` per alias. Verified
against a live router:

| alias | `litellm_params.model` |
|---|---|
| `local` | `hosted_vllm/qwen3.6-27b` |
| `gemma-a` | `hosted_vllm/gemma4-31b` |
| `gemma-b` | `hosted_vllm/gemma4-31b` |
| `deepseek-v4-flash` | `deepseek/deepseek-v4-flash` |
| `deepseek-v4-pro` | `deepseek/deepseek-v4-pro` |

Strip the provider prefix (`hosted_vllm/`, `deepseek/`) and what is left is a
name the existing HuggingFace lookup can already resolve. No hand-maintained
index file, and nothing to keep in sync on model download or removal - the
router is already the source of truth.

**Sketch.**

- In `listModelsRaw()` (`src/index.ts`), after the OpenAI-compatible branch,
  probe `/model/info`. A 200 with a `data[]` carrying `litellm_params` is a
  reliable LiteLLM tell - worth its own `Backend` value (`'litellm'`) so the
  provider profile can carry router-specific behaviour.
- Keep the alias as the callable `id` (it is what inference must be sent to)
  and add the resolved upstream name as a separate field, so HF enrichment has
  something real to look up while routing still targets the alias.
- Two aliases can resolve to the same upstream model (`gemma-a` / `gemma-b`
  above). Dedupe on the HF lookup, not on the alias.
- Degrade quietly: `/model/info` needs the router's API key and will 401
  without it. No key, or a non-LiteLLM endpoint, means today's behaviour -
  never a hard failure.

**Worth pairing with:** `retryOnRateLimit` is currently `false` for the
generic `openai-compat` profile, which is what a LiteLLM router matches today.
That default already cost a batch job most of its work (see the 429 note in the
project guide). A dedicated `'litellm'` backend is the natural place to fix it,
since a router fronting cloud tiers genuinely does need backoff.

**Also startup-only:** `profileModelsAtStartup()` runs once at boot. Inference
self-heals if the endpoint comes up later (`listModelsRaw()` re-runs per call,
and the backend is only cached on a *successful* probe), but the HF enrichment
does not. Re-running it lazily when the cache is empty would close that gap.

---

## Follow-ups from the Sept 2026 platform review

Scoped from the code audit + landscape review in
[docs/PLATFORM-REVIEW-2026-09.md](docs/PLATFORM-REVIEW-2026-09.md). The three
strategic bets deserve their own GitHub issues before any code; the internals and
small fixes are index-level. Effort tags: **S** small, **M** medium, **L** large.

### Finish move #1 and cut the release

- **Declare `outputSchema` on the inference tools (S, needs client testing).**
  `structuredContent` shipped (v[Unreleased]) without `outputSchema`, deliberately:
  on the low-level `Server` a declared schema invokes client-side validation and
  risks an outputSchema-aware client rendering *only* the structured object and
  dropping the answer text. Test against Claude Desktop / Claude Code: if the
  answer still renders from `content` when `outputSchema` is present, add the
  (permissive) schemas to the `TOOLS` entries; if a client hides `content`, also
  carry the answer inside `structuredContent` before declaring. Until tested,
  leave it off.
- **Release 3.3.0 (S).** The structured-output feature sits under `[Unreleased]`.
  Bump `package.json` + `server.json`, move the changelog heading to
  `[3.3.0]`, commit `v3.3.0: …`, then `npm publish` (2FA - user-driven).

### The strategic bets (issue-first, do not code blind)

- **Verify-and-escalate cascade (M) - the differentiator.** Delegate to the
  local/cheap tier, apply a cheap verifier (JSON-schema check, or compile/lint for
  code, or a fast yes/no "did this answer the task" pass), and auto-escalate to a
  bigger router tier only on failure. This is the RouteLLM cascade pattern and the
  token-saving mission done properly - most tasks stay free, only the hard ones
  cost. Fits the existing LiteLLM-tiered deployment. Design the verifier-per-task
  policy in an issue first.
- **Remote / stateless HTTP transport (L) - the team-scale play.** Adopt the
  2026-07-28 stateless Streamable HTTP transport (needs SDK 2.x) so houtini-lm can
  run as one shared team endpoint. Keep stdio the default. Plan for it: the
  cross-process file lock stops meaning anything across instances (drop it for
  batching backends, or move to a shared lock), and state goes handle-based.
- **Interception / proxy mode (L, spike only).** The full agent-gateway idea: sit
  as an MCP proxy in front of other servers and transparently farm delegatable
  tool calls to local. Biggest moat, biggest risk (fights the client's own
  routing). The cascade above is the tractable 80% - spike this, don't commit to it.

### Internals (from the audit)

- **Decouple `recordUsage()` from `formatFooter()` (S).** A formatter that mutates
  session/lifetime/SQLite state is a latent double-count footgun. Have handlers
  call `recordUsage` explicitly; make `formatFooter` pure.
- **Unit tests + CI (S/M).** `node --test` over the pure functions -
  `parseContextOverflow`, `correctedMaxTokens`, `fitPrefillLinear`, `redactUrl`,
  `extractSamplingParams`, `validMaxTokens` (export the index.ts internals first).
  Add a GitHub Action running build + these. `test:overflow` / `test:lock` already
  exist; this generalises them and adds a gate.
- **Extract testable helpers from `index.ts` (M).** The file is ~2,900 lines;
  `routeToModel`, `buildSystemPrompt`, `formatFooter`, `assessQuality`,
  `buildStructured`, `getReasoningEffortValue` and the provider profile are pure
  and belong in their own modules (as `inference-lock` / `context-overflow` /
  `version` already are).
- **Route on the async HF-cache profile, not just the static list (S).**
  `routeToModel` scores with `getModelProfile` (static only), so an auto-profiled
  coder model misses the `+5` code-task bonus.
- **Clamp the 25%-of-context default budget (S).** On a 1M-context model the
  default is 250k tokens before the ×4 thinking inflation; a `clamp(ctx*0.25,
  4096, ~96000)` is tidier than relying on `capToContext` and the 400 self-heal to
  undo it.
- **Name the chars-per-token constants (trivial).** `capToContext` uses 3
  chars/token; `estimatePrefill`/`recordUsage` use 4 (`CHARS_PER_TOKEN`). The 3 is
  a deliberate conservative overestimate for the cap - comment it so it doesn't
  read as a bug.

### Backend + model knowledge (from the review)

- **SGLang guidance (S).** Recommend SGLang for multi-step delegation
  (RadixAttention prefix caching, 30-40% saved on agent loops) and, where the
  orchestrator re-sends shared context, keep the stable prefix first so cache hits
  land. The `cached_tokens` telemetry to prove it already ships. Docs + a
  prompt-ordering guarantee.
- **Refresh the model knowledge base (S).** Add Qwen3-Coder-Next, DeepSeek-V4,
  GLM-4.x, MiniMax-M2, Kimi-K2 to `MODEL_PROFILES` / `PROMPT_HINTS`, and consider
  pulling the curated list into a data file so it dates more gracefully.

### Small doc / accuracy fixes

- **3.2.4 has no CHANGELOG entry (trivial).** The inference-lock hang fix shipped
  without a log entry; backfill it.
- **CLAUDE.md "version in three places" is stale (trivial).** `version.ts` reads
  the version from `package.json` at runtime and `new Server()` uses
  `SERVER_VERSION`, so it is now two places (`package.json` + `server.json`). Fix
  the release checklist so nobody hand-edits a constant that no longer exists.
- **Footer em-dashes (S, optional, touches snapshots).** The tool's own runtime
  output uses em-dashes (`💰 Claude quota saved — …`, the reasoning-overhead line,
  the benchmark line). If the house spaced-hyphen convention extends to runtime
  output, normalise - but it changes the shakedown snapshots and any test that
  asserts on the footer, so do it deliberately with those in the same change.
