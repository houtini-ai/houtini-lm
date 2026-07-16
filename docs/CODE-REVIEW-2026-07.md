# Code review — houtini-lm (July 2026)

Review performed ahead of returning the server to active use, with a specific
eye on the intended deployment: **Claude as an orchestrator delegating bounded
coding/data tasks to a fast local model**, potentially fanning out across
multiple agents.

**Method.** Eight independent finder passes (three correctness angles across
`index.ts` and `model-cache.ts`, plus concurrency/multi-client, security,
network-robustness, cleanup/efficiency, and docs/config/test consistency). Every
candidate was then adversarially verified against the source. 40 findings
survived verification (37 confirmed, 3 plausible). Nothing below is a style nit —
each has a concrete failure scenario.

**Status legend:** ✅ fixed in this PR · ⏳ follow-up (documented, not yet done).

---

## Orchestration-readiness: the headline

The design is sound and well-suited to the orchestrator pattern — the tool
surface, delegation framing, quality signals, and speed telemetry are all
oriented toward an agent making delegation decisions. The gap is entirely at the
execution level, and it clusters in two places that matter *specifically* under
multi-agent load:

1. **Coordination state is per-process, but your deployment is multi-process.**
   Each MCP client connection spawns its own `houtini-lm` process. The inference
   lock (`index.ts:249`), the keepalive timing, and the SQLite stats cache
   (`model-cache.ts`) all assume one process with one in-flight call. Across
   several agents they don't see each other: the lock doesn't serialize, and the
   processes clobber each other's stats file with last-writer-wins whole-file
   writes. This is the biggest distance between what the server is and what you
   want it to be. It needs a cross-process design (a real embedded SQLite with
   WAL, and either a file-based lock or delegating queueing to the backend).

2. **Several paths return corrupted output as a confident success.** For an
   orchestrator whose whole model is "the local model does the work and Claude
   QAs it," a confidently-wrong result is worse than an error, because the QA
   loop assumes a returned result was a genuine attempt. The mid-stream-error
   swallow, the think-tag over-strip, and the unloaded-model-reported-as-ONLINE
   bugs are all in this class. (The first and third are fixed here.)

Recommended sequencing: (1) silent-corruption + notification flood — done here;
(2) the multi-process concurrency rework; (3) accuracy/telemetry using
server-provided stats; (4) file-read confinement + credential redaction;
(5) docs/CI cleanup.

---

## Critical — correctness / silent corruption

- ✅ **Mid-stream backend errors were silently discarded** — `index.ts` SSE loop.
  A `data: {"error":{...}}` event (OpenRouter/vLLM/llama.cpp emit these on
  backend failure) parsed cleanly, matched no field, and the stream then ended
  normally, so the partial/empty content was returned as a non-truncated
  success. *Fixed:* the loop now captures the error, stops reading, throws when
  nothing usable arrived, and otherwise flags `⚠ UPSTREAM ERROR` in the footer.

- ✅ **`discover` reported an unloaded model as the active model** — `index.ts`
  discover handler. With models downloaded but none loaded, `loaded[0] ||
  models[0]` picked an unloaded model and the tool said "Status: ONLINE / Active
  model: X / you can delegate." *Fixed:* a `loaded.length === 0` guard now
  returns the distinct "no model loaded" status listing the models to load.

- ⏳ **Orphaned-`</think>` strip can delete a legitimate answer** —
  `index.ts:987`. `replace(/^[\s\S]*?<\/think>\s*/, '')` removes everything
  before the first literal `</think>`, even when that text is the real answer
  (e.g. the model quoting code that contains the string). The only guard fires
  when the result is *entirely* empty, so partial destruction passes silently.
  Fix: only strip when an opener was actually seen, or when the prefix looks like
  reasoning.

- ⏳ **`code_task` silently defeats its own documented token default** —
  `index.ts` code_task handler. It passes `codeMaxTokens ?? DEFAULT_MAX_TOKENS`
  (16,384), which makes `options.maxTokens` truthy so the 25%-of-context
  auto-derivation never runs — the schema promises ~65K on a 262K-context model
  but callers get 16K, and long generations are cut off at `finish_reason:
  length`. `code_task_files` deliberately passes the raw value with a comment
  explaining exactly this. Fix: pass `codeMaxTokens` through unchanged.

- ⏳ **`custom_prompt`'s `json_schema` silently produces unconstrained output** —
  `index.ts`. The input schema is a bare `object` with no required `name`/
  `schema`, but the handler reads `json_schema.name`/`json_schema.schema`. A
  caller passing a plain JSON Schema (as the description invites) yields
  `response_format` with `undefined` fields — the backend 400s or returns
  unconstrained text despite the "guaranteed valid JSON" promise. Fix: validate
  the wrapper shape, or accept a bare schema and wrap it.

## Critical — concurrency / multi-process (the orchestration blockers)

- ⏳ **Inference lock is per-process** — `index.ts:249`. Module-level promise
  chain; multiple connections = multiple processes = parallel hits on the single
  loaded model, the exact pile-up the lock exists to prevent. Everyone gets
  prefill-stall/truncated partials.

- ⏳ **Stats DB does last-writer-wins whole-file clobbering** —
  `model-cache.ts:285`. sql.js holds the DB in memory; `saveDb()` writes the
  entire snapshot with a plain `writeFileSync` after every call. Two processes
  erase each other's history; a crash mid-write truncates the file, which
  `initDb` then treats as "corrupt — start fresh," wiping all lifetime stats and
  prefill calibration. Fix: temp-file + atomic rename at minimum; ideally move to
  `node:sqlite`/better-sqlite3 with WAL.

- ⏳ **`initDb` has no in-flight guard** — `model-cache.ts:197`. Concurrent first
  callers at startup (`hydrateLifetimeFromDb` + `profileModelsAtStartup`, fired
  without awaiting) both pass `if (db) return db`, build two `Database`
  instances, and the later assignment orphans the earlier one's writes. Fix:
  cache the in-flight init promise.

- ⏳ **`recordPerformance` is a non-atomic read-modify-write** —
  `model-cache.ts:927`. `await getPerformance()` then `UPDATE` with absolute
  values; concurrent fire-and-forget calls lose updates, and two concurrent
  first-calls both `INSERT` → swallowed `UNIQUE constraint` throw drops a whole
  record. Fix: relative `UPDATE ... SET x = x + ?` / a real upsert.

- ⏳ *(plausible)* **`hydrateLifetimeFromDb` races startup tool calls** —
  `index.ts:102`. `modelStats.clear()` + wholesale overwrite can erase an
  in-memory increment from a call that completed during hydration (resurfaces on
  next restart).

## High — network robustness / hangs

- ⏳ **Body reads are unbounded after `fetchWithTimeout` clears its timer** —
  `index.ts:566`. The abort timer is cleared when headers arrive, so
  `res.json()`/`res.text()` in `listModelsRaw`/`embed`/error paths have no
  timeout — a server that flushes headers then wedges hangs the tool call
  forever. Fix: apply a read deadline to the body, not just the connect.

- ⏳ **Non-idempotent completion request retried on abort** — `index.ts:612`.
  `fetchWithRetry`'s catch re-POSTs `/v1/chat/completions` after *any* throw,
  including the connect-timeout `AbortError`, so a slow-to-flush request can be
  submitted up to 3× — duplicate (billed) generations on OpenRouter. Fix: don't
  retry once the request body has been sent, or only retry explicit 429/503.

- ⏳ **Retry backoff undercuts server `Retry-After`** — `index.ts:607`. The
  server-mandated delay is multiplied by random `0.5–1.5` (and hard-capped at
  10s), so the client can retry at half the demanded wait, burn its retry
  budget, and surface a rate-limit error that honoring the header would have
  avoided. Fix: jitter upward only; never below `Retry-After`.

- ✅ **Progress notifications fired per token** — `index.ts` SSE loop. One
  JSON-RPC `notifications/progress` per content/reasoning delta — ~145/sec on a
  145 tok/s model, flooding stdio. *Fixed:* per-delta updates now go through a
  time-throttled `sendStreamProgress` (500 ms floor), decoupling notification
  rate from token rate. The immediate connect ping and interval keepalives are
  unchanged.

- ⏳ **Queued-behind-lock calls send no keepalive and become zombies** —
  `index.ts:654`. Progress starts *inside* the inner fn, after the lock is
  acquired, so a call waiting behind a long one emits nothing, trips the client's
  ~60s timeout — and then still executes, occupying the model for output nobody
  receives. Under fan-out the zombie queue grows unbounded. Fix: emit keepalives
  while queued, and honor a cancellation signal.

- ⏳ **`embed` serialises the full vector into text with no cap** — `index.ts`
  embed handler. An 8k-dim model produces a ~150KB+ JSON blob injected into the
  client context. Fix: truncate/summarize, or return a resource link.

## High — metrics accuracy (feeds the orchestrator's delegation decisions)

- ✅ **tok/s conflated prefill with decode** — `index.ts` (`recordUsage`,
  `assessQuality`, `formatFooter`). Throughput divided token count by the full
  `generationMs`, which includes connect + prefill, so a big-prompt call looked
  many times slower than the model decodes (e.g. 4.3 tok/s reported vs 30
  actual). Since these numbers drive Claude's delegation calculus and the
  first-call benchmark line, they were suppressing delegation. *Fixed:* a shared
  `computeTokPerSec` helper now subtracts TTFT to isolate the decode window (also
  collapsing the three duplicated formulas). Verified against the finding's
  scenario (300 tokens after 60s prefill → 30 tok/s).

- ⏳ **TTFT includes the reasoning phase for thinking models** — `index.ts:914`.
  `ttftMs` is set on the first *visible* content chunk, ignoring earlier
  `reasoning_content`, so a DeepSeek-R1/Nemotron call records a huge "TTFT" that
  contaminates the linear prefill fit and causes spurious `code_task_files`
  refusals. (This is why the tok/s fix above is noted as partial — a full fix
  needs a separate reasoning-vs-prefill TTFT split.)

- ⏳ **Ratio prefill estimator mixes denominators** — `index.ts:1289`. Average
  prompt tokens is over all calls; average TTFT is over only TTFT-bearing calls —
  skews prefill tok/s whenever some calls lack TTFT, causing wrong
  refuse/allow decisions on large inputs. Fix: use the same call population for
  both averages.

- ⏳ **`getReasoningEffortValue` contradicts its docstring** — `index.ts:1225`.
  Docstring says unknown backends get `null`/omit "rather than risk a 400," but
  it returns `'low'` for any non-lmstudio/ollama backend — a strict
  OpenAI-compatible backend that rejects `reasoning_effort` then 400s every
  thinking-model call. Fix: return `null` for unknown backends as documented.

## High — security (threat model: prompt-injected client, possibly-remote endpoint)

- ⏳ **`code_task_files` reads any absolute path, no confinement** —
  `index.ts:1992`. Only an `isAbsolute()` check — no allowlist, root, or symlink
  handling. A prompt-injected client can read `~/.ssh/id_rsa`, `~/.aws/
  credentials`, etc. and ship them to the configured endpoint (remote when
  `HOUTINI_LM_PROVIDER=openrouter`) and back into the conversation. Fix: confine
  reads to a configured root / opt-in allowlist; resolve symlinks.

- ⏳ **Credentials in the endpoint URL leak into output** — `index.ts:2168` (also
  offline errors, `stats`, and the `houtini://metrics/session` resource).
  `LM_BASE_URL` is echoed verbatim, so a `https://user:pass@host` or
  `?api_key=...` endpoint exposes the secret on every discover/metrics call. Fix:
  redact userinfo/query secrets before display.

- ⏳ **Local-model output relayed with a forgeable trust boundary** —
  `index.ts:2090`. Untrusted model output is concatenated with the trusted footer
  using a `---` delimiter; analyzed file content can steer the model to emit its
  own `---`/`Quality:` block that reads as first-party server metadata. Fix:
  fence/encode model output, or move metadata to MCP structured content.

- ⏳ **Unsanitized HuggingFace card fields interpolated into output** —
  `model-cache.ts:545`. `cardData.license`/description from a fetched HF model
  card are rendered as trusted metadata in `discover`/`list_models`; a squatted
  HF repo matching a local model id becomes an injection vector. Fix: sanitize/
  length-bound card fields.

- ⏳ *(plausible)* **No file-size cap before read in `code_task_files`** —
  `index.ts:1991`. Files are fully read before the token estimator runs. Node
  rejects a single file >2GiB and utf8 decode >~512MiB, so `Promise.allSettled`
  turns those into inline "READ FAILED" rather than a crash — but several large
  under-limit files can still exhaust memory. Fix: stat + cap before reading.

## Medium — cache correctness / resource leaks

- ⏳ **Stale HF profile overwritten with a degraded one on lookup failure** —
  `model-cache.ts:694`. When a rich `huggingface` profile goes stale and the
  offline HF lookup fails, it's replaced with a minimal `inferred` row (and
  `supportsThinkingToggle` recomputed from arch alone, which can flip it),
  *plus* `fetchedAt` reset — so HF isn't retried for another 7 days. Fix: keep
  stale data when the refresh fails.

- ⏳ **`toModelProfile` JSON.parse without try/catch** — `model-cache.ts:378`.
  Unlike `safeParseArray` elsewhere, one malformed column throws (swallowed into
  a silently-missing profile via the caller's catch). Low likelihood (writes are
  always `JSON.stringify`d) but trivial to harden.

- ⏳ **`getAllCachedProfiles` frees its statement outside `finally`** —
  `model-cache.ts:779`. An iteration throw leaks the WASM statement, unlike its
  sibling functions. Fix: `finally { stmt.free(); }`.

## Low — cleanup / efficiency (named by the finders, worth doing opportunistically)

- ⏳ **Model list re-fetched (twice) per call, no TTL** — `index.ts:658`.
  `routeToModel`→`listModelsRaw` then `getActiveModel`→`listModelsRaw` again per
  request, and non-LM-Studio backends re-probe the doomed `/api/v0/models` each
  time. On a fast model this overhead is a meaningful share of the round-trip.
  Fix: short-TTL cache + skip probes once the backend is known.

- ⏳ **Two full-DB serializations + writes per call** — `model-cache.ts:976`.
  `recordPerformance` and `recordPrefillSample` each end with `saveDb()`, both
  fired fire-and-forget per call — redundant I/O that also races. Fix: single/
  debounced save per call.

- ⏳ **Duplicated SSE delta parsing** — `index.ts` main loop vs final-buffer
  flush. The copies had already drifted (flush lacked the progress calls);
  extract a `parseSseChunk`. (Both copies were touched consistently in this PR
  for the error-capture fix, but they remain unshared.)

- ⏳ **Duplicated handler boilerplate** — `index.ts` `custom_prompt` duplicates
  `chat`'s systemContent merge + `ResponseFormat` construction; `model-cache.ts`
  `getAllCachedProfiles` duplicates `getCachedProfile`'s 17-column mapping.
  Extract `buildSystemContent`/`toResponseFormat`/`rowToProfile`.

## Low — docs / config / CI (fix before re-release)

- ⏳ **`benchmark.mjs` hardcodes Windows paths from another repo** —
  `benchmark.mjs:65`. `C:/MCP/houtini-lm/...` (and a sibling `gemini-mcp` repo)
  at module top-level → `ENOENT` on any other machine. Unrunnable as shipped.

- ⏳ **`shakedown.mjs` ignores documented env + auth** — `shakedown.mjs:25`.
  Reads only legacy `LM_STUDIO_URL` (not the README-documented, code-preferred
  `HOUTINI_LM_ENDPOINT_URL`) and sends no `Authorization` header, so the
  canonical self-test 401s on any authenticated endpoint and can target the
  wrong server.

- ⏳ **Two release workflows double-fire on `v*` tags** — `.github/workflows/
  release.yml` + `release-auto.yml`. Both create a release for the same tag →
  the loser fails `already_exists`; `release.yml` also uses archived
  `actions/create-release@v1` and references docs/dirs (`COMPLETE_GUIDE.md`,
  `cd local-llm-mcp`) that don't exist here. Fix: keep one workflow.

- ⏳ **"Seven tools" docs vs eight registered** — `README.md:365`,
  `DEVELOPER.md`. `stats` isn't counted or exercised, and `shakedown` hits the
  raw `/v1` HTTP API rather than the MCP tool-dispatch layer, so a regression in
  either passes the "full coverage" self-test.

- ⏳ **`test-mcp-e2e.mjs` banner prints the wrong env var** —
  `test-mcp-e2e.mjs:89`. Prints `LM_STUDIO_URL` though DEVELOPER.md documents
  invoking with `HOUTINI_LM_ENDPOINT_URL` → "Target: undefined" in the output.

---

## Appendix A — making the server more "prolific" in Claude's workflow

The lever for more delegation isn't more features — it's **trust plus honest
latency data**:

- **Kill the silent-corruption class first** (above). Every confidently-wrong
  return teaches the orchestrator to stop delegating.
- **Keep the speed numbers honest** (tok/s fix done; TTFT-for-thinking-models
  still open). The first-call benchmark line is a strong idea only if accurate.
- **Return structure, not prose.** The quality signals are string-appended after
  a forgeable `---`. Emitting them as MCP *structured content* lets Claude branch
  on `truncated`/`streamError`/`finishReason` programmatically ("if truncated,
  re-run smaller") instead of parsing — and closes the footer-forgery vector.
- **Cut per-call overhead** (double model-list fetch) — proportionally larger on
  a fast model.

## Appendix B — the 145 tok/s question (and why polling doesn't cover it)

Counter-intuitively, a *fast* model made the old progress code *worse*, not
safer: one notification per token = ~145 JSON-RPC messages/sec over stdio. The
keepalive machinery was calibrated for the slow case (keep a 3-minute call
alive) and did the wrong thing at the fast end. The fix here decouples
notification rate from token rate (time-throttled), which serves both ends.
Secondary: at 145 tok/s most bounded tasks finish well inside the client's ~60s
timeout, so the pressure shifts from *generation* keepalive to *prefill*
keepalive — and prefill is exactly what the estimator still mis-measures
(TTFT-for-thinking-models, ratio-denominator).

## Appendix C — API data currently ignored that's worth capturing

The model server already measures things the code re-derives (often wrongly):

- **LM Studio's native `stats` object** (`/api/v0/chat/completions`) returns
  authoritative `tokens_per_second`, `time_to_first_token`, and `generation_time`
  — using these would sidestep the tok/s and TTFT-contamination math entirely.
- **`usage.prompt_tokens_details.cached_tokens`** — prompt-cache hits; a strong
  "this delegation was nearly free" signal for the orchestrator. (The reasoning
  split `completion_tokens_details.reasoning_tokens` is already used.)
- **OpenRouter `usage.cost` + `x-ratelimit-remaining` header + `native_finish_
  reason`** — real spend and remaining budget for a remote-backed orchestrator.
- **`finish_reason: "content_filter"`** — currently lumped with `length`/`stop`;
  worth distinguishing since it means "refused," which the orchestrator should
  handle differently from truncation.
