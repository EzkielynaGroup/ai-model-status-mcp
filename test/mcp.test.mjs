// End-to-end tests: a local mock data server (recorded, trimmed fixtures) and the MCP server spawned over stdio.
// No internet, no cost.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'ai-model-status-mcp.mjs');
const FIX = name => fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8');
const ROUTES = { '/status/models.json': FIX('models.json'), '/status/leaderboard.json': FIX('leaderboard.json'), '/api/pricing': FIX('pricing.json') };

let srv;
let base;
let mode = 'ok'; // ok | fail500 | notjson | slow
const hits = {};

before(async () => {
  srv = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    const body = ROUTES[req.url];
    if (!body) { res.writeHead(404); return res.end('{}'); }
    if (mode === 'fail500') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":"boom"}'); }
    if (mode === 'notjson') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>maintenance</html>'); }
    if (mode === 'slow') { setTimeout(() => { res.writeHead(200); res.end(body); }, 2500); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

const children = new Set();
after(() => {
  for (const c of children) c.kill();
  srv.closeAllConnections?.();
  srv.close();
});

function startMcp(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, AI_MODEL_STATUS_SOURCE: base, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  let buf = '';
  let stderr = '';
  let nextId = 1;
  const waiting = new Map();
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line); // every stdout line must be JSON-RPC
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  child.stderr.on('data', d => { stderr += d; });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
    waiting.set(id, m => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const raw = line => child.stdin.write(line + '\n');
  const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
  const stop = () => new Promise(r => { child.on('exit', r); child.stdin.end(); });
  return { request, raw, call, stop, stderr: () => stderr };
}

const textOf = r => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
const BLOCKED = /uncensored|abliterated|nsfw/i;

test('handshake, ping, tools/list and protocol errors', async () => {
  const mcp = startMcp();
  const init = await mcp.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'ai-model-status');
  assert.ok(init.result.capabilities.tools);
  assert.equal((await mcp.request('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
  assert.deepEqual((await mcp.request('ping')).result, {});
  const list = (await mcp.request('tools/list', {})).result.tools;
  assert.deepEqual(list.map(t => t.name).sort(), ['compare_models', 'lowest_price_models', 'model_status', 'usage_leaderboard']);
  for (const t of list) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.annotations.openWorldHint, true);
    assert.doesNotMatch(t.description, /cheapest|best|unlimited|official/i);
  }
  assert.equal((await mcp.request('no/such')).error.code, -32601);
  assert.equal((await mcp.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  assert.deepEqual((await mcp.request('resources/list')).result, { resources: [] });
  await mcp.stop();
});

test('bad JSON gets a parse error and the server keeps running', async () => {
  const mcp = startMcp();
  mcp.raw('{not json');
  assert.deepEqual((await mcp.request('ping')).result, {});
  await mcp.stop();
});

test('model_status for one model: status, price, model page', async () => {
  const mcp = startMcp();
  const r = await mcp.call('model_status', { model: 'deepseek-v4.1-flash' });
  const t = textOf(r);
  assert.ok(!r.isError, t);
  assert.match(t, /deepseek-v4\.1-flash \(DeepSeek\): success 24h 100% \(7,134 req\), uptime 7d 99\.98% \(40,005 req\), 30d 99\.74%/);
  assert.match(t, /first token p50 3\.9 s \/ p90 11\.2 s, speed 120 tok\/s/);
  // ratio 0.02 x $2 = $0.04 per 1M in, x4 completion = $0.16 out, Standard 1x; Rp15.000/USD.
  assert.match(t, /in \$0\.04 \/ out \$0\.16 per 1M tokens \(~Rp600 \/ Rp2\.400\), cached input \$0\.0054; key group Standard/);
  assert.match(t, /ezkielyna\.store\/models\/deepseek-v4\.1-flash\?utm_source=github/);
  assert.match(t, /one independent AI API gateway \(not the whole market\)/);
  await mcp.stop();
});

test('model_status matches ids loosely, suggests, and hides blocked ids', async () => {
  const mcp = startMcp();
  const loose = await mcp.call('model_status', { model: 'Claude-Haiku-5.5' });
  assert.ok(!loose.isError, textOf(loose));
  assert.match(textOf(loose), /claude-haiku-5-5 \(Anthropic\)/);
  // Premium 1.5x: ratio 0.0235 x 2 x 1.5 = 0.0705
  assert.match(textOf(loose), /in \$0\.0705 \/ out \$0\.3525 per 1M tokens.*key group Premium/);
  const miss = await mcp.call('model_status', { model: 'deepseek-flash' });
  assert.ok(miss.isError);
  assert.match(textOf(miss), /Did you mean: .*deepseek-v4/);
  assert.doesNotMatch(textOf(miss), BLOCKED);
  const blocked = await mcp.call('model_status', { model: 'deepseek-v4.1-flash-uncensored' });
  assert.ok(blocked.isError);
  assert.doesNotMatch(textOf(blocked), /Did you mean/);
  const low = await mcp.call('model_status', { model: 'gpt-image-2.5' });
  assert.match(textOf(low), /latency hidden \(fewer than 20 answers in 24 h\)/);
  assert.match(textOf(low), /\$0\.00207 per image \(~Rp31\); key group Media/);
  await mcp.stop();
});

test('model_status top N by uptime, latency, speed, requests and kind', async () => {
  const mcp = startMcp();
  const up = textOf(await mcp.call('model_status', { sort_by: 'uptime', top: 25 }));
  assert.match(up, /^Highest 7-day uptime \(models with at least 50 answers in 7 days\):/);
  assert.doesNotMatch(up, BLOCKED);
  assert.doesNotMatch(up, /LongCat-2\.0/); // 36 answers in 7 days < 50
  const lines = up.split('\n').filter(l => l.startsWith('- '));
  const ups = lines.map(l => Number(l.match(/uptime 7d ([\d.]+)%/)[1]));
  assert.deepEqual(ups, [...ups].sort((a, b) => b - a));
  const withLow = textOf(await mcp.call('model_status', { sort_by: 'uptime', top: 25, min_requests_7d: 0 }));
  assert.match(withLow, /LongCat-2\.0/);
  const lat = textOf(await mcp.call('model_status', { sort_by: 'latency', top: 3 }));
  const firsts = lat.split('\n').filter(l => l.startsWith('- ')).map(l => Number(l.match(/p50 ([\d.]+) s/)[1]));
  assert.equal(firsts.length, 3);
  assert.deepEqual(firsts, [...firsts].sort((a, b) => a - b));
  const speed = textOf(await mcp.call('model_status', { sort_by: 'speed', top: 2 }));
  assert.match(speed, /Fastest median output speed/);
  const req = textOf(await mcp.call('model_status', { sort_by: 'requests', top: 1 }));
  assert.match(req, /^Most requests in the last 24 h:\n- deepseek-v4\.1-flash-1017 \(DeepSeek\)/);
  const kind = textOf(await mcp.call('model_status', { sort_by: 'requests', kind: 'claude', top: 10 }));
  assert.ok(kind.split('\n').filter(l => l.startsWith('- ')).every(l => /claude-/.test(l)), kind);
  const none = await mcp.call('model_status', { kind: 'nosuchkind' });
  assert.ok(!none.isError);
  assert.match(textOf(none), /No models match/);
  await mcp.stop();
});

test('compare_models: prices, latency, uptime, aliases and unknown ids', async () => {
  const mcp = startMcp();
  const r = await mcp.call('compare_models', { models: ['deepseek-v4.1-flash', 'gpt-6-luna', 'gpt-image-2.5', 'auto', 'edge-tts', 'nope-model-zz'] });
  const t = textOf(r);
  assert.ok(!r.isError, t);
  assert.match(t, /## gpt-6-luna \(OpenAI\)\n- price: in \$0\.04562 \/ out \$0\.2281 per 1M tokens .*key group Premium \(1\.5x\)/);
  assert.match(t, /## gpt-image-2\.5 \(OpenAI\)\n- price: \$0\.00207 per image/);
  assert.match(t, /## auto \(Ezkielyna\) \[gateway routing alias\]/);
  assert.match(t, /## edge-tts .*\n- price: \$1 per 1M input characters \(~Rp15\.000\)/);
  assert.match(t, /- first token: p50 3\.9 s \/ p90 11\.2 s; speed 120 tok\/s/);
  assert.match(t, /- reliability: success 24h 100%, uptime 7d 99\.98%, 30d 99\.74%/);
  assert.match(t, /"nope-model-zz" is not in the Ezkielyna model list/);
  assert.match(t, /Rupiah is approximate: Rp15\.000 per USD/);
  await mcp.stop();
});

test('compare_models rejects bad input and blocked ids', async () => {
  const mcp = startMcp();
  assert.ok((await mcp.call('compare_models', { models: ['only-one'] })).isError);
  assert.ok((await mcp.call('compare_models', { models: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).isError);
  assert.ok((await mcp.call('compare_models', {})).isError);
  const long = await mcp.call('compare_models', { models: ['x'.repeat(101), 'deepseek-v4-pro'] });
  assert.ok(long.isError);
  assert.match(textOf(long), /too long/);
  const blocked = await mcp.call('compare_models', { models: ['venice-uncensored', 'abliteration-abliterated-model-large-flash'] });
  assert.ok(blocked.isError);
  const mixed = textOf(await mcp.call('compare_models', { models: ['venice-uncensored', 'deepseek-v4-pro'] }));
  assert.match(mixed, /## deepseek-v4-pro/);
  assert.doesNotMatch(mixed, /## venice/);
  await mcp.stop();
});

test('IDR rate can be changed with AI_MODEL_STATUS_IDR_PER_USD', async () => {
  const mcp = startMcp({ AI_MODEL_STATUS_IDR_PER_USD: '16000' });
  const t = textOf(await mcp.call('compare_models', { models: ['deepseek-v4.1-flash', 'deepseek-v4-pro'] }));
  assert.match(t, /~Rp640 \/ Rp2\.560/);
  assert.match(t, /Rp16\.000 per USD/);
  await mcp.stop();
});

test('usage_leaderboard: ranks, change vs last week, attribution, filter', async () => {
  const mcp = startMcp();
  const r = await mcp.call('usage_leaderboard', { top: 20 });
  const t = textOf(r);
  assert.ok(!r.isError, t);
  assert.match(t, /^Most-used models on Ezkielyna, 2026-11-04 to 2026-11-11 \(7 days\), by requests:/);
  assert.match(t, /#1\. deepseek-v4\.1-flash-1017 \(DeepSeek\): 47,627 req, 46\.3% share, 45 users, 6\.03B tokens; -49\.6% requests, same rank/);
  assert.match(t, /#3\. deepseek-v4-pro \(DeepSeek\): .*\+33\.6% requests, up from #7/);
  assert.match(t, /down from #5/);
  assert.doesNotMatch(t, BLOCKED); // the fixture has one synthetic blocked row
  assert.match(t, /content policy are not listed/);
  assert.match(t, /Data: Ezkielyna, CC BY 4\.0 — https:\/\/ezkielyna\.store\/peringkat/);
  assert.match(t, /OpenCode 100%/);
  assert.match(t, /not the whole market/);
  const top3 = textOf(await mcp.call('usage_leaderboard', { top: 3 }));
  assert.equal(top3.split('\n').filter(l => /^#\d+\. /.test(l)).length, 3);
  assert.ok((await mcp.call('usage_leaderboard', { top: 0 })).isError);
  assert.ok((await mcp.call('usage_leaderboard', { top: 'ten' })).isError);
  await mcp.stop();
});

test('lowest_price_models chat/coding: lowest listed price, uptime filter, no aliases, honest wording', async () => {
  const mcp = startMcp();
  const chat = textOf(await mcp.call('lowest_price_models', { task: 'chat', top: 20 }));
  assert.match(chat, /^Lowest listed prices on Ezkielyna for chat:/);
  assert.match(chat, /1\. glm-4\.5-flash \(Zhipu AI\): in \$0\.0122 \/ out \$0\.0122/);
  assert.doesNotMatch(chat, /cheapest|termurah/i);
  assert.doesNotMatch(chat, BLOCKED);
  assert.doesNotMatch(chat, /\bauto\b \(/); // routing alias is not a model
  assert.doesNotMatch(chat, /muse-chat/); // 7-day uptime 86.52% < 90
  assert.doesNotMatch(chat, /gpt-image|edge-tts|stt-|embedding|veo/);
  assert.match(chat, /2 model\(s\) left out because their 7-day uptime is below 90%/); // muse-chat, LongCat-2.0
  assert.match(chat, /other providers may charge less or more/);
  const all = textOf(await mcp.call('lowest_price_models', { task: 'chat', top: 20, min_uptime_7d: 0 }));
  assert.match(all, /muse-chat/);
  const coding = textOf(await mcp.call('lowest_price_models', { task: 'coding', top: 20 }));
  assert.match(coding, /coding \(agent-compatible chat models\)/);
  assert.match(coding, /deepseek-v4\.1-flash/);
  assert.doesNotMatch(coding, /claude-haiku-5-5/); // served in OpenAI format only here
  assert.match(chat, /claude-haiku-5-5/);
  await mcp.stop();
});

test('lowest_price_models image and tts', async () => {
  const mcp = startMcp();
  const img = textOf(await mcp.call('lowest_price_models', { task: 'image', top: 3 }));
  // gpt-image-2.5 has the lowest price but only 22.22% uptime over 7 days, so the default filter leaves it out.
  assert.match(img, /image generation:\n1\. gpt-image-2 \(OpenAI\): \$0\.00825 per image \(~Rp124\); key group Media; no status data/);
  assert.doesNotMatch(img, /gpt-image-2\.5/);
  const imgAll = textOf(await mcp.call('lowest_price_models', { task: 'image', top: 3, min_uptime_7d: 0 }));
  assert.match(imgAll, /image generation:\n1\. gpt-image-2\.5 \(OpenAI\): \$0\.00207 per image/);
  assert.doesNotMatch(img, /veo-3\.1/); // video is not image
  const tts = textOf(await mcp.call('lowest_price_models', { task: 'tts', min_uptime_7d: 0 }));
  assert.match(tts, /1\. edge-tts \(Microsoft\): \$1 per 1M input characters/);
  assert.doesNotMatch(tts, /stt-xai/);
  assert.ok((await mcp.call('lowest_price_models', {})).isError);
  assert.ok((await mcp.call('lowest_price_models', { task: 'video' })).isError);
  assert.ok((await mcp.call('lowest_price_models', { task: 'chat', min_uptime_7d: 101 })).isError);
  await mcp.stop();
});

test('responses are cached for 60 s by default and refetched when the cache is off', async () => {
  mode = 'ok';
  const mcp = startMcp();
  const before1 = hits['/status/models.json'] || 0;
  await mcp.call('model_status', { model: 'deepseek-v4-pro' });
  await mcp.call('model_status', { sort_by: 'latency' });
  await mcp.call('compare_models', { models: ['deepseek-v4-pro', 'gpt-6-luna'] });
  assert.equal(hits['/status/models.json'] - before1, 1);
  await mcp.stop();
  const nocache = startMcp({ AI_MODEL_STATUS_CACHE_MS: '0' });
  const before2 = hits['/status/models.json'];
  await nocache.call('model_status', { model: 'deepseek-v4-pro' });
  await nocache.call('model_status', { model: 'deepseek-v4-pro' });
  assert.equal(hits['/status/models.json'] - before2, 2);
  await nocache.stop();
});

test('a failed refresh falls back to the last good copy', async () => {
  mode = 'ok';
  const mcp = startMcp({ AI_MODEL_STATUS_CACHE_MS: '0' });
  assert.ok(!(await mcp.call('usage_leaderboard', {})).isError);
  mode = 'fail500';
  const r = await mcp.call('usage_leaderboard', {});
  mode = 'ok';
  assert.ok(!r.isError, textOf(r));
  assert.match(mcp.stderr(), /serving cached copy/);
  await mcp.stop();
});

test('source errors become short actionable messages', async () => {
  for (const [m, re] of [['fail500', /HTTP 500/], ['notjson', /not JSON/]]) {
    mode = m;
    const mcp = startMcp();
    const r = await mcp.call('usage_leaderboard', {});
    assert.ok(r.isError);
    assert.match(textOf(r), re);
    assert.doesNotMatch(textOf(r), /at .*\.mjs:\d+/); // no stack trace
    await mcp.stop();
  }
  mode = 'slow';
  const slow = startMcp({ AI_MODEL_STATUS_TIMEOUT_MS: '1000' });
  const r = await slow.call('usage_leaderboard', {});
  assert.ok(r.isError);
  assert.match(textOf(r), /timed out/);
  await slow.stop();
  mode = 'ok';
  const down = startMcp({ AI_MODEL_STATUS_SOURCE: 'http://127.0.0.1:9' });
  const d = await down.call('model_status', { model: 'x' });
  assert.ok(d.isError);
  assert.match(textOf(d), /Could not reach the data source/);
  await down.stop();
  const plain = startMcp({ AI_MODEL_STATUS_SOURCE: 'http://example.com' });
  const p = await plain.call('usage_leaderboard', {});
  assert.ok(p.isError);
  assert.match(textOf(p), /must use https/);
  await plain.stop();
});

test('stdout carries only JSON-RPC (logs go to stderr)', async () => {
  const mcp = startMcp();
  await mcp.call('model_status', { sort_by: 'requests', top: 2 });
  assert.match(mcp.stderr(), /\[ai-model-status\] v1\.1\.0 ready/);
  await mcp.stop();
});

// ---------- CLI mode (1.1.0) ----------
import { execFile } from 'node:child_process';
const runCli = (args, extraEnv = {}) => new Promise(resolve => {
  execFile(process.execPath, [SERVER, ...args], { env: { PATH: process.env.PATH, AI_MODEL_STATUS_SOURCE: base, ...extraEnv }, timeout: 15000 },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
});

test('CLI: --help and --version need no network', async () => {
  const h = await runCli(['--help'], { AI_MODEL_STATUS_SOURCE: 'http://127.0.0.1:9' });
  assert.equal(h.code, 0);
  assert.match(h.stdout, /npx -y ai-model-status-mcp status \[model\]/);
  const v = await runCli(['--version']);
  assert.equal(v.stdout.trim(), '1.1.0');
});

test('CLI: status, fast, top, cheap and compare print tool text to stdout', async () => {
  mode = 'ok';
  const s = await runCli(['status']);
  assert.equal(s.code, 0);
  assert.match(s.stdout, /uptime 7d/);
  assert.match(s.stdout, /one independent AI API gateway/);
  assert.equal((await runCli(['fast'])).code, 0);
  const t = await runCli(['top']);
  assert.equal(t.code, 0);
  assert.match(t.stdout, /Most-used models/);
  assert.doesNotMatch(t.stdout, /uncensored|abliterated|nsfw/i);
  assert.equal((await runCli(['cheap', 'coding'])).code, 0);
  const c = await runCli(['compare', 'only-one']);
  assert.notEqual(c.code, 0);
});

test('CLI: unknown command exits 2 with help on stderr; data errors exit 1', async () => {
  const u = await runCli(['bogus']);
  assert.equal(u.code, 2);
  assert.match(u.stderr, /Unknown command: bogus/);
  assert.equal(u.stdout, '');
  const d = await runCli(['top'], { AI_MODEL_STATUS_SOURCE: 'http://127.0.0.1:9' });
  assert.equal(d.code, 1);
});
