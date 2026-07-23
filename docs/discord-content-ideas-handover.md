# Handover: Discord → Content Ideas prompt system (via Houtini LM)

**For:** integrating into `content-machine` as a reusable prompt system.
**What it does:** turns raw Discord message exports (JSON) into a ranked, structured list of content ideas — recurring **problems**, the **solutions** the community gave, and **how-to guide** titles — ready to drop into an editorial backlog.
**Engine:** [Houtini LM](https://github.com/houtini-ai/lm) does the bulk analysis on a local (or cheap cloud) LLM so the token cost stays off your frontier bill.

---

## 1. Mental model

Houtini LM is **not** a Discord connector. It has no network access to Discord — it only takes text/files you hand it and runs them through an OpenAI-compatible LLM. So this system is a two-stage split:

```
[ Discord export → JSON ]      ← you already do this (Data Request / DiscordChatExporter / bot API)
          │
          ▼
[ Stage 0: PRE-PROCESS ]       ← plain code. Slim each message to {author, ts, text}. No LLM.
          │
          ▼  slimmed, chunked files on disk
[ Stage 1: MAP ]               ← Houtini `code_task_files`, one call per chunk, JSON-schema'd
          │
          ▼  N small arrays of ideas
[ Stage 2: REDUCE ]            ← Houtini `custom_prompt`, one call, dedupe + merge + rank
          │
          ▼
[ ranked content-idea list ]   ← content-machine consumes this
```

Claude (or content-machine's orchestrator) drives the stages; Houtini is the worker for Stages 1 and 2.

---

## 2. Hard constraints — design around these

These are the things that will break a naive "feed the whole server in one prompt" attempt:

| Constraint | Value | Consequence |
|---|---|---|
| **Model context window** | ~128k–262k tokens on typical local models (check `list_models`) | A full server export is millions of tokens. You **must** chunk. This is the real limit. |
| **Per-file size cap** | `HOUTINI_LM_MAX_FILE_MB`, default **10 MB** | `code_task_files` rejects files over the cap. Slim + split below it. |
| **Prefill timeout estimator** | auto, fires after ≥2 measured samples | `code_task_files` refuses a chunk early if measured data says prompt-processing would blow the client timeout. Size chunks conservatively (aim well under the context max). |
| **Local serialisation** | on for LM Studio/Ollama/vLLM/llama.cpp | Chunks run **one at a time** on a local box (single GPU). On cloud endpoints (DeepSeek/Groq/OpenRouter) they parallelise. Plan wall-clock accordingly. |

**Biggest lever:** Stage 0 slimming. Stripping a raw Discord message object down to `{author, ts, text}` typically cuts tokens 5–10×, so far more real content fits per chunk and you make fewer calls.

---

## 3. Stage 0 — pre-process (no LLM)

Goal: reduce noise and split into chunks that fit. Chunk **by channel** or **by time window**. Keep chunks comfortably under the model's context window (see §6 for sizing).

Field mapping from a standard Discord export message:

```
message.author.username   → author
message.timestamp         → ts   (date is enough; drop the time if you don't need it)
message.content           → text (skip empty / bot / system messages)
```

Drop everything else (IDs, avatars, embeds, reactions, attachments-metadata) unless a downstream idea genuinely needs it.

Reference slimmer (Node, adapt to content-machine's stack):

```js
// slim.mjs — Discord export JSON → chunked {author, ts, text} files
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const CHUNK_MSGS = 1500;              // tune to your model's context (see §6)
const src = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const msgs = (src.messages ?? src)   // DiscordChatExporter nests under .messages
  .filter(m => m.content && !m.author?.isBot)
  .map(m => ({
    author: m.author?.username ?? m.author?.name ?? 'unknown',
    ts: (m.timestamp ?? m.ts ?? '').slice(0, 10),
    text: m.content,
  }));

mkdirSync('chunks', { recursive: true });
for (let i = 0; i < msgs.length; i += CHUNK_MSGS) {
  const n = String(i / CHUNK_MSGS).padStart(3, '0');
  writeFileSync(`chunks/chunk-${n}.json`, JSON.stringify(msgs.slice(i, i + CHUNK_MSGS), null, 0));
}
console.log(`wrote ${Math.ceil(msgs.length / CHUNK_MSGS)} chunks, ${msgs.length} messages`);
```

Output: `chunks/chunk-000.json`, `chunk-001.json`, … each a flat array of slimmed messages, each file under the size cap.

---

## 4. Stage 1 — MAP (one Houtini call per chunk)

**Houtini tool:** `code_task_files` — the local model reads the chunk file directly from disk, so the JSON never passes through the orchestrator's context window.

**Why not `custom_prompt` here?** For large per-chunk payloads, `code_task_files` keeps the data out of Claude's context and gets the prefill estimator's protection. Use `custom_prompt` only if you're pasting a small chunk inline.

**Call shape:**

```jsonc
{
  "tool": "code_task_files",
  "paths": ["/abs/path/to/chunks/chunk-000.json"],   // absolute paths only
  "language": "json",
  "task": "<MAP INSTRUCTION — below>",
  "model": "<optional pin, e.g. qwen3-coder-30b-a3b>"
  // json_schema is passed via the code_task path; if your Houtini version
  // scopes json_schema to chat/custom_prompt, run the map with custom_prompt
  // and put the chunk in `context` instead. See §4.1.
}
```

**MAP instruction (the `task`):**

> You are a content strategist mining a developer community for article ideas. The input is a JSON array of Discord messages `{author, ts, text}`. Identify recurring **problems** users raise. For each distinct problem return: the problem stated plainly, the best solution offered in-thread (or `null` if none), a how-to guide title that would answer it, a frequency count (how many messages relate to it), and up to 2 short verbatim quotes. Ignore chit-chat, greetings, and off-topic messages. No preamble. Return JSON only.

**Output schema (`json_schema`):**

```json
{
  "name": "content_ideas",
  "schema": {
    "type": "object",
    "properties": {
      "ideas": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "problem":     { "type": "string" },
            "solution":    { "type": ["string", "null"] },
            "howto_title": { "type": "string" },
            "frequency":   { "type": "number" },
            "quotes":      { "type": "array", "items": { "type": "string" }, "maxItems": 2 }
          },
          "required": ["problem", "howto_title", "frequency"]
        }
      }
    },
    "required": ["ideas"]
  }
}
```

Suggested params: `temperature: 0.2` (extraction, not creativity).

### 4.1 Schema-availability note

`json_schema` (grammar-constrained output) is guaranteed on `chat` and `custom_prompt`. If your Houtini version doesn't accept `json_schema` on `code_task_files`, run the map as `custom_prompt` with:
- `system`: the persona line ("content strategist… no preamble, JSON only")
- `context`: the slimmed chunk (inline) — only viable if the chunk fits the orchestrator context
- `instruction`: the MAP instruction above
- `json_schema`: the schema above

For large chunks prefer `code_task_files` and, if it won't take a schema, add "Return **only** a JSON object matching `{ideas:[{problem,solution,howto_title,frequency,quotes}]}`" to the task text and validate/repair the output in code.

---

## 5. Stage 2 — REDUCE (one Houtini call, all chunk results)

After the map, you have N small `{ideas:[…]}` objects. Concatenate their `ideas` arrays and hand the combined list to one reduce pass. This payload is small (already-distilled ideas, not raw messages), so it fits easily and runs fast.

**Houtini tool:** `custom_prompt`.

```jsonc
{
  "tool": "custom_prompt",
  "system": "Editorial lead deduplicating a content backlog. Precise, no preamble, JSON only.",
  "context": "<the merged array of all per-chunk ideas>",
  "instruction": "<REDUCE INSTRUCTION — below>",
  "temperature": 0.2,
  "json_schema": "<REDUCE schema — below>"
}
```

**REDUCE instruction:**

> Merge near-duplicate problems into single entries, summing their frequencies. Keep the clearest problem statement and the strongest solution across the merged set. Rank the result by total frequency, highest first. Return the top 30. No preamble, JSON only.

**REDUCE schema** (same item shape, plus a stable rank):

```json
{
  "name": "ranked_content_ideas",
  "schema": {
    "type": "object",
    "properties": {
      "ideas": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "rank":        { "type": "number" },
            "problem":     { "type": "string" },
            "solution":    { "type": ["string", "null"] },
            "howto_title": { "type": "string" },
            "frequency":   { "type": "number" },
            "quotes":      { "type": "array", "items": { "type": "string" }, "maxItems": 2 }
          },
          "required": ["rank", "problem", "howto_title", "frequency"]
        }
      }
    },
    "required": ["ideas"]
  }
}
```

The final `ideas` array is what content-machine ingests.

---

## 6. Chunk sizing

1. Call `discover` (or `list_models`) — read the loaded model's **context window** and **measured tok/s**.
2. Budget the prompt at **~50–60% of the context window** to leave room for the system prompt, the schema grammar, and the output. The rest is headroom against the prefill estimator.
3. Slimmed `{author, ts, text}` messages average very roughly ~30–60 tokens each — so a 128k-context model comfortably takes ~1,000–1,500 messages/chunk. Start at the `CHUNK_MSGS = 1500` in the slimmer and adjust after the first real run (the footer reports actual tokens in→out).
4. If `code_task_files` refuses a chunk with a prefill diagnostic, halve `CHUNK_MSGS` and re-split.

---

## 7. Config / environment

Set on the Houtini MCP server process:

| Variable | Set to | Why |
|---|---|---|
| `HOUTINI_LM_FILE_ROOTS` | the exports/chunks dir | allowlists where `code_task_files` may read from |
| `HOUTINI_LM_MAX_FILE_MB` | e.g. `25` | raise if slimmed chunks still exceed 10 MB |
| `HOUTINI_LM_MODEL` | e.g. a coder/analysis model id | pin the worker model (per-call `model` overrides it) |
| `HOUTINI_LM_ENDPOINT_URL` | your LLM URL | local box or cloud endpoint |

Local vs cloud trade: **local** = free + private, but serialised (chunks run sequentially). **Cloud** (DeepSeek ~28c/M, Groq, Cerebras, OpenRouter) = parallel chunks, faster wall-clock, small cost.

---

## 8. Defining it as a content-machine prompt system

Model it as **one system with two prompt templates + a small orchestrator**, since content-machine drives the loop:

- **`discord-ideas.map`** — inputs: `chunkPath`. Tool: `code_task_files`. Carries the MAP instruction + `content_ideas` schema + `temperature 0.2`.
- **`discord-ideas.reduce`** — inputs: `mergedIdeas`. Tool: `custom_prompt`. Carries the REDUCE instruction + `ranked_content_ideas` schema + `temperature 0.2`.
- **Orchestrator glue** (content-machine code): run Stage 0 slimmer → `for each chunk: call map` → concat all `ideas` → `call reduce` → persist the ranked list.

Keep the two instructions and two schemas in this doc as the single source of truth; the orchestrator is just a loop + a concat.

---

## 9. QA checklist / gotchas

- [ ] **Absolute paths only** — `code_task_files` rejects relative paths.
- [ ] **Bot/system messages filtered** in Stage 0, or they pollute "problems".
- [ ] **First run is a calibration run** — the prefill estimator only engages after ≥2 measured samples, so the first chunk won't be refused; watch the footer's tokens-in figure and resize before a big batch.
- [ ] **Validate map output** — if you had to drop the schema on `code_task_files`, JSON-parse-and-repair each chunk result before the reduce; one malformed chunk shouldn't sink the run.
- [ ] **Watch the quality footer** — `TRUNCATED` or `hit-max-tokens` means a chunk was too big / output budget too small; the ideas from that chunk are partial.
- [ ] **De-dupe is only as good as the reduce** — if you have many chunks, consider a two-level reduce (reduce in groups, then reduce the reduces) to keep the final payload small.
- [ ] **Privacy** — slimmed exports still contain usernames and verbatim quotes. Decide whether to anonymise `author` in Stage 0 before anything leaves your machine (a non-issue on a local endpoint; matters on cloud).

---

## 10. One-line summary for the ticket

> Add a two-template Houtini-LM prompt system (`discord-ideas.map` / `discord-ideas.reduce`) that map-reduces slimmed Discord JSON exports into a ranked problem/solution/how-to backlog; orchestrator chunks the input, fans map calls per chunk, then reduces to the top 30.
