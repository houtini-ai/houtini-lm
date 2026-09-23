/**
 * litellm.ts - make sense of a LiteLLM router's /model/info.
 *
 * A LiteLLM router's /v1/models returns bare aliases (`local`, `astra`,
 * `deepseek-v4-pro`) and nothing else - no context window, no capability, no
 * hint of what model sits behind the name. Profiling, thinking detection and
 * budget sizing all go blind. The router already knows the answers, though:
 * GET /model/info returns, per alias, the upstream model string
 * (`hosted_vllm/qwen3.6-27b`), the mode (`chat`, `embedding`, `audio_speech`,
 * `image_generation`, ...) and - for models LiteLLM has pricing data on - the
 * real input and output token limits.
 *
 * Everything here is pure so it can be unit-tested without a router.
 */

export interface RouterModelInfo {
  /** model_name - the alias inference must be sent to. */
  alias: string;
  /** litellm_params.model, e.g. `hosted_vllm/qwen3.6-27b`. */
  upstream: string | null;
  /** upstream with the provider segment removed, e.g. `qwen3.6-27b`. */
  upstreamBare: string | null;
  /** LiteLLM mode. null = LiteLLM doesn't know (typically a self-hosted model). */
  mode: string | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
}

/**
 * Modes that can't answer /v1/chat/completions. Routing a chat task to any of
 * these is a guaranteed error, and listing them in discover is noise - a real
 * router lists dozens of TTS, image, video and moderation variants.
 */
const NON_CHAT_MODES = new Set([
  'audio_speech',
  'audio_transcription',
  'image_generation',
  'image_edit',
  'video_generation',
  'moderation',
  'realtime',
  'rerank',
  'ocr',
  'search',
]);

export type ModeClass = 'chat' | 'embedding' | 'other';

/**
 * Collapse LiteLLM's mode into what houtini-lm cares about. `responses` models
 * answer through LiteLLM's chat bridge; an unknown (null) mode is almost always
 * a self-hosted chat model LiteLLM has no pricing entry for, so it counts as chat.
 */
export function classifyMode(mode: string | null | undefined): ModeClass {
  if (mode === undefined || mode === null || mode === '') return 'chat';
  if (mode === 'chat' || mode === 'responses' || mode === 'completion') return 'chat';
  if (mode === 'embedding') return 'embedding';
  if (NON_CHAT_MODES.has(mode)) return 'other';
  // An unrecognised new mode: safer to keep it out of chat routing.
  return 'other';
}

/**
 * Drop the LiteLLM provider segment. LiteLLM model strings are always
 * `provider/model`, and the model part can itself contain a slash when it's a
 * HuggingFace repo id - `hosted_vllm/Qwen/Qwen3.6-27B` becomes `Qwen/Qwen3.6-27B`,
 * which the HuggingFace lookup can resolve directly.
 */
export function stripProvider(model: string): string {
  const i = model.indexOf('/');
  return i >= 0 ? model.slice(i + 1) : model;
}

/** A wildcard route (`openai/*`) isn't a callable model. */
export function isWildcardAlias(alias: string): boolean {
  return alias.includes('*');
}

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/**
 * Parse a /model/info response body. Returns null when the body isn't a
 * LiteLLM shape (no `data` array, or no entry carries `litellm_params`), so the
 * caller can treat "not a router" and "router with no models" differently.
 */
export function parseModelInfo(json: unknown): RouterModelInfo[] | null {
  if (!json || typeof json !== 'object') return null;
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  if (!data.some((d) => d && typeof d === 'object' && 'litellm_params' in d)) return null;

  const out: RouterModelInfo[] = [];
  for (const d of data) {
    if (!d || typeof d !== 'object') continue;
    const entry = d as {
      model_name?: unknown;
      litellm_params?: { model?: unknown };
      model_info?: { mode?: unknown; max_input_tokens?: unknown; max_output_tokens?: unknown; max_tokens?: unknown };
    };
    if (typeof entry.model_name !== 'string' || !entry.model_name) continue;
    const upstream = typeof entry.litellm_params?.model === 'string' ? entry.litellm_params.model : null;
    const info = entry.model_info ?? {};
    out.push({
      alias: entry.model_name,
      upstream,
      upstreamBare: upstream ? stripProvider(upstream) : null,
      mode: typeof info.mode === 'string' ? info.mode : null,
      maxInputTokens: positiveInt(info.max_input_tokens),
      // max_output_tokens is the precise field; older LiteLLM builds only fill max_tokens.
      maxOutputTokens: positiveInt(info.max_output_tokens) ?? positiveInt(info.max_tokens),
    });
  }
  return out;
}
