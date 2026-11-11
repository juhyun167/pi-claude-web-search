// pi-claude-web-search
//
// Makes pi-web-access's `web_search` run on Anthropic's server-side web search.
//
// pi-web-access tries a configured SearXNG endpoint first in its `auto` mode and
// reads that endpoint from SEARXNG_BASE_URL on every call. This extension starts
// a SearXNG-compatible endpoint on 127.0.0.1 and points SEARXNG_BASE_URL at it,
// so the existing `web_search` tool, its routing, fallback and storage are reused
// unchanged. Each request becomes one Anthropic side query with the
// `web_search_20250305` server tool, sent through pi's model registry so that
// pi-anthropic-auth signs it like any other Claude subscription request.
//
// The endpoint is advertised only while the conversation runs on an Anthropic
// model (see gate.ts). Switching to another provider's model withdraws
// SEARXNG_BASE_URL, so pi-web-access searches as if this extension were absent.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAnthropicSearch, type ModelSource, type SearchOutcome, type SearchRequest } from "./anthropic-search.ts";
import { loadConfig, parseModelRef, readWebAccessConfigFacts, type ClaudeWebSearchConfig } from "./config.ts";
import { startShimServer, toSearxngReply, type ShimServer } from "./shim-server.ts";
import { parseSearxngQuery } from "./query.ts";
import { decideRoute, type ModelIdentity, type RouteDecision } from "./gate.ts";

const ENV_SEARXNG = "SEARXNG_BASE_URL";
/** Marks SEARXNG_BASE_URL as ours, so a child pi that inherits it replaces it. */
const ENV_OWN = "PI_CLAUDE_WEB_SEARCH_URL";

interface Stats {
	searches: number;
	failures: number;
	lastError?: string;
	lastQuery?: string;
	lastDurationMs?: number;
}

export default function claudeWebSearch(pi: ExtensionAPI) {
	let config: ClaudeWebSearchConfig;
	let configPath = "";
	let configError: string | undefined;
	let server: ShimServer | undefined;
	let starting: Promise<void> | undefined;
	let modelSource: ModelSource | undefined;
	let inactiveReason: string | undefined;
	let warning: string | undefined;
	let savedEnv: { searxng: string | undefined; own: string | undefined } | undefined;
	let chatModel: ModelIdentity | undefined;
	let decision: RouteDecision = { route: false, reason: "no session has started" };
	const stats: Stats = { searches: 0, failures: 0 };

	const reloadConfig = () => {
		const loaded = loadConfig(getAgentDir());
		config = loaded.config;
		configPath = loaded.path;
		configError = loaded.error;
	};
	reloadConfig();

	const debugLog = (entry: Record<string, unknown>) => {
		if (!config.debug && process.env.PI_CLAUDE_WEB_SEARCH_DEBUG !== "1") return;
		try {
			appendFileSync(join(getAgentDir(), "claude-web-search.log"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
		} catch {
			// Debug logging must never break a search.
		}
	};

	/** Publishes or withdraws SEARXNG_BASE_URL to match the model in use. */
	function applyRoute(): void {
		decision = decideRoute(chatModel, parseModelRef(config.model).provider);
		if (!server) return;
		const own = server.baseUrl;
		if (decision.route) {
			process.env[ENV_SEARXNG] = own;
			process.env[ENV_OWN] = own;
		} else {
			if (process.env[ENV_SEARXNG] === own) delete process.env[ENV_SEARXNG];
			if (process.env[ENV_OWN] === own) delete process.env[ENV_OWN];
		}
		debugLog({ kind: "route", model: chatModel, ...decision });
	}

	/**
	 * Runs one search. Requests reaching the endpoint while another provider's
	 * model is selected (a call already in flight when the model changed) are
	 * refused, so pi-web-access falls back; `force` is for the explicit test command.
	 */
	async function search(request: SearchRequest, signal?: AbortSignal, force = false): Promise<SearchOutcome> {
		if (!modelSource) throw Object.assign(new Error("No pi session is active"), { status: 503 });
		if (!force && !decision.route) {
			throw Object.assign(new Error(`Anthropic web search is off: ${decision.reason}`), { status: 503 });
		}
		stats.lastQuery = request.query;
		debugLog({ kind: "search", request });
		try {
			const outcome = await runAnthropicSearch({
				source: modelSource,
				modelRef: parseModelRef(config.model),
				request,
				settings: config,
				...(signal ? { signal } : {}),
				onDebug: config.debug || process.env.PI_CLAUDE_WEB_SEARCH_DEBUG === "1" ? debugLog : undefined,
			});
			stats.searches++;
			stats.lastDurationMs = outcome.durationMs;
			stats.lastError = undefined;
			debugLog({
				kind: "outcome",
				queries: outcome.collected.queries,
				hits: outcome.collected.hits.length,
				errors: outcome.collected.errors,
				timedOut: outcome.timedOut,
				stopReason: outcome.stopReason,
				durationMs: outcome.durationMs,
			});
			return outcome;
		} catch (error) {
			stats.failures++;
			stats.lastError = error instanceof Error ? error.message : String(error);
			debugLog({ kind: "error", error: stats.lastError });
			throw error;
		}
	}

	async function start(ctx: ExtensionContext): Promise<void> {
		modelSource = ctx.modelRegistry as unknown as ModelSource;
		chatModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		if (server || starting) return starting;
		inactiveReason = undefined;
		warning = undefined;
		if (!config.enabled) {
			inactiveReason = `disabled in ${configPath}`;
			return;
		}

		const existing = process.env[ENV_SEARXNG];
		const inherited = existing !== undefined && existing === process.env[ENV_OWN];
		if (existing !== undefined && !inherited) {
			inactiveReason = `${ENV_SEARXNG} is already set to ${existing}; leaving the user's SearXNG in place`;
			return;
		}
		const facts = readWebAccessConfigFacts();
		if (facts.searxngBaseUrl) {
			inactiveReason = `searxngBaseUrl is set in ${facts.path}; leaving the user's SearXNG in place`;
			return;
		}
		if (facts.pinnedProvider) {
			warning = `web_search is pinned to "${facts.pinnedProvider}" in ${facts.path}; Anthropic search runs only for provider "auto" or "searxng"`;
		}

		starting = (async () => {
			server = await startShimServer(search, (error) => debugLog({ kind: "shim-error", error: String(error) }));
			savedEnv = { searxng: inherited ? existing : undefined, own: process.env[ENV_OWN] };
			// An inherited URL points at the parent pi's endpoint; it is replaced or withdrawn.
			if (inherited) {
				delete process.env[ENV_SEARXNG];
				delete process.env[ENV_OWN];
			}
			debugLog({ kind: "started", baseUrl: server.baseUrl, model: config.model });
			applyRoute();
		})().finally(() => {
			starting = undefined;
		});
		return starting;
	}

	async function stop(): Promise<void> {
		await starting?.catch(() => undefined);
		const current = server;
		server = undefined;
		if (!current) return;
		// Withdraw our URL (if advertised), then put back what was there at start.
		for (const [name, saved] of [
			[ENV_SEARXNG, savedEnv?.searxng],
			[ENV_OWN, savedEnv?.own],
		] as const) {
			if (process.env[name] === current.baseUrl) delete process.env[name];
			if (saved !== undefined && process.env[name] === undefined) process.env[name] = saved;
		}
		savedEnv = undefined;
		await current.close();
	}

	function statusLines(): string[] {
		const ref = parseModelRef(config.model);
		const model = modelSource?.find(ref.provider, ref.id);
		return [
			`Anthropic web search for pi-web-access: ${
				!server
					? `inactive${inactiveReason ? ` (${inactiveReason})` : ""}`
					: decision.route
						? "active"
						: `paused (${decision.reason}; web_search uses pi-web-access's other providers)`
			}`,
			`  endpoint: ${server ? `${server.baseUrl.replace(/\/[0-9a-f]{32}$/, "/<token>")}${decision.route ? " (SEARXNG_BASE_URL)" : " (not advertised)"}` : "-"}`,
			`  model: ${config.model}${model ? "" : " (not found in pi's model registry)"}`,
			`  max_uses: ${config.maxUses}, timeout: ${config.timeoutMs} ms, max_tokens: ${config.maxTokens}`,
			`  config: ${configPath}${configError ? ` (${configError})` : ""}`,
			`  searches: ${stats.searches} ok, ${stats.failures} failed${stats.lastDurationMs !== undefined ? `, last ${stats.lastDurationMs} ms` : ""}`,
			...(stats.lastError ? [`  last error: ${stats.lastError}`] : []),
			...(warning ? [`  warning: ${warning}`] : []),
		];
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			await start(ctx);
		} catch (error) {
			inactiveReason = `failed to start: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (ctx.hasUI) {
			if (warning) ctx.ui.notify(`claude-web-search: ${warning}`, "warning");
			if (inactiveReason && config.enabled) ctx.ui.notify(`claude-web-search: ${inactiveReason}`, "warning");
		}
	});

	// Restoring a session does not fire model_select; session_start reads ctx.model.
	pi.on("model_select", (event) => {
		chatModel = { provider: event.model.provider, id: event.model.id };
		applyRoute();
	});

	pi.on("session_shutdown", async () => {
		await stop();
	});

	pi.registerCommand("claude-web-search", {
		description: "Show Anthropic web search status, or run `test <query>` to try one search",
		handler: async (args, ctx) => {
			const [sub, ...rest] = (args ?? "").trim().split(/\s+/);
			if (sub === "reload") {
				await stop();
				reloadConfig();
				await start(ctx);
				ctx.ui.notify(statusLines().join("\n"), "info");
				return;
			}
			if (sub === "test") {
				const raw = rest.join(" ").trim();
				if (!raw) {
					ctx.ui.notify("Usage: /claude-web-search test <query>", "warning");
					return;
				}
				modelSource = ctx.modelRegistry as unknown as ModelSource;
				try {
					// An explicit test runs even while the current model is not an Anthropic one.
					const outcome = await search(parseSearxngQuery(raw), undefined, true);
					const reply = toSearxngReply(raw, outcome);
					const lines = [
						reply.answers[0] ?? "",
						"",
						`queries run: ${outcome.collected.queries.join(" | ") || "-"}; ${outcome.durationMs} ms`,
						...reply.results.map((result, index) => `${index + 1}. ${result.title} — ${result.url}`),
					];
					ctx.ui.notify(lines.join("\n"), "info");
				} catch (error) {
					ctx.ui.notify(`Anthropic web search failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			ctx.ui.notify(statusLines().join("\n"), "info");
		},
	});
}
