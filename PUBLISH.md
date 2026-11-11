# Publishing notes (owner)

**GitHub description (<= 120 chars):**
MCP server: which AI model is up, fast, popular or low-priced right now. Public data, no API key. Node 18, zero deps.

**Topics:** mcp, model-context-protocol, mcp-server, llm, ai-models, llm-pricing, model-status, uptime, latency, leaderboard, claude-code, cursor, opencode, indonesia

**Homepage:** https://ezkielyna.store/peringkat?utm_source=github&utm_medium=repo&utm_campaign=ai-model-status-mcp

**Owner actions (not done, build was local only):**
1. Create the public repo `EzkielynaGroup/ai-model-status-mcp`, push `main`.
2. `npm publish` (name `ai-model-status-mcp` was free on npm on 11 Nov 2026), then `mcp-publisher publish` with `server.json`.
3. Optional listings: Smithery, Glama, mcp.so, awesome-mcp-servers (category "Monitoring" or "Data"). Show HN angle: "MCP that answers which LLM is up/fast right now, no key".
4. Keep the three public JSON files stable: this server depends on `models.<id>.{uptime_7d, ttft_ms_p50, ...}`, `models.items[]` in the leaderboard and New API `/api/pricing` fields `model_ratio`, `completion_ratio`, `model_price`, `enable_groups`, `group_ratio`, `usable_group`.
