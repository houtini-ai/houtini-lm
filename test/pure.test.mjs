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
  redactUrl,
  parseRetryAfter,
  extractStreamError,
  buildSystemPrompt,
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
  const schema = { type: 'object', properties: { answer: { type: 'string' } } };
  const wrapped = toResponseFormat({ name: 'answer', schema, strict: false });
  assert.deepEqual(wrapped, {
    type: 'json_schema',
    json_schema: { name: 'answer', schema, strict: false },
  });
  assert.equal(wrapped.json_schema.schema, schema);

  const bare = toResponseFormat(schema);
  assert.deepEqual(bare, {
    type: 'json_schema',
    json_schema: { name: 'response', strict: true, schema },
  });
  assert.equal(bare.json_schema.schema, schema);
  assert.equal(toResponseFormat(null), undefined);
  assert.equal(toResponseFormat('x'), undefined);
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
  const grounding = 'Base your answer only on the information provided in this conversation. If it is insufficient to answer correctly, say what is missing rather than guessing.';
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
