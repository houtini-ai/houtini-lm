# houtini-lm — Code Audit & Platform Review

**Date:** 2026-09-22
**Version audited:** 3.2.4 (`main` @ `1a0d97c`)
**Method:** full read of `src/` (index.ts 2,932 lines, model-cache.ts 1,139, inference-lock.ts 227, context-overflow.ts 65, version.ts); landscape research via Gemini 3.1 (grounded) + Context7 against the MCP TypeScript SDK and the `2026-07-28` spec.

---

## Executive summary

The code is in good shape. This is a mature, defensively-written, security-conscious server with unusually good inline documentation — most of the "obvious" bugs a reviewer would look for were already found and fixed in earlier passes (the comments read like a changelog of them). There are **no critical or high-severity correctness bugs**. The meaningful findings are structural and strategic, not defects.

The interesting part is the platform question. The router world *has* moved on, in one specific direction: **LLM routing and MCP tool routing are converging into "agent gateways."** houtini-lm today is an *explicit-delegation tool* — Claude has to consciously choose to call it. The frontier is *interception and cascade* — a gateway that decides, per request, whether work goes local or stays with the frontier model. That's the strategic pivot worth planning for.

**Top three moves, in order:**

1. **Adopt `structuredContent` + `outputSchema` on every tool** (small, do it now). 2026 orchestrators expect structured tool output alongside the text; houtini-lm returns none. Cheapest high-signal alignment available.
2. **Add a verify-and-escalate cascade** (medium, the differentiator). Delegate to local, cheap-verify the result, auto-escalate to a bigger tier on failure. This is the RouteLLM pattern applied to delegation, and it fits the LiteLLM-router-with-tiers setup already in use.
3. **Decide on a remote/HTTP transport** (larger, the team-scale play). The `2026-07-28` stateless Streamable HTTP transport turns "my local model" into "our team's delegation endpoint." Not urgent for the stdio use case, but it's the growth path — and it changes what the cross-process lock is for.

---

## Part 1 — Code audit

### Verdict: healthy

No critical or high findings. The security posture is genuinely good: `readGuardedFile` resolves symlinks before an allowlist check (`HOUTINI_LM_FILE_ROOTS`) and caps file size; `sanitizeCardText` defends `discover`/`list_models` against a squatted HuggingFace card injecting fake "SYSTEM:" metadata; `redactUrl` strips secrets from endpoint URLs before they reach logs or output. The `inference-lock.ts` and `context-overflow.ts` modules are small, pure where it counts, and reasoned through their failure modes carefully (the lock's garbled-vs-unreadable-vs-missing distinction is exactly right, and fail-open is the correct contract for a throughput optimisation).

### Findings

| # | Sev | Area | Finding |
|---|-----|------|---------|
| 1 | Medium | MCP alignment | **No `structuredContent` / `outputSchema` anywhere** (grep: 0 occurrences). Every tool returns `content: [{type:'text'}]` with model/tokens/tok-s/quality packed into a text footer an orchestrator must parse by regex. The current MCP spec and 2026 orchestrators expect machine-readable structured output. This is the single biggest spec gap and also the cheapest win — see platform move #1. |
| 2 | Medium | Maintainability | **`index.ts` is a 2,932-line monolith.** Genuinely testable pure helpers (`routeToModel`, `buildSystemPrompt`, `formatFooter`, `assessQuality`, `extractSamplingParams`, `getReasoningEffortValue`, the provider profile) live in the server entrypoint next to the SSE state machine. Extracting them into modules (as was already done for `inference-lock`, `context-overflow`, `version`) would make them unit-testable and shrink the file that has to be re-read on every change. |
| 3 | Medium | Testing/CI | **No test runner or CI.** Tests are ad-hoc `.mjs` scripts needing a live endpoint (`test:vllm`, `test:overflow`, `test:lock`). The pure functions that most deserve tests — `parseContextOverflow`, `fitPrefillLinear`, `correctedMaxTokens`, `redactUrl`, `sanitizeCardText`, `extractSamplingParams` — have no automated coverage gate. A minimal `node --test` suite + a GitHub Action running build + those unit tests would catch regressions the manual scripts can't. |
| 4 | Low | Dependencies | **SDK is `^1.26.0`; current 1.x is 1.29+, and a 2.0 alpha exists** implementing the `2026-07-28` spec. The caret allows 1.29, so this is low-risk today, but the major-version and protocol shift should be a conscious decision, not drift (see platform move #3). |
| 5 | Low | Design smell | **`formatFooter()` calls `recordUsage()` as a side effect.** A formatter that mutates session/lifetime/DB state is surprising, and it silently couples "did we render a footer" to "did we count the call." It's called exactly once per handler today so there's no double-count, but it's a latent footgun — a second `formatFooter(resp)` on the same response would double-count tokens. Separate the accounting call from the formatting call. |
| 6 | Low | Routing | **`routeToModel` scores with the sync static profiles only** (`getModelProfile`), not the async HF cache. A coder model that was auto-profiled from HuggingFace (rather than matching a hardcoded `MODEL_PROFILES` pattern) won't get the `+5` code-task routing bonus. Minor — routing still works via `bestTaskTypes` — but the cache's richer knowledge isn't feeding the router. |
| 7 | Low | Heuristic consistency | **Two different chars-per-token constants.** `capToContext` uses 3 chars/token; `estimatePrefill`/`recordUsage` use 4 (`CHARS_PER_TOKEN`). The 3 is a deliberate conservative overestimate for the budget cap (safer), but the divergence is undocumented at the `capToContext` site and reads like a bug. Add a one-line comment, or name the constant. |
| 8 | Low | Docs drift | **CLAUDE.md's "Version in three places" gotcha is now stale.** `version.ts` reads the version from `package.json` at runtime and `new Server()` uses `SERVER_VERSION`, so the `index.ts` site is no longer manual. It's now two places (`package.json` + `server.json`). The release checklist should be updated so nobody hand-edits a constant that no longer exists. |
| 9 | Low | Heuristic | **The 25%-of-context default output budget is crude at the extremes.** On a 1M-context model that's a 250k-token default, then the thinking path inflates ×4 before `capToContext` claws it back. It's safe (capped, plus the 400 self-heal), but a percentage-of-context default over-serves huge-context models. A min/max clamp (e.g. `clamp(ctx*0.25, 4096, 96000)`) would be tidier than relying on the cap to undo it. |

### What's notably good (keep doing)

- **Failure-mode discipline.** The mid-stream `data: {"error":{...}}` capture, prefill-vs-mid-stream timeout split, think-strip fallbacks (three shapes), and the context-overflow self-heal are all handling of real, observed backend misbehaviour — not speculative.
- **The prefill estimator.** Recency-weighted linear regression with an R²-gated refusal is a genuinely thoughtful solution to "will this call blow the client timeout," and the half-life decay handling a backend restart is a nice touch.
- **The cross-process lock.** Token-checked release so you can never delete a lock you don't own; age-first staleness so a reused PID can't pin a dead holder; fail-open throughout. This is hard to get right and it's right.
- **Atomic SQL upsert** in `recordPerformance` (`ON CONFLICT DO UPDATE SET col = col + excluded.col`) — closes the read-modify-write race the comment describes. Correct.

---

## Part 2 — What actually moved in the router world (Sept 2026)

Grounded research, cross-checked against the spec where it mattered.

### The headline: LLM routing + MCP tool routing are converging into "agent gateways"

In 2025 you had an LLM router (LiteLLM) managing API keys and a separate MCP server executing tools. In 2026 the two are merging. Projects like **Bifrost** (Go, ~10k RPS, single binary bundling LLM routing + agent routing + an MCP gateway), MetaMCP-style proxies, and MCP Router sit *between* the client and everything else, and they route **tool calls**, not just token generation. The gateway looks at a tool request and decides: frontier model, or intercept and run it locally?

That's the shift the user is pointing at. houtini-lm is on the right side of it (it's a delegation server) but on the old side of the interaction model (explicit tool the model must choose).

### The stateless-spec change — real, but narrower than it first looks

The `2026-07-28` MCP spec (confirmed via Context7, high-reputation source, 526 snippets) did land big changes:

- Protocol-level **sessions and `Mcp-Session-Id` are removed** from the Streamable HTTP transport.
- The **`initialize` handshake is gone** — every request now carries protocol version + capabilities; servers implement a discovery RPC.
- **SSE resumability and message redelivery are removed.**
- Servers needing cross-call state must mint **explicit handles** passed as tool arguments (the shopping-cart pattern).

**But** — and this is the correction to the alarming version of the story — these are **Streamable HTTP transport** changes, for scaling servers behind load balancers and serverless. houtini-lm runs on **stdio**, one long-lived process per client. Its state (the OS file lock, the model-keyed SQLite cache) was never MCP-session-tied, so nothing here is "now legacy" for the current product. The claim that the cross-process lock is obsolete is wrong *for stdio*. It becomes relevant only if houtini-lm goes remote/HTTP (platform move #3) — where, in a multi-instance serverless world, a file lock on one box doesn't serialise anything and you'd drop it or move to a shared lock.

### Local inference

- **SGLang** has become the engine of choice for *agentic tool-calling* loops — RadixAttention caches token prefixes across multi-step workflows (30–40% compute saving on agent loops), where vLLM still wins raw batch throughput. For delegation sequences that re-send shared context, SGLang is the faster backend. houtini-lm already surfaces prefix-cache hits (`prompt_tokens_details.cached_tokens` in the footer), so it's positioned to exploit this — it just doesn't recommend the backend or exploit stable-prefix ordering yet.
- **Speculative decoding** is now standard (vLLM EAGLE/FastMTP, SGLang Spec v2).
- **Qwen3-Coder-Next** is the current local-coding leader (the 32B and the 80B-A3B MoE), reportedly Sonnet-4.5-class on coding, single-4090/Apple-Silicon-friendly. The hardcoded `MODEL_PROFILES` / `PROMPT_HINTS` lists don't know it by name (the `qwen3.*coder` regex will match it, which is the saving grace) — but the curated knowledge base dates faster than the models do.

### Competitive

Delegation MCPs exist (Ollama-specific ones, a Python `local-llm-delegation-mcp` for Gemini CLI / Claude Code), and houtini-lm is cited as the polished one for desktop — think-block stripping, cross-process serialisation, streaming keepalives, quality flags. The moat is desktop-user robustness. The differentiation gap opening up is structured output and cascade/interception.

---

## Part 3 — Platform review: what to do next

Ranked by impact-per-effort. Each is independent; #1 and #6 are quick, #2 is the strategic bet, #3 is the growth path.

### 1. Structured tool output (`structuredContent` + `outputSchema`) — SMALL, do first

Return the footer data as data. Every inference tool gains an `outputSchema` and returns `structuredContent: { model, promptTokens, completionTokens, reasoningTokens, cachedTokens, tokPerSec, ttftMs, truncated, quality: [...], quotaSaved: {...} }` next to the human-readable text. Zero behaviour change, pure additive alignment with what 2026 orchestrators consume — and it makes houtini-lm's own quality signals machine-actionable (an orchestrator can branch on `truncated` or `contentFiltered` without regex-parsing the footer). This is the highest ratio of "credibility with the ecosystem" to "lines of code" on the list.

### 2. Verify-and-escalate cascade — MEDIUM, the differentiator

Add a delegation mode that: (a) runs the task on the local/cheap tier, (b) applies a cheap verifier (a schema check, a compile/lint for code, or a fast yes/no "did this answer the task" pass on a small model), (c) auto-escalates to a bigger tier (the DeepSeek tiers already behind the LiteLLM router) only on failure. This is RouteLLM's model-cascade pattern, and it's the single feature that would move houtini-lm from "a tool that delegates" to "a router that gets delegation *right*." It also directly answers the token-saving mission: most tasks stay on the free tier, only the hard ones cost. Fits the existing tiered-router deployment described in CLAUDE.md.

### 3. Remote / stateless HTTP transport — LARGER, the team-scale play

Adopt the `2026-07-28` stateless Streamable HTTP transport (needs SDK 2.x) so houtini-lm can run as a shared endpoint: one team GPU box, everyone's Claude delegating to it. This is how "my local model" becomes "our delegation gateway," and it's the natural home for the interception/agent-gateway story. Consequences to plan for: the cross-process **file lock stops working** across instances (drop it for batching backends, or move to a shared lock); state goes handle-based; keepalive/timeout logic changes shape. Keep stdio as the default — this is an additional transport, not a replacement.

### 4. Backend-aware guidance for SGLang + prefix caching — SMALL

Document SGLang as the recommended backend for multi-step delegation, and where the orchestrator re-sends shared context across a sequence, keep the stable prefix first so RadixAttention/prefix-cache hits land. The telemetry to prove it works (`cached_tokens`) already ships. Mostly docs + a prompt-ordering guarantee.

### 5. Cascade's cousin — interception/proxy mode — LARGE, speculative

The full agent-gateway version: houtini-lm as an MCP proxy that intercepts *other* servers' delegatable tool calls (boilerplate, format conversion) and transparently farms them to local, returning the result as if the original tool ran. This is the biggest bet and the biggest moat, but also the most likely to fight the MCP client's own routing and the hardest to make reliable. Worth a design spike, not a v-next commitment. #2 (cascade) is the tractable 80% of this idea.

### 6. Refresh the model knowledge base + harden the internals — SMALL, ongoing

Pull `MODEL_PROFILES` / `PROMPT_HINTS` out to a data file, add Qwen3-Coder-Next / DeepSeek-V4 / GLM-4.x / MiniMax-M2 / Kimi-K2 explicitly, and fold in audit findings #3 (a `node --test` unit suite + CI over the pure functions), #5 (decouple `recordUsage` from `formatFooter`), and #8 (fix the stale release checklist). Low-glamour, keeps the foundation sound while #1–#3 land.

### Suggested sequence

`3.3` → structured output (#1) + internals/tests (#6).
`3.4` → the cascade (#2), with SGLang guidance (#4) alongside.
`4.0` → remote stateless transport (#3) on SDK 2.x, and a design spike for interception (#5).

---

## Appendix — method & confidence

- Code findings: read directly from source at the commit above; every finding cites the mechanism, not a guess.
- Landscape: Gemini 3.1 grounded search, cross-checked against Context7's copy of the MCP `2026-07-28` spec and TS SDK. Where Gemini's framing overstated impact (the "your locks are legacy" claim), the spec text was read directly and the claim corrected — the stateless changes are HTTP-transport-scoped and don't affect the stdio product today.
- Not verified live: SGLang throughput figures and the Qwen3-Coder-Next benchmark numbers are from grounded search, not re-measured here. Treat model leaderboard specifics as directional.
