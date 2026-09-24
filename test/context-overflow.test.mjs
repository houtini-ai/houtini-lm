import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContextOverflow, parseOutputCapOverflow } from '../dist/context-overflow.js';

test('parseOutputCapOverflow', () => {
  const openai = 'max_tokens is too large: 25000. This model supports at most 16384 completion tokens, whereas you provided 25000.';
  assert.equal(parseOutputCapOverflow(openai), 16384);
  assert.equal(parseOutputCapOverflow('max_completion_tokens is too large: 200000. This model supports at most 128,000 completion tokens'), 128000);
  assert.equal(parseOutputCapOverflow("This model's maximum context length is 65536 tokens"), null);
  assert.equal(parseOutputCapOverflow(''), null);
  // The output-cap message isn't mistaken for a context overflow.
  assert.equal(parseContextOverflow(openai), null);
});
