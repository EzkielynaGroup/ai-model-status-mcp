#!/usr/bin/env node
// AI Model Status MCP: answers "which AI model is up / fast / low-priced right now" from the public status, usage-ranking
// and price files of Ezkielyna, one independent AI API gateway. No API key, no account, nothing paid.
// One file, no dependencies, Node >= 18. MCP over stdio (newline-delimited JSON-RPC). Logs go to stderr only.
//
// Env (all optional):
//   AI_MODEL_STATUS_SOURCE       data origin, default https://api.ezkielyna.store (https only; http allowed for localhost tests)
//   AI_MODEL_STATUS_TIMEOUT_MS   timeout per request, default 15000
//   AI_MODEL_STATUS_CACHE_MS     in-memory cache per file, default 60000 (60 s)
//   AI_MODEL_STATUS_IDR_PER_USD  rate for the approximate rupiah column, default 15000
import readline from 'node:readline';

const VERSION = '1.1.1';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';
const UTM = '?utm_source=github&utm_medium=mcp&utm_campaign=ai-model-status-mcp';
const ATTRIBUTION = 'Data: Ezkielyna, CC BY 4.0 — https://ezkielyna.store/peringkat';
const SCOPE_NOTE = 'Source: Ezkielyna, one independent AI API gateway (not the whole market).';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const STALE_MAX_MS = 60 * 60 * 1000; // a failed refresh may fall back to data up to 1 h old
// Ids with these words are never listed (content policy of this tool).
const BLOCKED = /uncensored|abliterated|nsfw/i;
const FILES = {
  status: '/status/models.json',
  leaderboard: '/status/leaderboard.json',
  pricing: '/api/pricing',
};
const FALLBACK_PUBLIC_GROUPS = ['default', 'free', 'media', 'premium', 'pro'];

const env = process.env;
const SOURCE = parseSource(env.AI_MODEL_STATUS_SOURCE || 'https://api.ezkielyna.store');
const TIMEOUT_MS = positiveInt(env.AI_MODEL_STATUS_TIMEOUT_MS, 15000, 1000);
const CACHE_MS = positiveInt(env.AI_MODEL_STATUS_CACHE_MS, 60000, 0);
const IDR_PER_USD = positiveInt(env.AI_MODEL_STATUS_IDR_PER_USD, 15000, 1);

const cache = new Map(); // key -> { at, value }
const inflight = new Map();

function positiveInt(v, dflt, min) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= min ? n : dflt;
}

function parseSource(s) {
  let u;
  try { u = new URL(String(s).trim()); } catch { return { error: `AI_MODEL_STATUS_SOURCE is not a URL: ${s}` }; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { error: 'AI_MODEL_STATUS_SOURCE must use https.' };
  return { origin: u.origin };
}

function log(...args) {
  process.stderr.write('[ai-model-status] ' + args.map(String).join(' ') + '\n');
}

class ToolError extends Error {}

// ---------- data access (cached) ----------

async function load(key) {
  if (SOURCE.error) throw new ToolError(SOURCE.error);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await fetchJson(SOURCE.origin + FILES[key]);
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch (e) {
      if (hit && Date.now() - hit.at < STALE_MAX_MS) {
        log(`refresh of ${key} failed, serving cached copy:`, e.message);
        return hit.value;
      }
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

async function fetchJson(url) {
  let r;
  try {
    r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'ai-model-status-mcp/' + VERSION }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new ToolError((timeout ? 'The data source timed out' : 'Could not reach the data source') + ` (${new URL(url).host}). `
      + 'Check your connection and try again. / Sumber data tidak bisa dihubungi, coba lagi sebentar.');
  }
  if (!r.ok) throw new ToolError(`The data source answered HTTP ${r.status} for ${new URL(url).pathname}. Try again later. / Coba lagi nanti.`);
  if (Number(r.headers.get('content-length')) > MAX_BODY_BYTES) throw new ToolError('The data file is unexpectedly large; refusing to read it.');
  const chunks = [];
  let size = 0;
  for await (const c of r.body) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw new ToolError('The data file is unexpectedly large; refusing to read it.');
    chunks.push(Buffer.from(c));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ToolError(`The data source sent something that is not JSON (${new URL(url).pathname}). Try again later.`);
  }
}

async function statusData() {
  const v = await load('status');
  if (!v || typeof v.models !== 'object' || !v.models) throw new ToolError('Status file has an unexpected shape; try again later.');
  const models = new Map();
  for (const [id, s] of Object.entries(v.models)) if (!BLOCKED.test(id) && s && typeof s === 'object') models.set(id, s);
  return { generatedAt: v.generated_at, models };
}

async function pricingData() {
  const v = await load('pricing');
  if (!v || !Array.isArray(v.data)) throw new ToolError('Price file has an unexpected shape; try again later.');
  const groupRatio = v.group_ratio && typeof v.group_ratio === 'object' ? v.group_ratio : {};
  const labels = v.usable_group && typeof v.usable_group === 'object' ? v.usable_group : {};
  let publicGroups = Object.keys(labels).filter(g => g !== 'auto' && Number(groupRatio[g]) > 0);
  if (!publicGroups.length) publicGroups = FALLBACK_PUBLIC_GROUPS.filter(g => Number(groupRatio[g]) > 0);
  const vendors = new Map((Array.isArray(v.vendors) ? v.vendors : []).map(x => [x.id, x.name]));
  const byId = new Map();
  for (const m of v.data) {
    if (!m || typeof m.model_name !== 'string' || BLOCKED.test(m.model_name)) continue;
    byId.set(m.model_name, price(m, { groupRatio, labels, publicGroups, vendors }));
  }
  return { byId };
}

// Turns one New API pricing row into list prices. Text models: model_ratio 1 = $2 per 1M input tokens, output = input x
// completion_ratio. Per-call models: model_price in USD. Both are multiplied by the lowest public key-group multiplier the
// model is in (Standard/Media/Hemat 1x, Premium 1.5x, Pro 3x), the same rule as https://api.ezkielyna.store/llms-full.txt.
function price(m, ctx) {
  const groups = (Array.isArray(m.enable_groups) ? m.enable_groups : []).filter(g => ctx.publicGroups.includes(g));
  const ratios = groups.map(g => Number(ctx.groupRatio[g])).filter(n => n > 0);
  const mult = ratios.length ? Math.min(...ratios) : null;
  const lowestGroups = groups.filter(g => Number(ctx.groupRatio[g]) === mult);
  const tags = String(m.tags || '');
  const ep = Array.isArray(m.supported_endpoint_types) ? m.supported_endpoint_types : [];
  const desc = String(m.description || '');
  const out = {
    id: m.model_name,
    vendor: ctx.vendors.get(m.vendor_id) || null,
    groups: groups.map(g => groupLabel(g, ctx.labels)),
    keyGroup: lowestGroups.map(g => groupLabel(g, ctx.labels)).join(' / ') || null,
    multiplier: mult,
    tags,
    endpoints: ep,
    description: desc,
    perCall: null,
    unit: null,
    inUsd: null,
    outUsd: null,
    cacheUsd: null,
  };
  if (mult == null) return out; // not sold in a public key group
  if (Number(m.quota_type) === 1) {
    const p = Number(m.model_price);
    if (p > 0) out.perCall = p * mult;
    const u = desc.match(/priced per (image|second|request|minute|call)/i);
    out.unit = u ? u[1].toLowerCase() : 'call';
  } else {
    const r = Number(m.model_ratio);
    if (r > 0) {
      out.inUsd = r * 2 * mult;
      out.outUsd = out.inUsd * (Number(m.completion_ratio) > 0 ? Number(m.completion_ratio) : 1);
      if (Number(m.cache_ratio) > 0 && Number(m.cache_ratio) < 1) out.cacheUsd = out.inUsd * Number(m.cache_ratio);
    }
    out.unit = isTts(out) ? '1M input characters' : isStt(out) ? 'stt' : '1M tokens';
  }
  return out;
}

function groupLabel(g, labels) {
  const l = typeof labels[g] === 'string' ? labels[g].split(/\s+/)[0] : '';
  return l || g;
}

// ---------- model kinds ----------

const isVideo = (p, s) => /video/i.test(p.tags) || p.endpoints.includes('openai-video') || s?.kind === 'video';
const isImage = (p, s) => !isVideo(p, s) && (/^image$/i.test(p.tags) || p.endpoints.includes('image-generation') || s?.kind === 'image' || /priced per image/i.test(p.description));
const isTts = p => /^tts$/i.test(p.tags) || (p.endpoints.includes('openai-audio') && !/^stt$/i.test(p.tags));
const isStt = p => /^stt$/i.test(p.tags) || /^(stt-|whisper)/i.test(p.id);
const isEmbedding = p => /embedding/i.test(p.tags) || p.endpoints.includes('embeddings');
const isAlias = s => s?.vendor === 'Ezkielyna';
function isChat(p, s) {
  return !isVideo(p, s) && !isImage(p, s) && !isTts(p) && !isStt(p) && !isEmbedding(p) && p.perCall == null
    && (p.endpoints.includes('openai') || p.endpoints.includes('anthropic'));
}
// Coding: chat models that also speak the Anthropic Messages or OpenAI Responses format (so they plug into Claude Code,
// Codex, OpenCode and similar agents), or whose id/description says code.
function isCoding(p, s) {
  return isChat(p, s) && (p.endpoints.includes('anthropic') || p.endpoints.includes('openai-response') || /\bcod(e|er|ing)\b/i.test(p.id + ' ' + p.description));
}

// ---------- formatting ----------

function sig(n) {
  if (n == null || !Number.isFinite(n)) return null;
  if (n === 0) return '0';
  const d = n >= 100 ? 2 : n >= 1 ? 3 : 4;
  return String(Number(n.toPrecision(d)));
}
const usd = n => (n == null ? '-' : '$' + (n >= 1 ? Number(n.toFixed(2)).toString() : sig(n)));
function idr(n) {
  if (n == null) return '-';
  const v = n * IDR_PER_USD;
  const r = v >= 10 ? Math.round(v) : v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
  const [a, b] = String(r).split('.');
  return 'Rp' + a.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (b ? ',' + b : '');
}
const pct = n => (n == null ? '-' : `${Number(n.toFixed(2))}%`);
const secs = ms => (ms == null ? '-' : `${Number((ms / 1000).toFixed(1))} s`);
const num = n => (n == null ? '-' : Number(n).toLocaleString('en-US'));
function tokens(n) {
  const v = Number(n) || 0;
  return v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v);
}

function priceText(p) {
  if (!p) return 'no public price';
  if (p.multiplier == null) return 'not sold in a public key group';
  if (p.perCall != null) return `${usd(p.perCall)} per ${p.unit} (~${idr(p.perCall)})`;
  if (p.unit === 'stt') return 'billed per minute of audio (see the model page)';
  if (p.inUsd == null) return 'no public price';
  if (p.unit === '1M input characters') return `${usd(p.inUsd)} per 1M input characters (~${idr(p.inUsd)})`;
  return `in ${usd(p.inUsd)} / out ${usd(p.outUsd)} per 1M tokens (~${idr(p.inUsd)} / ${idr(p.outUsd)})`
    + (p.cacheUsd != null ? `, cached input ${usd(p.cacheUsd)}` : '');
}

function rateNote() {
  return `Rupiah is approximate: Rp${IDR_PER_USD.toLocaleString('id-ID')} per USD (the rate of the $1 API Credit pack; larger packs cost less per dollar).`;
}

function asOf(ts) {
  return ts ? ` Data as of ${ts}.` : '';
}

function norm(s) {
  return String(s).toLowerCase().trim().replace(/[\s._]+/g, '-');
}

// Finds a model id case-insensitively, treating "." "_" and "-" as the same. Returns { id } or { suggestions }.
function resolve(name, ids) {
  const raw = String(name || '').trim();
  if (!raw) return { suggestions: [] };
  if (BLOCKED.test(raw)) return { suggestions: [] };
  if (ids.includes(raw)) return { id: raw };
  const n = norm(raw);
  const exact = ids.filter(id => norm(id) === n);
  if (exact.length) return { id: exact[0] };
  const parts = n.split('-').filter(Boolean);
  const scored = ids.map(id => {
    const ni = norm(id);
    let score = ni.includes(n) ? 100 - Math.abs(ni.length - n.length) : 0;
    if (!score) score = parts.filter(p => ni.includes(p)).length * 10 - Math.abs(ni.length - n.length) / 10;
    return { id, score };
  }).filter(x => x.score > 5).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { suggestions: scored.slice(0, 5).map(x => x.id) };
}

function notFound(name, r) {
  return `"${String(name).slice(0, 100)}" is not in the Ezkielyna model list.` + (r.suggestions.length ? ` Did you mean: ${r.suggestions.join(', ')}?` : '');
}

// ---------- arguments ----------

function optText(v, name, max = 100) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string') throw new ToolError(`"${name}" must be a string.`);
  const t = v.trim();
  if (t.length > max) throw new ToolError(`"${name}" is too long (max ${max} characters).`);
  return t;
}

function intArg(v, name, dflt, min, max) {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ToolError(`"${name}" must be a whole number from ${min} to ${max}.`);
  return n;
}

function numArg(v, name, dflt, min, max) {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ToolError(`"${name}" must be a number from ${min} to ${max}.`);
  return n;
}

function enumArg(v, name, values, dflt) {
  if (v == null || v === '') return dflt;
  if (typeof v !== 'string' || !values.includes(v.trim().toLowerCase())) throw new ToolError(`"${name}" must be one of: ${values.join(', ')}.`);
  return v.trim().toLowerCase();
}

// ---------- tools ----------

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const SORTS = ['uptime', 'latency', 'speed', 'requests'];
const TASKS = ['chat', 'coding', 'image', 'tts'];

const TOOLS = [
  {
    name: 'model_status',
    title: 'Model status (uptime, latency, speed)',
    description: 'Live status of AI models on Ezkielyna, one independent API gateway: success rate (24 h), uptime (7 d / 30 d), '
      + 'time to first token (p50/p90), output speed and request counts. Give "model" for one model, or leave it empty for the top N '
      + 'sorted by uptime, latency (fastest first token), speed (tokens/s) or requests (busiest). Free, no API key.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', maxLength: 100, description: 'Model id, e.g. deepseek-v4.1-flash or claude-sonnet-5.5. Leave empty for a top-N list.' },
        sort_by: { type: 'string', enum: SORTS, default: 'uptime', description: 'Ranking for the top-N list.' },
        top: { type: 'integer', minimum: 1, maximum: 25, default: 10, description: 'How many models to list.' },
        kind: { type: 'string', maxLength: 30, description: 'Optional family filter as used by the status file: deepseek, gpt, claude, gemini, glm, qwen, kimi, minimax, image, video, audio, other.' },
        min_requests_7d: { type: 'integer', minimum: 0, maximum: 1000000, default: 50, description: 'For sort_by=uptime: ignore models with fewer answers in 7 days (a 100% uptime from 3 requests means little).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Model status', ...READ_ONLY },
  },
  {
    name: 'compare_models',
    title: 'Compare models (price, latency, uptime)',
    description: 'Side-by-side comparison of 2-6 AI models on Ezkielyna: list price per 1M input/output tokens in USD with approximate IDR '
      + '(or price per image/second/request for media models), key group, time to first token p50/p90, output speed, success rate 24 h and '
      + 'uptime 7 d / 30 d. Prices are this one gateway\'s list prices, not a market survey. Free, no API key.',
    inputSchema: {
      type: 'object',
      properties: {
        models: { type: 'array', items: { type: 'string', maxLength: 100 }, minItems: 2, maxItems: 6, description: 'Model ids, e.g. ["deepseek-v4.1-flash", "gpt-6-luna", "claude-haiku-5-5"].' },
      },
      required: ['models'],
      additionalProperties: false,
    },
    annotations: { title: 'Compare models', ...READ_ONLY },
  },
  {
    name: 'usage_leaderboard',
    title: 'Weekly usage leaderboard',
    description: 'Most-used AI models on Ezkielyna over the last 7 days (requests, share %, tokens, distinct users) and the change versus '
      + 'the week before. Only models used by at least 3 people are ranked. Users are mostly Indonesian developers with coding agents, '
      + 'so this is one gateway\'s sample, not national market share. Data CC BY 4.0. Free, no API key.',
    inputSchema: {
      type: 'object',
      properties: {
        top: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: 'How many models to list.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Usage leaderboard', ...READ_ONLY },
  },
  {
    name: 'lowest_price_models',
    title: 'Lowest listed prices on Ezkielyna',
    description: 'Models with the lowest listed price on Ezkielyna for a task: chat, coding (models that also work with Claude Code / Codex / '
      + 'OpenCode style agents), image (price per image) or tts (price per 1M characters). Shows uptime next to each price and by default '
      + 'leaves out models whose 7-day uptime is below 90%. Only covers this one gateway, not a market-wide price comparison. Free, no API key.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', enum: TASKS, description: 'What the model is for.' },
        top: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: 'How many models to list.' },
        min_uptime_7d: { type: 'number', minimum: 0, maximum: 100, default: 90, description: 'Leave out models whose known 7-day uptime is below this. Models without status data are kept and marked.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    annotations: { title: 'Lowest listed prices', ...READ_ONLY },
  },
];

async function callTool(name, args) {
  if (name === 'model_status') return modelStatus(args);
  if (name === 'compare_models') return compareModels(args);
  if (name === 'usage_leaderboard') return usageLeaderboard(args);
  if (name === 'lowest_price_models') return lowestPriceModels(args);
  throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
}

function statusLine(id, s) {
  if (!s) return `- ${id}: no status data yet`;
  const bits = [
    `success 24h ${pct(s.success_24h)} (${num(s.requests_24h)} req)`,
    `uptime 7d ${pct(s.uptime_7d)} (${num(s.requests_7d)} req)`,
    `30d ${pct(s.uptime_30d)}`,
  ];
  if (!s.low_data) {
    bits.push(`first token p50 ${secs(s.ttft_ms_p50)} / p90 ${secs(s.ttft_ms_p90)}`);
    if (s.tps_p50 != null) bits.push(`speed ${Number(s.tps_p50).toFixed(0)} tok/s`);
  } else {
    bits.push('latency hidden (fewer than 20 answers in 24 h)');
  }
  return `- ${id}${s.vendor ? ` (${s.vendor})` : ''}${isAlias(s) ? ' [gateway routing alias]' : ''}: ${bits.join(', ')}`;
}

async function modelStatus(args) {
  const model = optText(args.model, 'model');
  const sortBy = enumArg(args.sort_by, 'sort_by', SORTS, 'uptime');
  const top = intArg(args.top, 'top', 10, 1, 25);
  const kind = optText(args.kind, 'kind', 30).toLowerCase();
  const minReq = intArg(args.min_requests_7d, 'min_requests_7d', 50, 0, 1000000);
  const { generatedAt, models } = await statusData();
  const ids = [...models.keys()];

  if (model) {
    const r = resolve(model, ids);
    if (!r.id) return text(notFound(model, r), true);
    const s = models.get(r.id);
    let p = null;
    try { p = (await pricingData()).byId.get(r.id); } catch (e) { log('pricing unavailable:', e.message); }
    return text([
      statusLine(r.id, s),
      `  price: ${p ? priceText(p) : 'not available right now'}${p?.keyGroup ? `; key group ${p.keyGroup}` : ''}`,
      `  page: https://ezkielyna.store/models/${encodeURIComponent(r.id)}${UTM}`,
      '',
      `${SCOPE_NOTE}${asOf(generatedAt)} Success/uptime = share of requests without a gateway or upstream 5xx error.`,
      p && (p.perCall != null || p.inUsd != null) ? rateNote() : null,
    ].filter(x => x != null && x !== false).join('\n'));
  }

  let rows = [...models.entries()].filter(([, s]) => !kind || String(s.kind || '').toLowerCase() === kind);
  let title;
  if (sortBy === 'uptime') {
    rows = rows.filter(([, s]) => s.uptime_7d != null && Number(s.requests_7d) >= minReq)
      .sort((a, b) => b[1].uptime_7d - a[1].uptime_7d || b[1].requests_7d - a[1].requests_7d);
    title = `Highest 7-day uptime (models with at least ${minReq} answers in 7 days)`;
  } else if (sortBy === 'latency') {
    rows = rows.filter(([, s]) => !s.low_data && s.ttft_ms_p50 != null)
      .sort((a, b) => a[1].ttft_ms_p50 - b[1].ttft_ms_p50 || (a[1].ttft_ms_p90 ?? 1e12) - (b[1].ttft_ms_p90 ?? 1e12));
    title = 'Fastest median time to first token, last 24 h (models with at least 20 answers)';
  } else if (sortBy === 'speed') {
    rows = rows.filter(([, s]) => !s.low_data && s.tps_p50 != null).sort((a, b) => b[1].tps_p50 - a[1].tps_p50);
    title = 'Fastest median output speed, last 24 h (models with at least 20 answers)';
  } else {
    rows = rows.filter(([, s]) => Number(s.requests_24h) > 0).sort((a, b) => b[1].requests_24h - a[1].requests_24h);
    title = 'Most requests in the last 24 h';
  }
  if (kind) title += `, kind "${kind}"`;
  if (!rows.length) return text(`No models match (${title}). Try another kind or a lower min_requests_7d.\n${SCOPE_NOTE}${asOf(generatedAt)}`);
  return text([
    title + ':',
    ...rows.slice(0, top).map(([id, s]) => statusLine(id, s)),
    '',
    `${SCOPE_NOTE}${asOf(generatedAt)} Time to first token depends on prompt size: large coding-agent prompts start slower.`,
  ].join('\n'));
}

async function compareModels(args) {
  const list = Array.isArray(args.models) ? args.models : [];
  if (list.length < 2 || list.length > 6) throw new ToolError('Give 2 to 6 model ids in "models".');
  const names = list.map((m, i) => optText(m, `models[${i}]`)).filter(Boolean);
  if (names.length < 2) throw new ToolError('Give 2 to 6 model ids in "models".');
  const [st, pr] = await Promise.all([statusData(), pricingData()]);
  const ids = [...new Set([...st.models.keys(), ...pr.byId.keys()])];
  const found = [];
  const missing = [];
  for (const n of names) {
    const r = resolve(n, ids);
    if (r.id) { if (!found.includes(r.id)) found.push(r.id); } else missing.push(notFound(n, r));
  }
  if (!found.length) return text(missing.join('\n'), true);
  const blocks = found.map(id => {
    const s = st.models.get(id);
    const p = pr.byId.get(id);
    return [
      `## ${id}${(s?.vendor || p?.vendor) ? ` (${s?.vendor || p?.vendor})` : ''}${isAlias(s) ? ' [gateway routing alias]' : ''}`,
      `- price: ${priceText(p)}${p?.keyGroup ? `; key group ${p.keyGroup}${p.multiplier && p.multiplier !== 1 ? ` (${p.multiplier}x)` : ''}` : ''}`,
      `- first token: p50 ${s && !s.low_data ? secs(s.ttft_ms_p50) : '-'} / p90 ${s && !s.low_data ? secs(s.ttft_ms_p90) : '-'}`
        + `; speed ${s && !s.low_data && s.tps_p50 != null ? Number(s.tps_p50).toFixed(0) + ' tok/s' : '-'}`
        + (s?.low_data ? ' (latency hidden: fewer than 20 answers in 24 h)' : ''),
      `- reliability: success 24h ${pct(s?.success_24h)}, uptime 7d ${pct(s?.uptime_7d)}, 30d ${pct(s?.uptime_30d)}`,
      `- traffic: ${num(s?.requests_24h)} req 24h, ${num(s?.requests_7d)} req 7d`,
    ].join('\n');
  });
  return text([
    ...blocks,
    ...(missing.length ? ['', ...missing] : []),
    '',
    `${SCOPE_NOTE}${asOf(st.generatedAt)} Prices are Ezkielyna list prices incl. the key-group multiplier, not a market survey.`,
    rateNote(),
  ].join('\n'));
}

async function usageLeaderboard(args) {
  const top = intArg(args.top, 'top', 10, 1, 20);
  const v = await load('leaderboard');
  const items = Array.isArray(v?.models?.items) ? v.models.items : null;
  if (!items) throw new ToolError('Leaderboard file has an unexpected shape; try again later.');
  const shown = items.filter(i => i && typeof i.model === 'string' && !BLOCKED.test(i.model));
  const hidden = items.length - shown.length;
  const w = v.window || {};
  const fmtDay = s => (typeof s === 'string' ? s.slice(0, 10) : '?');
  const change = i => {
    if (i.is_new || i.rank_prev == null) return 'new this week';
    const c = i.change_pct == null ? '' : `${i.change_pct > 0 ? '+' : ''}${i.change_pct}% requests`;
    const move = i.rank_prev === i.rank ? 'same rank' : i.rank_prev > i.rank ? `up from #${i.rank_prev}` : `down from #${i.rank_prev}`;
    return [c, move].filter(Boolean).join(', ');
  };
  const lines = shown.slice(0, top).map(i => `#${i.rank}. ${i.model}${i.vendor ? ` (${i.vendor})` : ''}: ${num(i.requests)} req, `
    + `${i.share_pct}% share, ${num(i.users)} users, ${tokens(i.tokens)} tokens; ${change(i)}`);
  const total = shown.reduce((a, i) => a + (Number(i.requests) || 0), 0);
  const totalPrev = shown.reduce((a, i) => a + (Number(i.requests_prev) || 0), 0);
  const apps = Array.isArray(v.apps?.items) ? v.apps.items.filter(a => a && a.name).slice(0, 5) : [];
  return text([
    `Most-used models on Ezkielyna, ${fmtDay(w.start)} to ${fmtDay(w.end)} (${w.days || 7} days), by requests:`,
    ...lines,
    '',
    `Ranked models together: ${num(total)} requests this week vs ${num(totalPrev)} the week before`
      + (totalPrev ? ` (${total >= totalPrev ? '+' : ''}${((total / totalPrev - 1) * 100).toFixed(1)}%).` : '.'),
    `Ranked only when used by at least ${v.models.min_users || 3} people. Share % is the gateway's published share of requests in the window.`
      + (hidden ? ' Models outside this tool\'s content policy are not listed.' : ''),
    apps.length ? `Top apps (from user agents${v.apps.status === 'partial' ? `, partial data since ${fmtDay(v.apps.data_since)}` : ''}): `
      + apps.map(a => `${a.name} ${a.share_pct}%`).join(', ') : null,
    `${SCOPE_NOTE} Users are mostly Indonesian developers using coding agents, typically tens of users per model.${asOf(v.generated_at)}`,
    ATTRIBUTION,
  ].filter(x => x != null && x !== false).join('\n'));
}

async function lowestPriceModels(args) {
  const task = enumArg(args.task, 'task', TASKS, '');
  if (!task) throw new ToolError(`"task" is required: ${TASKS.join(', ')}.`);
  const top = intArg(args.top, 'top', 10, 1, 20);
  const minUp = numArg(args.min_uptime_7d, 'min_uptime_7d', 90, 0, 100);
  const [st, pr] = await Promise.all([statusData(), pricingData()]);
  const pick = {
    chat: (p, s) => isChat(p, s) && p.inUsd != null,
    coding: (p, s) => isCoding(p, s) && p.inUsd != null,
    image: (p, s) => isImage(p, s) && p.perCall != null,
    tts: p => isTts(p) && p.inUsd != null,
  }[task];
  // Chat/coding are ranked by a blended price (3 parts input : 1 part output), since agent workloads are input-heavy.
  const cost = p => (task === 'image' ? p.perCall : task === 'tts' ? p.inUsd : (3 * p.inUsd + p.outUsd) / 4);
  let below = 0;
  const rows = [];
  for (const p of pr.byId.values()) {
    const s = st.models.get(p.id);
    if (isAlias(s) || p.vendor === 'Ezkielyna' || !pick(p, s)) continue;
    if (s && s.uptime_7d != null && s.uptime_7d < minUp) { below++; continue; }
    rows.push({ p, s, c: cost(p) });
  }
  rows.sort((a, b) => a.c - b.c || a.p.id.localeCompare(b.p.id));
  const label = { chat: 'chat', coding: 'coding (agent-compatible chat models)', image: 'image generation', tts: 'text to speech' }[task];
  if (!rows.length) return text(`No ${label} models with a public price matched (min_uptime_7d ${minUp}).\n${SCOPE_NOTE}`);
  const lines = rows.slice(0, top).map(({ p, s }, n) => {
    const up = s && s.uptime_7d != null ? `uptime 7d ${pct(s.uptime_7d)}` : 'no status data (little or no recent traffic)';
    return `${n + 1}. ${p.id}${p.vendor ? ` (${p.vendor})` : ''}: ${priceText(p)}; key group ${p.keyGroup}; ${up}`;
  });
  return text([
    `Lowest listed prices on Ezkielyna for ${label}:`,
    ...lines,
    '',
    task === 'chat' || task === 'coding' ? 'Order: blended price, 3 parts input to 1 part output.' : null,
    below ? `${below} model(s) left out because their 7-day uptime is below ${minUp}%.` : null,
    `${SCOPE_NOTE} These are Ezkielyna list prices only; other providers may charge less or more.${asOf(st.generatedAt)}`,
    rateNote(),
    `Full price list: https://ezkielyna.store/harga-api-ai${UTM}`,
  ].filter(x => x != null && x !== false).join('\n'));
}

function text(t, isError = false) {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] };
}

// ---------- JSON-RPC over stdio ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (typeof method !== 'string') {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  if (!isRequest) return; // notifications need no answer
  try {
    let result;
    switch (method) {
      case 'initialize': {
        const asked = params && params.protocolVersion;
        result = {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ai-model-status', title: 'AI Model Status', version: VERSION },
          instructions: 'Answers which AI models are up, fast, popular or low-priced right now, from the public status, usage and price files '
            + 'of Ezkielyna (one independent API gateway). Use model_status, compare_models, usage_leaderboard, lowest_price_models. '
            + 'Always tell the user the numbers come from this one gateway, not the whole market. No API key needed.',
        };
        break;
      }
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: TOOLS }; break;
      case 'resources/list': result = { resources: [] }; break;
      case 'resources/templates/list': result = { resourceTemplates: [] }; break;
      case 'prompts/list': result = { prompts: [] }; break;
      case 'tools/call': {
        const name = params && params.name;
        if (!TOOLS.some(t => t.name === name)) {
          send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(name).slice(0, 100)}` } });
          return;
        }
        try {
          const a = params && params.arguments;
          result = await callTool(name, a && typeof a === 'object' && !Array.isArray(a) ? a : {});
        } catch (e) {
          if (!(e instanceof ToolError)) log('tool failed:', (e && e.stack) || e);
          result = text(e instanceof ToolError ? e.message : 'Unexpected error, please try again. / Terjadi kesalahan, coba lagi.', true);
        }
        break;
      }
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        return;
    }
    send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    log('request failed:', (e && e.stack) || e);
    send({ jsonrpc: '2.0', id, error: { code: e.rpcCode || -32603, message: 'Internal error' } });
  }
}


// ---------- CLI mode (1.1.1): `npx ai-model-status-mcp <command>` prints the same text as the tools; no args = MCP server ----------
const CLI_HELP = `ai-model-status-mcp ${VERSION}: which AI model is up, fast, popular or low-priced right now (public data, no API key)

Usage:
  npx -y ai-model-status-mcp                      start the MCP server (stdio); this is what MCP clients run
  npx -y ai-model-status-mcp status [model]       status of one model, or the top 10 by 7-day uptime
  npx -y ai-model-status-mcp fast                 top 10 by first-token latency
  npx -y ai-model-status-mcp compare <a> <b> ...  compare 2-6 models side by side
  npx -y ai-model-status-mcp top                  most-used models this week
  npx -y ai-model-status-mcp cheap <chat|coding|image|tts>   lowest listed prices for a task
  npx -y ai-model-status-mcp --help | --version

${SCOPE_NOTE}`;

async function cli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { process.stdout.write(CLI_HELP + '\n'); return 0; }
  if (cmd === '--version' || cmd === '-v') { process.stdout.write(VERSION + '\n'); return 0; }
  const calls = {
    status: () => ['model_status', rest[0] ? { model: rest[0] } : {}],
    fast: () => ['model_status', { sort_by: 'latency' }],
    compare: () => ['compare_models', { models: rest }],
    top: () => ['usage_leaderboard', {}],
    cheap: () => ['lowest_price_models', { task: rest[0] || 'chat' }],
  };
  if (!calls[cmd]) { process.stderr.write(`Unknown command: ${cmd}\n\n${CLI_HELP}\n`); return 2; }
  const [tool, args] = calls[cmd]();
  try {
    const r = await callTool(tool, args);
    const out = r.content.map(c => c.text).join('\n');
    (r.isError ? process.stderr : process.stdout).write(out + '\n');
    return r.isError ? 1 : 0;
  } catch (e) {
    process.stderr.write(`Error: ${(e && e.message) || e}\n`);
    return 1;
  }
}

function main() {
  if (SOURCE.error) log('warning:', SOURCE.error);
  log(`v${VERSION} ready; source ${SOURCE.origin || '(invalid)'}; cache ${CACHE_MS} ms`);
  const pending = new Set();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    if (!line.trim()) return;
    if (line.length > 1024 * 1024) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } });
      return;
    }
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    for (const m of msgs) {
      const p = handle(m && typeof m === 'object' ? m : {}).catch(e => log('fatal handler error:', (e && e.stack) || e));
      pending.add(p);
      p.finally(() => pending.delete(p));
    }
  });
  rl.on('close', async () => {
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
}

if (process.argv.length > 2) cli(process.argv.slice(2)).then(code => process.exit(code));
else main();
