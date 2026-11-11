# pi-claude-web-search

Runs [pi-web-access](https://github.com/nicobailon/pi-web-access)'s `web_search` tool on Anthropic's server-side web search (`web_search_20250305`), billed to the Claude subscription that [pi-anthropic-auth](https://github.com/gotgenes/pi-anthropic-auth) already signs pi's requests with.

It registers no tool of its own. pi-web-access's `auto` mode tries SearXNG first and reads its endpoint from `SEARXNG_BASE_URL` on every call, so this extension serves a SearXNG-compatible `/search` endpoint on `127.0.0.1` and points that variable at it. `web_search` keeps its routing, batching, storage and fallback: if an Anthropic search fails, pi-web-access moves on to its next provider (Exa, ...).

Anthropic search is used only while the conversation runs on an Anthropic model (the provider of the configured search `model`). When you switch to another provider's model with `/model` or Ctrl+P, the variable is withdrawn and `web_search` behaves as if this extension were not installed; switching back restores it. A session that starts on another provider's model never advertises the endpoint.

## Requirements

- pi 1.5 or later, with `pi-web-access` and `@gotgenes/pi-anthropic-auth` installed
- An Anthropic login in pi (`/login`, Claude subscription)

## Install

```bash
pi install /path/to/pi-claude-web-search
```

## How a search runs

1. The model calls `web_search`; pi-web-access sends `GET <shim>/search?q=...&format=json`.
2. `site:` / `-site:` tokens in `q` become `allowed_domains` / `blocked_domains`.
3. One side query goes out through `ctx.modelRegistry.streamSimple()` with the server tool and `tool_choice: {type: "tool", name: "web_search"}`, the system prompt Claude Code uses for its WebSearch side query, and thinking disabled. pi-ai adds the OAuth headers and betas; pi-anthropic-auth adds the billing block.
4. Search hits and citations are read from the raw stream events (pi-ai drops `server_tool_use` and `web_search_tool_result` blocks from its normalized message).
5. The reply is SearXNG JSON: the model's summary as `answers[0]`, hits as `results` (cited sources first, cited text as `content`).

Results are attributed to "SearXNG" by pi-web-access; the summary starts with `[Anthropic web search via <model>]`.

## Configuration

`~/.pi/agent/claude-web-search.json` (all optional):

```json
{
  "enabled": true,
  "model": "anthropic/claude-haiku-5-5",
  "maxUses": 1,
  "timeoutMs": 25000,
  "maxTokens": 4096,
  "debug": false
}
```

- `timeoutMs` stays below pi-web-access's 30 s SearXNG timeout. When it runs out after hits arrived, the hits are returned with the partial summary; with no hits the endpoint answers 504 and pi-web-access falls back.
- `debug` (or `PI_CLAUDE_WEB_SEARCH_DEBUG=1`) appends request headers (credentials redacted), payloads and outcomes to `~/.pi/agent/claude-web-search.log`.

`/claude-web-search` shows the status (`active`, or `paused` with the reason while another provider's model is in use), `/claude-web-search test <query>` runs one search (also while paused), and `/claude-web-search reload` re-reads the config.

## When it stays inactive

- `SEARXNG_BASE_URL` is already set (not by this extension), or `searxngBaseUrl` is set in pi-web-access's `web-search.json`: your own SearXNG is left alone.
- `enabled` is `false`.

If `web-search.json` pins `provider` to something other than `auto` or `searxng`, the endpoint runs but pi-web-access never asks it; a warning says so.

## Limitations

- pi-web-access cuts results to `numResults`; `recencyFilter` is passed to the model only as a preference.
- Anthropic returns page text encrypted, so a result's `content` holds only the passages the summary cited.
- The side query's token usage is not counted in pi's usage totals.
- Commands that pi runs (bash) inherit `SEARXNG_BASE_URL`; the endpoint listens on loopback only behind a random path token.

## Tests

```bash
npm test
```
