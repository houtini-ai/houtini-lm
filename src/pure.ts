/**
 * pure.ts - side-effect-free helpers lifted out of index.ts.
 *
 * index.ts starts the MCP server the moment it's imported, so nothing inside it
 * can be unit-tested. These helpers carry real logic (range validation, secret
 * redaction, budget sizing) and live here so `node --test` can import them.
 */

// ── Token estimation ────────────────────────────────────────────────

/**
 * Rough chars→tokens ratio for estimates (pre-flight prefill, missing usage).
 * Typical English + code lands near 4.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Deliberately pessimistic ratio used ONLY when capping the output budget to
 * the context window. Overestimating the prompt leaves a smaller, safer output
 * budget - strict backends 400 on prompt + max_tokens > context, so erring low
 * here is the right direction. (Not a typo for CHARS_PER_TOKEN.)
 */
export const PROMPT_CHARS_PER_TOKEN_CONSERVATIVE = 3;

/** Conservative prompt-size estimate: pessimistic ratio + per-message framing + margin. */
export function estimatePromptTokens(promptChars: number, messageCount: number): number {
  return Math.ceil(promptChars / PROMPT_CHARS_PER_TOKEN_CONSERVATIVE) + 64 * messageCount + 512;
}

// ── Output budget ───────────────────────────────────────────────────

/** Share of the context window allocated as the default output budget. */
export const AUTO_BUDGET_FRACTION = 0.25;

/**
 * Default output budget when the caller doesn't set one: a quarter of the
 * model's context window, or `fallback` when the window is unknown. Generous
 * on purpose - the budget is a ceiling, not consumption.
 */
export function autoOutputBudget(contextLen: number | undefined, fallback: number): number {
  return contextLen ? Math.floor(contextLen * AUTO_BUDGET_FRACTION) : fallback;
}

/**
 * Clamp a requested output budget to what the backend will actually accept:
 * never above the model's declared max output (a hosted model 400s on
 * max_tokens past it - e.g. a 922k-context model with a 128k output cap), and
 * never so large that prompt + output overflows the context window. When the
 * prompt alone fills the window we leave the request alone and let the backend
 * report the real overflow.
 */
export function capOutputBudget(
  requested: number,
  o: { contextLen?: number; maxOutput?: number; promptChars: number; messageCount: number },
): number {
  let n = requested;
  if (o.maxOutput && o.maxOutput > 0) n = Math.min(n, o.maxOutput);
  if (o.contextLen) {
    const room = o.contextLen - estimatePromptTokens(o.promptChars, o.messageCount);
    if (room > 0) n = Math.min(n, room);
  }
  return n;
}

/** The thinking-model safety net: inflate so hidden reasoning can't starve the answer. */
export function inflateForThinking(budget: number): number {
  return Math.max(budget * 4, budget + 2000);
}

// ── Prefill-estimate confidence ─────────────────────────────────────

/**
 * How far past the largest measured prompt a ratio estimate may extrapolate
 * and still be trusted enough to refuse a call.
 */
export const RATIO_EXTRAPOLATION_LIMIT = 4;

/**
 * Is a prefill estimate trustworthy enough to REFUSE a call on? A false
 * refusal is worse than a false-ok (the keepalive and timeout machinery handle
 * the latter), so only two cases qualify:
 *
 * - a linear fit that actually fits (R² ≥ 0.5) - it separates the fixed
 *   per-request overhead from per-token cost, so extrapolating is its job;
 * - a ratio estimate that is INTERPOLATING - the input is within
 *   RATIO_EXTRAPOLATION_LIMIT× of the largest prompt we've measured.
 *
 * The ratio (Σprompt ÷ ΣTTFT) folds fixed overhead into the rate. For a hosted
 * model behind a router, TTFT on a tiny prompt is mostly network and queueing:
 * two 72-token samples at ~3.5s read as "20 tok/s", and extrapolating that
 * 190× to a 14k-token input predicted ~11 minutes of prefill for a model that
 * does it in seconds - refusing a call it would have handled easily.
 */
export function isConfidentPrefillEstimate(e: {
  basis: 'linear-fit' | 'ratio' | 'default';
  inputTokens: number;
  fit?: { r2: number };
  maxSampledPromptTokens?: number;
}): boolean {
  if (e.basis === 'linear-fit') return (e.fit?.r2 ?? 0) >= 0.5;
  if (e.basis === 'ratio') {
    return !!e.maxSampledPromptTokens && e.inputTokens <= e.maxSampledPromptTokens * RATIO_EXTRAPOLATION_LIMIT;
  }
  return false;
}

// ── Argument validation ─────────────────────────────────────────────

/** Optional per-request sampling controls, passed through to the backend when set. */
export interface SamplingParams {
  seed?: number;
  stop?: string | string[];
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

/**
 * Extract and RANGE-VALIDATE optional sampling params from tool args. Out-of-range,
 * NaN, or wrong-type values are dropped (undefined) rather than forwarded - the
 * backend then applies its own default.
 */
export function extractSamplingParams(args: Record<string, unknown>): SamplingParams {
  const range = (v: unknown, min: number, max: number): number | undefined => {
    const n = typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
  };
  const stopRaw = args.stop;
  const stop = typeof stopRaw === 'string'
    ? stopRaw
    : Array.isArray(stopRaw)
      ? (stopRaw.filter((s) => typeof s === 'string').slice(0, 4) as string[])
      : undefined;
  return {
    seed: Number.isInteger(args.seed) ? (args.seed as number) : undefined,
    stop: stop && stop.length ? stop : undefined,
    topP: range(args.top_p, 0, 1),
    topK: range(args.top_k, 1, 100_000),
    repeatPenalty: range(args.repeat_penalty, 0, 2),
    frequencyPenalty: range(args.frequency_penalty, -2, 2),
    presencePenalty: range(args.presence_penalty, -2, 2),
  };
}

/** Clamp a caller-supplied temperature to a sane range, or undefined if unusable. */
export function validTemperature(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : undefined;
}

/**
 * Validate a caller-supplied max_tokens. Returns undefined (use the dynamic
 * budget) for anything non-integer, non-positive, absurd, or below `floor` -
 * MCP clients habitually pass tiny caps like 256 that strangle reasoning models.
 * `onBelowFloor` lets the caller log the override.
 */
export function validMaxTokens(
  v: unknown,
  floor: number,
  onBelowFloor?: (n: number) => void,
): number | undefined {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > 1_000_000) return undefined;
  if (n < floor) {
    onBelowFloor?.(n);
    return undefined;
  }
  return n;
}

/** OpenAI-compatible response_format for structured output */
export interface ResponseFormat {
  type: 'json_schema' | 'json_object' | 'text';
  json_schema?: {
    name: string;
    strict?: boolean | string;
    schema: Record<string, unknown>;
  };
}

/**
 * Build an OpenAI response_format from the tool's json_schema input. Accepts
 * BOTH the documented wrapper `{ name, schema, strict }` and a bare JSON Schema.
 */
export function toResponseFormat(js: unknown): ResponseFormat | undefined {
  if (!js || typeof js !== 'object') return undefined;
  const obj = js as Record<string, unknown>;
  const hasWrapper = !!obj.schema && typeof obj.schema === 'object';
  const schema = (hasWrapper ? obj.schema : obj) as Record<string, unknown>;
  const name = hasWrapper && typeof obj.name === 'string' ? obj.name : 'response';
  const prepared = prepareStrictSchema(schema);
  // Strict unless the caller said otherwise AND the schema can be strict:
  // OpenAI rejects a strict schema with optional properties outright, so a
  // schema with them goes non-strict rather than failing or being rewritten.
  const wanted = hasWrapper && typeof obj.strict === 'boolean' ? obj.strict : true;
  return { type: 'json_schema', json_schema: { name, strict: wanted && prepared.strictOk, schema: prepared.schema } };
}

/**
 * Make a JSON Schema acceptable to OpenAI's strict structured outputs, which
 * require every object to declare `additionalProperties: false` and to list
 * every property in `required`. The first is added wherever it's missing (it
 * only forbids keys the schema never mentioned). The second would change the
 * schema's meaning, so it's never forced: `strictOk` comes back false instead
 * and the caller sends the schema non-strict. Returns a copy.
 */
export function prepareStrictSchema(schema: Record<string, unknown>): { schema: Record<string, unknown>; strictOk: boolean } {
  let strictOk = true;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, walk(pv)]))
        : walk(v);
    }
    const isObject = out.type === 'object' || (out.properties && typeof out.properties === 'object');
    if (isObject) {
      if (out.additionalProperties === undefined) out.additionalProperties = false;
      else if (out.additionalProperties !== false) strictOk = false;
      const props = Object.keys((out.properties as Record<string, unknown>) ?? {});
      const required = Array.isArray(out.required) ? (out.required as unknown[]) : [];
      if (props.some((p) => !required.includes(p))) strictOk = false;
    }
    return out;
  };
  return { schema: walk(schema) as Record<string, unknown>, strictOk };
}

/**
 * Fallback for backends that don't support json_schema response formats
 * (DeepSeek: "This response_format type is unavailable"). Plain JSON mode plus
 * the schema written into the system prompt gets valid, usually conforming,
 * JSON; json_object mode also needs the word "JSON" in the prompt, which this
 * supplies.
 */
export function isUnsupportedSchemaFormat(errText: string, body: Record<string, unknown>): boolean {
  const rf = body.response_format as ResponseFormat | undefined;
  return rf?.type === 'json_schema' && !!rf.json_schema?.schema && /response_format|json_schema/i.test(errText);
}

export function schemaInstruction(schema: Record<string, unknown>): string {
  return `Respond with a single JSON object that conforms to this JSON Schema, and nothing else:\n${JSON.stringify(schema)}`;
}

// ── Transport helpers ───────────────────────────────────────────────

/**
 * Redact secrets embedded in an endpoint URL before echoing it to the client
 * or logs. Strips userinfo (`user:pass@`) and common secret query params.
 * Returns the input unchanged when it parses to no secret.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    let hadSecret = false;
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      hadSecret = true;
    }
    for (const key of ['api_key', 'apikey', 'key', 'token', 'password', 'access_token']) {
      if (u.searchParams.has(key)) {
        u.searchParams.set(key, '***');
        hadSecret = true;
      }
    }
    return hadSecret ? u.toString() : raw;
  } catch {
    return raw;
  }
}

/** Parse Retry-After (seconds or HTTP-date) into ms. Null for unparseable. */
export function parseRetryAfter(headerValue: string | null, now: number = Date.now()): number | null {
  if (!headerValue) return null;
  const asInt = parseInt(headerValue, 10);
  if (Number.isFinite(asInt) && asInt >= 0) return asInt * 1000;
  const asDate = Date.parse(headerValue);
  if (Number.isFinite(asDate)) {
    const delta = asDate - now;
    return delta > 0 ? delta : 0;
  }
  return null;
}

/**
 * Pull a human-readable message out of an OpenAI-style mid-stream error
 * payload (`data: {"error":{...}}`). Undefined when the chunk carries no error.
 */
export function extractStreamError(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const err = (json as { error?: unknown }).error;
  if (!err) return undefined;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return JSON.stringify(err);
}

// ── Hosted reasoning models ─────────────────────────────────────────

/**
 * OpenAI's hosted reasoning families (GPT-5, GPT-6, the o-series) reject
 * parameters every other model accepts: `max_tokens` (deprecated, replaced by
 * max_completion_tokens, which also covers reasoning tokens) and sampling
 * controls like `temperature` - gpt-6-astra returns a 400 on both. Matches a
 * bare or provider-prefixed name ("gpt-5.2", "openai/gpt-6-astra", "o4-mini");
 * gpt-oss, the open-weight family, is deliberately not matched.
 */
export function isOpenAIReasoningModel(name: string | undefined): boolean {
  if (!name) return false;
  const bare = name.split('/').pop()!.toLowerCase();
  return /^(?:gpt-[56]|o[1-9])(?:[.\-]|$)/.test(bare);
}

/**
 * Strip what a hosted reasoning model rejects from a chat-completions body, in
 * place. Keeps max_completion_tokens (the budget), drops max_tokens, the
 * sampling set, and the open-weight chat-template toggles, which OpenAI
 * rejects as unrecognised arguments.
 */
export function applyReasoningModelPolicy(body: Record<string, unknown>): string[] {
  const dropped: string[] = [];
  if (body.max_tokens !== undefined && body.max_completion_tokens === undefined) {
    body.max_completion_tokens = body.max_tokens;
  }
  for (const key of [
    'max_tokens', 'temperature', 'top_p', 'top_k', 'repeat_penalty',
    'enable_thinking', 'chat_template_kwargs',
  ]) {
    if (key in body) {
      delete body[key];
      dropped.push(key);
    }
  }
  return dropped;
}

// ── Model kinds from the name alone ─────────────────────────────────

/**
 * A plain OpenAI-compatible /v1/models (OpenAI itself, and most cloud APIs)
 * lists every model with no type, so image, speech, transcription and
 * moderation models sit beside the chat models. Behind a LiteLLM router
 * /model/info says which is which; everywhere else the name is all there is.
 * Deliberately narrow - only families that are never chat models - so an
 * unfamiliar name is kept rather than hidden.
 */
const NON_CHAT_NAME =
  /(?:^|[\/\-_.])(?:dall-e|gpt-image|sora|tts|whisper|transcribe|moderation|realtime|babbage|davinci)(?:[\/\-_.]|\d|$)/i;
const EMBEDDING_NAME = /(?:^|[\/\-_.])embed/i;

export function modelKindFromName(id: string): 'chat' | 'embedding' | 'other' {
  if (EMBEDDING_NAME.test(id)) return 'embedding';
  if (NON_CHAT_NAME.test(id)) return 'other';
  return 'chat';
}

// ── Thinking mode ───────────────────────────────────────────────────

/**
 * Resolve HOUTINI_LM_THINKING into the enable_thinking value sent to the
 * backend, or undefined to send nothing. `on` / `off` are explicit operator
 * overrides; `auto` (and anything unrecognised) suppresses thinking only when
 * detection says the model supports the toggle, and otherwise leaves the
 * backend default alone. Ported from PR #34 (pinboxltd).
 */
export function resolveThinkingOverride(
  rawMode: string | undefined,
  supportsThinkingToggle: boolean,
): boolean | undefined {
  const mode = (rawMode || 'auto').trim().toLowerCase();
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return supportsThinkingToggle ? false : undefined;
}

// ── Prompt composition ──────────────────────────────────────────────

/**
 * Anti-hallucination line added to every system prompt. Scoped to material
 * supplied in the conversation: an earlier "answer only from this conversation"
 * wording made literal models (gpt-6-astra, deepseek-v4) refuse open-ended
 * writing that needs their own knowledge, listing what was "missing".
 */
export const GROUNDING_LINE =
  'When the task depends on code, files or data provided in this conversation, work from that material ' +
  'and do not invent details of it; if something you need from it is missing, say what rather than guessing. ' +
  'For everything else, answer from your own knowledge.';

/**
 * Compose the system prompt sent to the local model. Guarantees a non-empty,
 * directionally-productive instruction on EVERY call. Layers, in order:
 *   base       - persona (+ task, for code tasks); always present
 *   grounding  - universal anti-hallucination line
 *   format     - JSON-only when a json_schema is set (which SUPPRESSES the
 *                markdown guidance that would otherwise contradict it);
 *                otherwise the task-appropriate format line plus any per-family
 *                constraint.
 * Compact by design - every token here is prefill the estimator and latency pay for.
 */
export function buildSystemPrompt(opts: {
  base: string;
  formatLine?: string;
  modelConstraint?: string;
  structuredOutput?: boolean;
}): string {
  const layers: string[] = [opts.base.trim()];
  layers.push(GROUNDING_LINE);
  if (opts.structuredOutput) {
    layers.push('Return only valid JSON conforming to the requested schema - no prose, no markdown, no code fences.');
  } else {
    if (opts.formatLine && opts.formatLine.trim()) layers.push(opts.formatLine.trim());
    if (opts.modelConstraint && opts.modelConstraint.trim()) layers.push(opts.modelConstraint.trim());
  }
  return layers.join('\n\n');
}
