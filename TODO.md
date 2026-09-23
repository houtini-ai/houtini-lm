# TODO

Backlog for houtini-lm. Substantive work lives as **GitHub issues** (so CI, PRs
and discussion attach to it); this file is the quick index plus anything too
small to warrant an issue. Effort tags: **S** small, **M** medium, **L** large.

Most of the Sept 2026 platform review
([docs/PLATFORM-REVIEW-2026-09.md](docs/PLATFORM-REVIEW-2026-09.md)) shipped in
3.3.0 - see [Done in 3.3.0](#done-in-330) at the bottom. What's left:

## Open

### Declare `outputSchema` on the inference tools (S, needs client testing)

`structuredContent` ships without `outputSchema`, deliberately: on the low-level
`Server` a declared schema invokes client-side validation and risks an
outputSchema-aware client rendering *only* the structured object and dropping the
answer text. Test against Claude Desktop and Claude Code: if the answer still
renders from `content` with `outputSchema` present, add permissive schemas to the
`TOOLS` entries; if a client hides `content`, carry the answer inside
`structuredContent` first. The live fleet runs the npm build through the Docker
MCP Gateway, so this needs a published (or locally mounted) build to test.

### Verify-and-escalate cascade (M) - the differentiator

Delegate to the local/cheap tier, apply a cheap verifier (JSON-schema check,
compile/lint for code, or a fast yes/no "did this answer the task" pass), and
escalate to a bigger router tier only on failure. The RouteLLM cascade pattern,
and the token-saving mission done properly - most tasks stay free, only the hard
ones cost. 3.3.0 laid the groundwork: houtini-lm now knows each router alias's
real model and limits, which the escalation policy needs. Design the
verifier-per-task policy in an issue before any code.

### Remote / stateless HTTP transport (L) - demoted

Found on 2026-09-23: this fleet already serves houtini-lm over HTTP by running it
under the **Docker MCP Gateway** (`docker/mcp-gateway`, which wraps the stdio
server). So the team-endpoint need is met at the infra layer, and native support
for the 2026-07-28 stateless Streamable HTTP transport (SDK 2.x) drops to "only if
someone needs it without a gateway". If it's ever built: the cross-process file
lock means nothing across instances, and state goes handle-based.

### Interception / proxy mode (L, spike only)

The full agent-gateway idea: sit as an MCP proxy in front of other servers and
transparently farm delegatable tool calls out. Biggest moat, biggest risk (fights
the client's own routing). The cascade is the tractable 80% - spike this, don't
commit to it.

### Docker MCP Gateway gaps (S, deployment + docs)

- **Ephemeral state.** The gateway starts a fresh container per session, so
  `~/.houtini-lm` - lifetime stats, profiles, prefill samples, the lock file - is
  thrown away every time (troubleshooting.md now says to mount a volume). Worth
  doing on this fleet's gateway config, and worth a line in the setup guides once
  the gateway's volume syntax is confirmed.
- **Progress notifications.** A ~6k-token generation timed out through the
  gateway while the same work in two ~1-2k chunks finished in 19s and 27s.
  Confirm whether `docker/mcp-gateway` forwards `notifications/progress`; if it
  doesn't, that's an upstream issue, and chunking is the workaround.
- **Pin the default model in the gateway config.** It sets endpoint, key,
  serialise and thinking, but not `HOUTINI_LM_MODEL` - so unpinned calls from any
  session go to `local`, the GPU. `astra` (or a DeepSeek tier) is probably the
  intended default.

### Lazy re-profiling (S)

`profileModelsAtStartup()` runs once at boot. Inference self-heals if the
endpoint comes up later (the model list is re-fetched, and the backend is only
cached on a *successful* probe), but profiling doesn't. Re-run it lazily when
the cache is empty.

### Finish extracting from `index.ts` (M)

3.3.0 moved the side-effect-free helpers into `src/pure.ts` (and the router
parsing into `src/litellm.ts`), which is what made them testable. Still inside
the ~2,900-line `index.ts`: `routeToModel`, `formatFooter`, `assessQuality`,
`buildStructured`, `getReasoningEffortValue` and the provider profile. They lean
on module state (session counters, the detected backend), so extracting them
means passing that state in - worth it for test coverage of routing in particular.

### Small

- **Footer em-dashes (optional, touches snapshots).** Runtime output uses
  em-dashes (`💰 Claude quota saved — …`, the reasoning-overhead line). If the
  house spaced-hyphen convention extends to runtime output, normalise it along
  with the shakedown snapshots and anything that asserts on the footer.
- **Model knowledge base as data.** `MODEL_PROFILES` / `PROMPT_HINTS` are code;
  a data file would date more gracefully. 3.3.0 refreshed the contents
  (DeepSeek, Gemma, hosted GPT-5/6, Kimi K3) but not the format.

## Done in 3.3.0

Router alias resolution via `/model/info` (the old top item here) · real
context and output limits from the router · non-chat models filtered from
discover/list/routing · 429 backoff for routers + `HOUTINI_LM_RETRY_RATELIMIT`
opt-in · budgets sized from the targeted model, not the first listed · budgets
clamped to the model's declared max output (this replaced the "clamp the 25%
default" item - a cap tied to the model beats an arbitrary ceiling, since the
budget is headroom, not consumption) · `structuredContent` on the inference tools
· `recordUsage` decoupled from `formatFooter` · unit tests (`node:test`, 21) + CI
on Node 22/24 · routing reads auto-generated profiles for the coder bonus · named
chars-per-token constants · `fitPrefillLinear` zero-variance bug (found by the new
tests) · discover capped and honest about guessed context · SGLang guidance ·
model profile refresh · 3.2.4 changelog backfill · CLAUDE.md brought up to date.
