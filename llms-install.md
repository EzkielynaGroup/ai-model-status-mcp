# Installing ai-model-status-mcp (for AI agents such as Cline)

This server needs **no API key** and no account. It reads public status, usage and price data and answers questions like
"which AI model is up and fast right now?".

## Requirements
- Node.js 18 or newer (`node --version`).

## Install
Add this entry to the MCP settings file (for Cline: `cline_mcp_settings.json`):

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

On Windows, if `npx` cannot be started directly, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "ai-model-status-mcp"]`.

## Optional environment variables
| Name | Default | Meaning |
|---|---|---|
| `AI_MODEL_STATUS_TIMEOUT_MS` | see README | timeout for each data fetch |
| `AI_MODEL_STATUS_CACHE_MS` | see README | how long fetched data is cached in memory |
| `AI_MODEL_STATUS_IDR_PER_USD` | see README | exchange rate used when showing prices in Rupiah |

## Verify
Ask the agent: "Use model_status to check deepseek-v4.1-flash." The tools are `model_status`, `compare_models`,
`usage_leaderboard` and `lowest_price_models`. All are read-only.
