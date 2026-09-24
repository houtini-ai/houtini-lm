import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimatePromptTokens,
  autoOutputBudget,
  capOutputBudget,
  inflateForThinking,
  isConfidentPrefillEstimate,
  validMaxTokens,
  validTemperature,
  extractSamplingParams,
  toResponseFormat,
  prepareStrictSchema,
  isUnsupportedSchemaFormat,
  schemaInstruction,
  redactUrl,
  parseRetryAfter,
  extractStreamError,
  buildSystemPrompt,
  resolveThinkingOverride,
  isOpenAIReasoningModel,
  applyReasoningModelPolicy,
  modelKindFromName,
  envFlag,
  structuredPart,
  GROUNDING_LINE,
} from '../dist/pure.js';

test('estimatePromptTokens', () => {
  assert.equal(estimatePromptTokens(3000, 2), 1640);
  assert.equal(estimatePromptTokens(0, 0), 512);
  assert.equal(estimatePromptTokens(4, 1), 578);
});

test('autoOutputBudget', () => {
  assert.equal(autoOutputBudget(100000, 8192), 25000);
  assert.equal(autoOutputBudget(undefined, 8192), 8192);
  assert.equal(autoOutputBudget(100003, 8192), 25000);
});

test('capOutputBudget', () => {
  // A 922k-context model with a 128k output cap: 25% of context would 400.
  assert.equal(capOutputBudget(230500, {
    contextLen: 922000, maxOutput: 128000, promptChars: 3000, messageCount: 2,
  }), 128000);
  assert.equal(capOutputBudget(50000, {}), 50000);
  assert.equal(capOutputBudget(50000, {
    contextLen: 10000, promptChars: 3000, messageCount: 2,
  }), 8360);
  // Prompt alone overfills the window: leave it for the backend to report.
  assert.equal(capOutputBudget(50000, {
    contextLen: 1000, promptChars: 3000, messageCount: 2,
  }), 50000);
  assert.equal(capOutputBudget(50000, { maxOutput: 0 }), 50000);
});

test('isConfidentPrefillEstimate only trusts a ratio while it interpolates', () => {
  // The live case: two ~72-token samples of a hosted model, TTFT mostly
  // network overhead, extrapolated to a 13.8k-token input. Must NOT refuse.
  assert.equal(isConfidentPrefillEstimate({ basis: 'ratio', inputTokens: 13823, maxSampledPromptTokens: 72 }), false);
  // Within 4x of what we've measured: trusted.
  assert.equal(isConfidentPrefillEstimate({ basis: 'ratio', inputTokens: 280, maxSampledPromptTokens: 72 }), true);
  assert.equal(isConfidentPrefillEstimate({ basis: 'ratio', inputTokens: 289, maxSampledPromptTokens: 72 }), false);
  assert.equal(isConfidentPrefillEstimate({ basis: 'ratio', inputTokens: 100 }), false);
  // Linear fit: trusted on a fit that fits, however far it extrapolates.
  assert.equal(isConfidentPrefillEstimate({ basis: 'linear-fit', inputTokens: 50000, fit: { r2: 0.9 } }), true);
  assert.equal(isConfidentPrefillEstimate({ basis: 'linear-fit', inputTokens: 500, fit: { r2: 0.3 } }), false);
  // The conservative default never refuses on its own.
  assert.equal(isConfidentPrefillEstimate({ basis: 'default', inputTokens: 1e6 }), false);
});

test('inflateForThinking', () => {
  assert.equal(inflateForThinking(100), 2100);
  assert.equal(inflateForThinking(10000), 40000);
});

test('validMaxTokens', () => {
  const calls = [];
  const onBelowFloor = (value) => calls.push(value);
  assert.equal(validMaxTokens(256, 4096, onBelowFloor), undefined);
  assert.deepEqual(calls, [256]);

  calls.length = 0;
  assert.equal(validMaxTokens(8192, 4096, onBelowFloor), 8192);
  assert.equal(validMaxTokens(4096, 4096, onBelowFloor), 4096);
  assert.equal(validMaxTokens(256, 0, onBelowFloor), 256);
  for (const value of [1.5, 0, -5, 2e6, '8000']) {
    assert.equal(validMaxTokens(value, 4096, onBelowFloor), undefined);
  }
  assert.deepEqual(calls, []);
});

test('validTemperature', () => {
  assert.equal(validTemperature(0), 0);
  assert.equal(validTemperature(2), 2);
  for (const value of [-0.1, 2.1, NaN, '0.5']) {
    assert.equal(validTemperature(value), undefined);
  }
});

test('extractSamplingParams', () => {
  assert.deepEqual(extractSamplingParams({
    seed: 7, stop: 'END', top_p: 0.8, top_k: 40,
    repeat_penalty: 1.1, frequency_penalty: -0.5, presence_penalty: 0.5,
  }), {
    seed: 7, stop: 'END', topP: 0.8, topK: 40,
    repeatPenalty: 1.1, frequencyPenalty: -0.5, presencePenalty: 0.5,
  });
  assert.equal(extractSamplingParams({ top_p: 1.5 }).topP, undefined);
  assert.deepEqual(
    extractSamplingParams({ stop: ['a', 'b', 'c', 'd', 'e', 'f'] }).stop,
    ['a', 'b', 'c', 'd'],
  );
  assert.deepEqual(
    extractSamplingParams({ stop: ['a', 1, null, 'b', 'c', 'd'] }).stop,
    ['a', 'b', 'c', 'd'],
  );
  assert.equal(extractSamplingParams({ stop: [] }).stop, undefined);
  assert.equal(extractSamplingParams({ seed: 1.5 }).seed, undefined);
  assert.equal(extractSamplingParams({ seed: 7 }).seed, 7);
});

test('toResponseFormat', () => {
  // An optional property can't be strict on OpenAI, so it goes non-strict,
  // with additionalProperties: false added and the caller's object untouched.
  const schema = { type: 'object', properties: { answer: { type: 'string' } } };
  const bare = toResponseFormat(schema);
  assert.deepEqual(bare, {
    type: 'json_schema',
    json_schema: {
      name: 'response',
      strict: false,
      schema: { type: 'object', properties: { answer: { type: 'string' } }, additionalProperties: false },
    },
  });
  assert.equal(schema.additionalProperties, undefined);

  // Every property required: strict by default, honouring an explicit false.
  const full = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
  assert.equal(toResponseFormat(full).json_schema.strict, true);
  assert.equal(toResponseFormat({ name: 'a', schema: full, strict: false }).json_schema.strict, false);
  assert.equal(toResponseFormat({ name: 'a', schema: full }).json_schema.name, 'a');
  assert.equal(toResponseFormat(null), undefined);
  assert.equal(toResponseFormat('x'), undefined);
});

test('prepareStrictSchema', () => {
  const nested = {
    type: 'object',
    properties: {
      issues: { type: 'array', items: { type: 'object', properties: { line: { type: 'number' } }, required: ['line'] } },
    },
    required: ['issues'],
  };
  const { schema, strictOk } = prepareStrictSchema(nested);
  assert.equal(strictOk, true);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.issues.items.additionalProperties, false);
  // A property literally named "properties" isn't mistaken for a schema keyword.
  const tricky = prepareStrictSchema({ type: 'object', properties: { properties: { type: 'string' } }, required: ['properties'] });
  assert.equal(tricky.strictOk, true);
  assert.deepEqual(tricky.schema.properties.properties, { type: 'string' });
  // An open object (additionalProperties: true) can't be strict.
  assert.equal(prepareStrictSchema({ type: 'object', properties: {}, additionalProperties: true }).strictOk, false);
});

test('isUnsupportedSchemaFormat + schemaInstruction', () => {
  const body = { response_format: { type: 'json_schema', json_schema: { name: 'r', schema: { type: 'object' } } } };
  assert.equal(isUnsupportedSchemaFormat('This response_format type is unavailable now', body), true);
  assert.equal(isUnsupportedSchemaFormat('maximum context length is 4096', body), false);
  assert.equal(isUnsupportedSchemaFormat('response_format bad', { response_format: { type: 'json_object' } }), false);
  assert.match(schemaInstruction({ type: 'object' }), /JSON/);
});

test('redactUrl', () => {
  const redacted = redactUrl('http://u:p@h:1/x');
  assert.equal(redacted, 'http://h:1/x');
  assert.ok(!redacted.includes('u:p'));

  const url = new URL(redactUrl('https://h/x?api_key=secret&token=private&other=ok'));
  assert.equal(url.searchParams.get('api_key'), '***');
  assert.equal(url.searchParams.get('token'), '***');
  assert.equal(url.searchParams.get('other'), 'ok');
  assert.equal(redactUrl('http://localhost:1234'), 'http://localhost:1234');
  assert.equal(redactUrl('not a url'), 'not a url');
});

test('parseRetryAfter', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(parseRetryAfter('5', now), 5000);
  assert.equal(parseRetryAfter(new Date(now + 10000).toUTCString(), now), 10000);
  assert.equal(parseRetryAfter(new Date(now - 10000).toUTCString(), now), 0);
  assert.equal(parseRetryAfter('garbage', now), null);
  assert.equal(parseRetryAfter(null, now), null);
});

test('extractStreamError', () => {
  assert.equal(extractStreamError({ error: 'boom' }), 'boom');
  assert.equal(extractStreamError({ error: { message: 'm' } }), 'm');
  assert.equal(extractStreamError({ error: { code: 1 } }), '{"code":1}');
  assert.equal(extractStreamError({}), undefined);
  assert.equal(extractStreamError(null), undefined);
});

test('buildSystemPrompt', () => {
  const grounding = GROUNDING_LINE;
  // Scoped to supplied material: an unscoped "only from this conversation" line
  // made literal models refuse open-ended writing.
  assert.ok(/own knowledge/.test(grounding));
  assert.ok(!/only on the information/.test(grounding));
  const plain = buildSystemPrompt({
    base: '  Base prompt \n', formatLine: '  Format marker  ',
    modelConstraint: '  Constraint marker  ',
  });
  assert.equal(plain, [
    'Base prompt', grounding, 'Format marker', 'Constraint marker',
  ].join('\n\n'));

  const structured = buildSystemPrompt({
    base: '  Base prompt  ', structuredOutput: true,
    formatLine: 'Format marker', modelConstraint: 'Constraint marker',
  });
  assert.ok(structured.startsWith('Base prompt\n\n'));
  assert.ok(structured.includes(grounding));
  assert.match(structured, /Return only valid JSON/);
  assert.ok(!structured.includes('Format marker'));
  assert.ok(!structured.includes('Constraint marker'));

  const whitespace = buildSystemPrompt({ base: '  Base prompt  ', formatLine: ' \n\t ' });
  assert.equal(whitespace, `Base prompt\n\n${grounding}`);
  assert.ok(buildSystemPrompt({ base: '' }).includes(grounding));
});

test('resolveThinkingOverride', () => {
  // Explicit modes win over detection (PR #34: 'on' used to be ignored).
  assert.equal(resolveThinkingOverride('on', true), true);
  assert.equal(resolveThinkingOverride('on', false), true);
  assert.equal(resolveThinkingOverride('ON ', true), true);
  assert.equal(resolveThinkingOverride('off', true), false);
  assert.equal(resolveThinkingOverride('off', false), false);
  // auto / unset / unknown: suppress only detected thinking models.
  assert.equal(resolveThinkingOverride('auto', true), false);
  assert.equal(resolveThinkingOverride(undefined, true), false);
  assert.equal(resolveThinkingOverride('auto', false), undefined);
  assert.equal(resolveThinkingOverride('', false), undefined);
  assert.equal(resolveThinkingOverride('maybe', false), undefined);
});

test('isOpenAIReasoningModel', () => {
  for (const name of ['gpt-5', 'gpt-5.2', 'openai/gpt-6-astra', 'gpt-6-luna', 'o3', 'o4-mini', 'openai/o1']) {
    assert.equal(isOpenAIReasoningModel(name), true, name);
  }
  for (const name of ['gpt-oss-120b', 'openai/gpt-oss-20b', 'gpt-4o-mini', 'gpt-4.1', 'qwen3-coder', 'local', '', undefined]) {
    assert.equal(isOpenAIReasoningModel(name), false, String(name));
  }
});

test('applyReasoningModelPolicy', () => {
  const body = {
    messages: [], stream: true, temperature: 0.3, max_tokens: 8000, max_completion_tokens: 8000,
    top_p: 0.9, top_k: 40, repeat_penalty: 1.1, seed: 7,
    enable_thinking: false, chat_template_kwargs: { enable_thinking: false },
  };
  const dropped = applyReasoningModelPolicy(body);
  assert.deepEqual(dropped.sort(), ['chat_template_kwargs', 'enable_thinking', 'max_tokens', 'repeat_penalty', 'temperature', 'top_k', 'top_p']);
  assert.equal(body.max_completion_tokens, 8000);
  assert.equal(body.seed, 7);
  assert.equal(body.stream, true);
  // A body carrying only max_tokens keeps its budget as max_completion_tokens.
  const legacy = { max_tokens: 4096 };
  applyReasoningModelPolicy(legacy);
  assert.deepEqual(legacy, { max_completion_tokens: 4096 });
});

test('modelKindFromName', () => {
  const other = ['dall-e-3', 'gpt-image-1', 'sora-2', 'tts-1-hd', 'gpt-4o-mini-tts', 'whisper-1',
    'gpt-4o-transcribe', 'omni-moderation-latest', 'gpt-4o-realtime-preview', 'babbage-002', 'davinci-002'];
  for (const id of other) assert.equal(modelKindFromName(id), 'other', id);
  const embedding = ['text-embedding-3-small', 'nomic-embed-text', 'openai/text-embedding-ada-002', 'embeddinggemma-300m'];
  for (const id of embedding) assert.equal(modelKindFromName(id), 'embedding', id);
  const chat = ['gpt-5.2', 'gpt-6-astra', 'o4-mini', 'gpt-4o-mini', 'gpt-4o-audio-preview', 'gpt-4o-search-preview',
    'deepseek-chat', 'qwen3-coder-30b', 'llama-3.3-70b', 'gpt-oss-120b'];
  for (const id of chat) assert.equal(modelKindFromName(id), 'chat', id);
});

test('envFlag + structuredPart', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' on ']) assert.equal(envFlag(v), true, v);
  for (const v of [undefined, '', '0', 'false', 'off', 'no', 'maybe']) assert.equal(envFlag(v), false, String(v));
  // Off by default: no structuredContent key at all, so clients show the text block.
  assert.deepEqual(structuredPart(false, { answer: 'x' }), {});
  assert.deepEqual(structuredPart(true, { answer: 'x' }), { structuredContent: { answer: 'x' } });
});
