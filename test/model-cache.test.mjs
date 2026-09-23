import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPrefillLinear, getThinkingSupport, getPromptHints } from '../dist/model-cache.js';

const sample = (promptTokens, ttftMs, i) => ({ promptTokens, ttftMs, recordedAt: i });

test('fitPrefillLinear recovers a clean linear relationship', () => {
  // ttft = 200ms + 0.5ms/token, exactly.
  const samples = [100, 500, 1000, 2000, 4000, 8000].map((t, i) => sample(t, 200 + 0.5 * t, i));
  const fit = fitPrefillLinear(samples);
  assert.ok(fit);
  assert.ok(Math.abs(fit.alphaMs - 200) < 1e-6);
  assert.ok(Math.abs(fit.betaMsPerToken - 0.5) < 1e-9);
  assert.ok(fit.r2 > 0.999);
  assert.equal(fit.n, 6);
});

test('fitPrefillLinear refuses too few samples or zero input variance', () => {
  assert.equal(fitPrefillLinear([sample(100, 250, 0), sample(200, 300, 1)]), null);
  const flat = [0, 1, 2, 3, 4].map((i) => sample(500, 400 + i, i));
  assert.equal(fitPrefillLinear(flat), null);
});

test('fitPrefillLinear weights recent samples over a stale regime', () => {
  // Old regime: slow (2ms/token). Newest six: fast (0.2ms/token). The fit
  // should land near the new regime, not the average of both.
  const old = [100, 400, 800, 1600].map((t, i) => sample(t, 2 * t, i));
  const fresh = [100, 400, 800, 1600, 3200, 6400].map((t, i) => sample(t, 0.2 * t, 10 + i));
  const fit = fitPrefillLinear([...old, ...fresh]);
  assert.ok(fit);
  assert.ok(fit.betaMsPerToken < 0.6, `slope ${fit.betaMsPerToken} should track the recent regime`);
});

test('thinking detection works through a router alias\'s upstream name', async () => {
  // Behind a LiteLLM router the alias ("local") means nothing to the detector;
  // the upstream it resolves to is what identifies a Qwen3 thinking model.
  const qwen = await getThinkingSupport('qwen3.6-27b');
  assert.equal(qwen?.supportsThinkingToggle, true);
  const gemma = await getThinkingSupport('gemma4-31b');
  assert.equal(gemma?.supportsThinkingToggle, true);
  // Coder and hosted GPT models are not flagged for the no-think toggle.
  const coder = await getThinkingSupport('qwen3-coder-next-80b');
  assert.ok(!coder?.supportsThinkingToggle);
  const gpt = await getThinkingSupport('gpt-6-astra');
  assert.ok(!gpt?.supportsThinkingToggle);
});

test('prompt hints resolve through the upstream when the id is an alias', () => {
  // routeToModel passes the upstream as the arch hint for router aliases.
  const viaAlias = getPromptHints('local', 'qwen3-coder-next');
  assert.deepEqual(viaAlias.bestTaskTypes, ['code']);
  const unknown = getPromptHints('local');
  assert.deepEqual(unknown.bestTaskTypes, ['chat', 'code', 'analysis']);
});
