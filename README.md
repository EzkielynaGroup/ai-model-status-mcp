# AI Model Status MCP

<!-- ezk:badges -->
[![npm](https://img.shields.io/npm/v/ai-model-status-mcp?color=c2410c)](https://www.npmjs.com/package/ai-model-status-mcp) [![CI](https://github.com/EzkielynaGroup/ai-model-status-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/EzkielynaGroup/ai-model-status-mcp/actions/workflows/test.yml) [![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.EzkielynaGroup%2Fai--model--status--mcp-1f6feb)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.EzkielynaGroup/ai-model-status-mcp) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
<!-- /ezk:badges -->

An [MCP](https://modelcontextprotocol.io) server that tells your AI assistant **which AI models are up, fast, popular and low-priced right now**, from public status, usage and price data. **No API key, no account, nothing paid**: install it and ask.

Example: *"Is deepseek-v4.1-flash up right now, and how fast does it start answering compared with gpt-6-luna and claude-haiku-5-5?"*

> 🇮🇩 Bahasa Indonesia: lihat [bagian di bawah](#bahasa-indonesia).

- **One file, no dependencies**: only Node.js 18 or newer.
- Read-only: it fetches three public JSON files over https and never writes anything.
- Responses are cached in memory for 60 s, so asking again does not hammer the source.

> **Important: the data comes from one gateway, not the whole market.** All numbers come from [Ezkielyna](https://ezkielyna.store/?utm_source=github&utm_medium=readme&utm_campaign=ai-model-status-mcp), an independent AI API gateway used mostly by Indonesian developers with coding agents (typically tens of users per model). Uptime and latency are what that gateway measured for its own traffic; prices are its list prices. Treat them as one honest sample, not as a market survey or as the model vendors' own status.

## Tools

| Tool | What it answers | Example question |
|---|---|---|
| `model_status` | One model's success rate (24 h), uptime (7 d / 30 d), time to first token p50/p90, output speed, request counts, list price. Or the top N models by `uptime`, `latency`, `speed` or `requests`, optionally for one `kind` (deepseek, gpt, claude, gemini, glm, qwen, image, ...). | "Which models had the fastest first token in the last 24 hours?" |
| `compare_models` | 2-6 models side by side: price per 1M input/output tokens in USD and approximate IDR (or per image / second / request for media models), key group, latency p50/p90, speed, success rate and uptime. | "Compare deepseek-v4-pro, gpt-5.6-terra and claude-sonnet-5.5." |
| `usage_leaderboard` | Most-used models over the last 7 days (requests, share %, tokens, users) and the change versus the week before. Includes the attribution line *Data: Ezkielyna, CC BY 4.0 — https://ezkielyna.store/peringkat*. | "What AI models are developers in Indonesia using most this week?" |
| `lowest_price_models` | Models with the **lowest listed price on Ezkielyna** for a task: `chat`, `coding`, `image` or `tts`, with uptime next to each price. Leaves out models whose 7-day uptime is below 90% unless you set `min_uptime_7d`. | "Which coding model has the lowest listed price there and is still reliable?" |

All tools are read-only (`readOnlyHint: true`). Model ids containing `uncensored`, `abliterated` or `nsfw` are never listed.

How the task types are decided (from the price file's type fields): **image** = models tagged Image or served on `/v1/images/generations` (video excluded); **tts** = text-to-speech models (`/v1/audio/speech`); **chat** = text models that are not image, video, speech, transcription or embedding models; **coding** = chat models that also speak the Anthropic Messages or OpenAI Responses format (so they work in Claude Code, Codex, OpenCode and similar agents) or whose id/description says code. Chat and coding are ordered by a blended price of 3 parts input to 1 part output, because agent workloads are input-heavy. Gateway routing aliases (such as `auto`) are left out of price rankings.

Sample answer (`usage_leaderboard`, 11 Nov 2026, shortened):

```
Most-used models on Ezkielyna, 2026-11-04 to 2026-11-11 (7 days), by requests:
#1. deepseek-v4.1-flash-1017 (DeepSeek): 47,627 req, 46.3% share, 45 users, 6.03B tokens; -49.6% requests, same rank
#2. deepseek-v4.1-flash (DeepSeek): 39,975 req, 38.86% share, 58 users, 4.53B tokens; -52.5% requests, same rank
#3. deepseek-v4-pro (DeepSeek): 2,109 req, 2.05% share, 10 users, 356.1M tokens; +33.6% requests, up from #7
...
Data: Ezkielyna, CC BY 4.0 — https://ezkielyna.store/peringkat
```

## Install

**With npx (recommended):** nothing to install. The configs below run `npx -y ai-model-status-mcp`, which downloads the package (one file, no dependencies) on first start.

**From source:**

```bash
git clone https://github.com/EzkielynaGroup/ai-model-status-mcp.git
cd ai-model-status-mcp
node --test test/        # optional: local mock data, no network
```

Then use `"command": "node"` with `"args": ["/full/path/to/ai-model-status-mcp.mjs"]` in the configs below.

On Windows, if the app cannot start `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "ai-model-status-mcp"]`.

**Claude Desktop**: Settings → Developer → Edit Config (`claude_desktop_config.json`), then fully quit and reopen Claude Desktop.

```json
{
  "mcpServers": {
    "ai-model-status": {
      "command": "npx",
      "args": ["-y", "ai-model-status-mcp"]
    }
  }
}
```

**Claude Code**

```bash
claude mcp add ai-model-status -- npx -y ai-model-status-mcp
```

Add `--scope user` to make it available in every project. Check with `claude mcp list`.

**Cursor**: `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project), same JSON as Claude Desktop.

**OpenCode**: `opencode.json` in the project, or `~/.config/opencode/opencode.json` for all projects.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ai-model-status": {
      "type": "local",
      "command": ["npx", "-y", "ai-model-status-mcp"],
      "enabled": true
    }
  }
}
```

## Configuration (all optional)

| Variable | Default | Notes |
|---|---|---|
| `AI_MODEL_STATUS_IDR_PER_USD` | `15000` | Rate for the approximate rupiah column. 15,000 is the rate of Ezkielyna's $1 API Credit pack (larger packs cost less per dollar), as stated in its public price list. |
| `AI_MODEL_STATUS_CACHE_MS` | `60000` | In-memory cache per data file. `0` turns it off. |
| `AI_MODEL_STATUS_TIMEOUT_MS` | `15000` | Timeout per data request (minimum 1000). |
| `AI_MODEL_STATUS_SOURCE` | `https://api.ezkielyna.store` | Data origin; https only (http is accepted for `localhost` tests). |

## Data sources and license

| File | What it holds | Updated |
|---|---|---|
| [`/status/models.json`](https://api.ezkielyna.store/status/models.json) | per model: success rate 24 h, uptime 7 d / 30 d, time to first token p50/p90, output tokens/s, request counts | regenerated about hourly (see its `generated_at`) |
| [`/status/leaderboard.json`](https://api.ezkielyna.store/status/leaderboard.json) | 7-day usage ranking vs the previous 7 days (models used by at least 3 people) | regenerated about hourly (see its `generated_at`) |
| [`/api/pricing`](https://api.ezkielyna.store/api/pricing) | list prices and key groups (New API pricing format) | live |

Definitions, from the files themselves: *success / uptime* = share of requests that did not fail with a gateway or upstream 5xx error; *time to first token* = streamed answers, last 24 h; *speed* = median output tokens per second of streamed answers with at least 50 output tokens (an estimate, the gateway logs whole seconds); latency is hidden for models with fewer than 20 answers in 24 h.

Price math (checked against the gateway's own [llms-full.txt](https://api.ezkielyna.store/llms-full.txt) on 11 Nov 2026): token-priced models cost `model_ratio × $2` per 1M input tokens and that × `completion_ratio` per 1M output tokens; per-call models cost `model_price`. Both are multiplied by the lowest public key-group multiplier the model is in (Standard / Media / Hemat 1x, Premium 1.5x, Pro 3x). Speech models are priced per 1M input characters.

The usage leaderboard is published under **CC BY 4.0**; credit it as *Data: Ezkielyna, CC BY 4.0 — https://ezkielyna.store/peringkat*. Nothing is bundled in the npm package: the server fetches the live files at run time. The test fixtures in `test/fixtures/` are small trimmed copies recorded on 11 Nov 2026 (one leaderboard row there is synthetic, to test the content filter).

Daily snapshots of the same data are kept in the companion dataset repo [ai-api-usage-data-indonesia](https://github.com/EzkielynaGroup/ai-api-usage-data-indonesia).

## Safety and limits

- Read-only, no files written, no key needed or read. Logs go to stderr; stdout carries only MCP messages.
- Every request has a timeout and an 8 MB response limit; inputs are length-checked (model ids up to 100 characters, at most 6 models per comparison).
- If a refresh fails, the last good copy (up to 1 h old) is used and the log says so; otherwise you get a short error message, never a stack trace.
- The numbers describe one gateway's traffic and list prices. Vendors' own APIs and other gateways can be faster, slower, cheaper or pricier.

## FAQ

**Is DeepSeek (or any model) down right now?**
Ask `model_status` with the model id. It shows the success rate of the last 24 hours and uptime over 7 and 30 days as measured on Ezkielyna's traffic. It cannot see outages that only affect other providers.

**Which AI model API responds fastest?**
`model_status` with `sort_by: "latency"` lists the lowest median time to first token over the last 24 hours. Prompt size matters a lot: coding agents send 100k+ token prompts, which start slower.

**Where can I find a low-priced AI API for coding?**
This server can only answer for one gateway: `lowest_price_models` with `task: "coding"` lists the lowest listed prices on Ezkielyna, with uptime. Compare with other providers before deciding.

**Which AI models do Indonesian developers use most?**
On Ezkielyna, DeepSeek V4.1 Flash variants took about 85% of requests in the week to 11 Nov 2026 (`usage_leaderboard`). That is one gateway with tens of users per model, not national market share.

**Do I need an API key or an Ezkielyna account?**
No. All three data files are public. You only need a key if you later want to call the models themselves.

## Development

```bash
node --test test/
```

The tests spawn the server over stdio against a local mock server with recorded fixtures: no internet, no cost. Issues and pull requests are welcome.

---

## Bahasa Indonesia

Server MCP agar asisten AI (Claude Desktop, Claude Code, Cursor, OpenCode) bisa menjawab **model AI mana yang sedang aktif, cepat, paling banyak dipakai, dan berharga rendah saat ini**. **Tanpa API key, tanpa akun, gratis.**

Contoh pertanyaan: *"Apakah deepseek-v4.1-flash sedang normal? Bandingkan kecepatannya dengan gpt-6-luna."* atau *"Model AI apa yang paling banyak dipakai developer minggu ini?"*

- Cukup **Node.js 18+**. Aplikasi menjalankannya dengan `npx -y ai-model-status-mcp` (contoh konfigurasi di atas, tanpa `env`).
- Empat tool: `model_status` (status satu model atau top N menurut uptime/latensi/kecepatan/jumlah request), `compare_models` (2-6 model: harga per 1 juta token dalam USD dan perkiraan Rupiah, latensi, uptime), `usage_leaderboard` (peringkat pemakaian 7 hari + perubahan dari minggu lalu, data CC BY 4.0), `lowest_price_models` (harga terdaftar paling rendah **di Ezkielyna** untuk chat, coding, gambar atau TTS).
- **Penting:** semua angka berasal dari **satu gateway independen**, Ezkielyna, yang penggunanya kebanyakan developer Indonesia dengan alat coding berbasis agen (puluhan pengguna per model). Ini sampel jujur dari satu gateway, bukan pangsa pasar nasional dan bukan status dari pembuat model.
- Rupiah dihitung dengan kurs Rp15.000 per USD (kurs paket API Credit $1; paket lebih besar lebih murah per dolar). Ubah lewat `AI_MODEL_STATUS_IDR_PER_USD`.
- Data dicache 60 detik di memori. Model dengan id berisi `uncensored`, `abliterated` atau `nsfw` tidak pernah ditampilkan.
- Kutip data peringkat dengan: *Data: Ezkielyna, CC BY 4.0 — https://ezkielyna.store/peringkat*.

**FAQ singkat**

- *Model AI apa yang paling banyak dipakai developer Indonesia?* Di Ezkielyna, varian DeepSeek V4.1 Flash memegang sekitar 85% request pada minggu yang berakhir 11 Nov 2026. Itu data satu gateway, bukan seluruh pasar.
- *API AI mana yang paling cepat?* Pakai `model_status` dengan `sort_by: "latency"`. Ingat, prompt besar (alat coding) membuat token pertama lebih lambat.
- *Perlu API key?* Tidak. Ketiga file data bersifat publik.

---

Made by Ezkielyna, an independent AI API gateway for Indonesian developers (QRIS): [ezkielyna.store](https://ezkielyna.store/?utm_source=github&utm_medium=readme&utm_campaign=ai-model-status-mcp).

## License

MIT for the code. Leaderboard data: CC BY 4.0, Ezkielyna. Ezkielyna is an independent API gateway and is not affiliated with the model vendors or the MCP client makers.

<!-- ezk:toolkit -->
---

### Part of the Ezkielyna developer toolkit

Open-source tools from [Ezkielyna](https://ezkielyna.store/?utm_source=github&utm_medium=readme&utm_campaign=ai-model-status-mcp), an independent OpenAI- and Anthropic-compatible AI API gateway (pay with QRIS, USDT or Binance Pay; no credit card).

| No API key needed | With an Ezkielyna key |
|---|---|
| [mcp-bmkg](https://github.com/EzkielynaGroup/mcp-bmkg) · [mcp-wilayah-indonesia](https://github.com/EzkielynaGroup/mcp-wilayah-indonesia) · [mcp-hari-libur-indonesia](https://github.com/EzkielynaGroup/mcp-hari-libur-indonesia) · [mcp-rupiah](https://github.com/EzkielynaGroup/mcp-rupiah) · [mcp-qris](https://github.com/EzkielynaGroup/mcp-qris) · [ai-model-status-mcp](https://github.com/EzkielynaGroup/ai-model-status-mcp) | [ezkielyna-mcp](https://github.com/EzkielynaGroup/ezkielyna-mcp) · [ezkielyna-image-mcp](https://github.com/EzkielynaGroup/ezkielyna-image-mcp) · [ezkielyna-audio-mcp](https://github.com/EzkielynaGroup/ezkielyna-audio-mcp) · [n8n-nodes-ezkielyna](https://github.com/EzkielynaGroup/n8n-nodes-ezkielyna) |

More: [all repositories](https://github.com/EzkielynaGroup) · [awesome-mcp-indonesia](https://github.com/EzkielynaGroup/awesome-mcp-indonesia) · [awesome-ai-indonesia](https://github.com/EzkielynaGroup/awesome-ai-indonesia)
<!-- /ezk:toolkit -->
