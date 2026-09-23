import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseModelInfo,
  classifyMode,
  stripProvider,
  isWildcardAlias,
} from '../dist/litellm.js';

test('parseModelInfo validates entries, normalizes upstreams, and parses limits', () => {
  for (const input of [null, 'x', {}, { data: 'x' }, { data: [{ model_name: 'a' }] }]) {
    assert.equal(parseModelInfo(input), null);
  }

  assert.deepEqual(parseModelInfo({
    data: [
      null,
      'x',
      {},
      { litellm_params: {} },
      { model_name: '', litellm_params: {} },
      { model_name: 123, litellm_params: {} },
      {
        model_name: 'a',
        litellm_params: { model: 'hosted_vllm/qwen3.6-27b' },
        model_info: {
          mode: 'chat',
          max_input_tokens: 100.9,
          max_output_tokens: 20.9,
          max_tokens: 99,
        },
      },
      {
        model_name: 'b',
        litellm_params: { model: 'hosted_vllm/Qwen/Qwen3.6-27B' },
        model_info: { mode: 'embedding', max_tokens: 30.9 },
      },
    ],
  }), [
    {
      alias: 'a',
      upstream: 'hosted_vllm/qwen3.6-27b',
      upstreamBare: 'qwen3.6-27b',
      mode: 'chat',
      maxInputTokens: 100,
      maxOutputTokens: 20,
    },
    {
      alias: 'b',
      upstream: 'hosted_vllm/Qwen/Qwen3.6-27B',
      upstreamBare: 'Qwen/Qwen3.6-27B',
      mode: 'embedding',
      maxInputTokens: null,
      maxOutputTokens: 30,
    },
  ]);

  const parseInfo = (model_info) => parseModelInfo({
    data: [{ model_name: 'a', litellm_params: {}, model_info }],
  })[0];

  assert.deepEqual(parseInfo(undefined), {
    alias: 'a',
    upstream: null,
    upstreamBare: null,
    mode: null,
    maxInputTokens: null,
    maxOutputTokens: null,
  });
  assert.deepEqual(parseModelInfo({ data: [{ litellm_params: {} }] }), []);

  for (const value of [0, -1, '5', NaN]) {
    const parsed = parseInfo({
      max_input_tokens: value,
      max_output_tokens: value,
      max_tokens: value,
    });
    assert.equal(parsed.maxInputTokens, null);
    assert.equal(parsed.maxOutputTokens, null);
    assert.equal(parseInfo({ max_tokens: value }).maxOutputTokens, null);
    assert.equal(parseInfo({
      max_output_tokens: value,
      max_tokens: 12.8,
    }).maxOutputTokens, 12);
  }

  for (const mode of [undefined, null, 5, false, {}, []]) {
    assert.equal(parseInfo({ mode }).mode, null);
  }
});

test('classifyMode distinguishes chat, embedding, and other modes', () => {
  for (const mode of [undefined, null, '', 'chat', 'responses', 'completion']) {
    assert.equal(classifyMode(mode), 'chat');
  }
  assert.equal(classifyMode('embedding'), 'embedding');
  for (const mode of ['audio_speech', 'image_generation', 'brand_new_mode']) {
    assert.equal(classifyMode(mode), 'other');
  }
});

test('stripProvider removes only the first path segment', () => {
  assert.equal(stripProvider('qwen3.6-27b'), 'qwen3.6-27b');
  assert.equal(stripProvider('hosted_vllm/qwen3.6-27b'), 'qwen3.6-27b');
  assert.equal(stripProvider('hosted_vllm/Qwen/Qwen3.6-27B'), 'Qwen/Qwen3.6-27B');
  assert.equal(stripProvider(''), '');
});

test('isWildcardAlias detects asterisks', () => {
  assert.equal(isWildcardAlias('openai/*'), true);
  assert.equal(isWildcardAlias('astra'), false);
  assert.equal(isWildcardAlias('*'), true);
  assert.equal(isWildcardAlias(''), false);
});
