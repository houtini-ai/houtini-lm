// End-to-end shape of an inference tool result: spawn the built server over
// stdio against a mock OpenAI-compatible endpoint and check what a client
// actually receives. Regression for 3.3.0-3.3.2, where every result carried
// structuredContent and Claude Code showed the model only that - no answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const ANSWER = 'HELLO-TEXT-BLOCK';

function startMock() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model', object: 'model' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: ANSWER } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

async function callChat(port, extraEnv) {
  const home = mkdtempSync(join(tmpdir(), 'houtini-lm-test-'));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, HOUTINI_LM_ENDPOINT_URL: `http://127.0.0.1:${port}`, HOME: home, USERPROFILE: home, HOUTINI_LM_STRUCTURED: '', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      } catch { /* not JSON */ }
    }
  });
  let id = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const n = id++;
    pending.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const res = await rpc('tools/call', { name: 'chat', arguments: { message: 'hi' } });
    return res.result;
  } finally {
    child.kill();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

test('inference results carry the answer where clients will show it', async (t) => {
  const mock = await startMock();
  const { port } = mock.address();
  t.after(() => mock.close());

  const plain = await callChat(port, {});
  assert.equal(plain.content[0].type, 'text');
  assert.ok(plain.content[0].text.startsWith(ANSWER), 'answer is at the start of the text block');
  assert.equal(plain.structuredContent, undefined, 'no structuredContent by default');

  const structured = await callChat(port, { HOUTINI_LM_STRUCTURED: '1' });
  assert.ok(structured.content[0].text.startsWith(ANSWER), 'text block still carries the answer');
  assert.equal(structured.structuredContent.answer, ANSWER, 'structuredContent carries the answer too');
  assert.equal(structured.structuredContent.tokens.completion, 2);
});
