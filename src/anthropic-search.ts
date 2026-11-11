// Runs one search through Anthropic's server-side web_search tool.
//
// The request goes out through `modelRegistry.streamSimple()`, so it takes the
// same path as pi's own model calls: pi-ai's Anthropic transport adds the OAuth
// headers and betas, and pi-anthropic-auth adds the billing block. This module
// only adds what is specific to search: the server tool, the forced tool
// choice, and the side-query prompt that Claude Code uses for its WebSearch.

import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { SearchEventCollector, type CollectedSearch } from "./stream-events.ts";

export const SEARCH_SYSTEM_PROMPT =
	"You run a web search for another Claude model, which is waiting on the result and can search again. Search once, then reply with a brief summary of the results.";

export interface SearchRequest {
	query: string;
	allowedDomains: string[];
	blockedDomains: string[];
	/** SearXNG `time_range`: day, week, month or year. */
	timeRange?: string;
}

export interface SearchSettings {
	maxUses: number;
	maxTokens: number;
	timeoutMs: number;
}

export interface SearchOutcome {
	model: string;
	collected: CollectedSearch;
	/** The model's summary, or the text streamed before the deadline. */
	summary: string;
	timedOut: boolean;
	durationMs: number;
	stopReason?: string;
}

/** The slice of pi's ModelRegistry this module uses. */
export interface ModelSource {
	find(provider: string, modelId: string): Model<Api> | undefined;
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): {
		result(): Promise<AssistantMessage>;
	};
}

export class SearchError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "SearchError";
		this.status = status;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function buildServerTool(request: SearchRequest, settings: Pick<SearchSettings, "maxUses">): Record<string, unknown> {
	return {
		type: "web_search_20250305",
		name: "web_search",
		max_uses: settings.maxUses,
		// The API rejects both lists at once; pi-web-access filters the results
		// by both lists again, so the blocked list is only lost as a hint.
		...(request.allowedDomains.length > 0
			? { allowed_domains: request.allowedDomains }
			: request.blockedDomains.length > 0
				? { blocked_domains: request.blockedDomains }
				: {}),
	};
}

export function buildUserPrompt(request: SearchRequest): string {
	const recency = request.timeRange ? `\n\nPrefer results published within the past ${request.timeRange}.` : "";
	return `Perform a web search for the query: ${request.query}${recency}`;
}

/**
 * Adds the server tool to the payload pi-ai built.
 *
 * Forcing a tool is rejected while extended thinking is on, so the forced
 * choice is used only when the payload has thinking off; otherwise the model
 * is left to pick the tool itself, as Claude Code does in that case.
 */
export function addServerTool(payload: unknown, tool: Record<string, unknown>): unknown {
	if (!isRecord(payload)) return payload;
	const thinking = isRecord(payload.thinking) ? payload.thinking.type : undefined;
	const thinkingOn = thinking !== undefined && thinking !== "disabled";
	return {
		...payload,
		tools: [tool],
		tool_choice: thinkingOn ? { type: "auto" } : { type: "tool", name: "web_search" },
	};
}

export function assistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
}

export interface RunSearchOptions {
	source: ModelSource;
	modelRef: { provider: string; id: string };
	request: SearchRequest;
	settings: SearchSettings;
	signal?: AbortSignal;
	/** Debug hook: sees the final payload and request headers. */
	onDebug?: (entry: Record<string, unknown>) => void;
}

export async function runAnthropicSearch(options: RunSearchOptions): Promise<SearchOutcome> {
	const { source, modelRef, request, settings } = options;
	const model = source.find(modelRef.provider, modelRef.id);
	if (!model) throw new SearchError(`Model ${modelRef.provider}/${modelRef.id} is not available in pi`, 503);
	if (model.api !== "anthropic-messages") {
		throw new SearchError(`Model ${modelRef.provider}/${modelRef.id} does not use the Anthropic Messages API`, 503);
	}

	const started = Date.now();
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new Error("deadline")), settings.timeoutMs);
	timer.unref?.();
	const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;

	const collector = new SearchEventCollector();
	const tool = buildServerTool(request, settings);
	const context: Context = {
		systemPrompt: SEARCH_SYSTEM_PROMPT,
		messages: [{ role: "user", content: buildUserPrompt(request), timestamp: Date.now() }],
	};

	const debug = options.onDebug;
	const streamOptions: SimpleStreamOptions = {
		signal,
		maxTokens: settings.maxTokens,
		// No `reasoning`: pi-ai then sends `thinking: {type: "disabled"}`, which the
		// forced tool choice needs.
		onPayload: (payload) => {
			const next = addServerTool(payload, tool);
			debug?.({ kind: "payload", payload: next });
			return next;
		},
		onProviderStreamEvent: (data) => collector.push(data),
		...(debug
			? {
					fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
						const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
						const shown: Record<string, string> = {};
						headers.forEach((value, name) => {
							shown[name] = /authorization|api-key|cookie/i.test(name) ? `<redacted ${value.length} chars>` : value;
						});
						// The body as sent, after every onPayload (pi-anthropic-auth shapes last).
						let sent: Record<string, unknown> | undefined;
						try {
							const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
							if (body) {
								sent = {
									system: Array.isArray(body.system)
										? body.system.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text.slice(0, 160) : block))
										: body.system,
									tools: body.tools,
									tool_choice: body.tool_choice,
									thinking: body.thinking,
								};
							}
						} catch {
							// Not JSON; nothing to show.
						}
						debug({ kind: "request", url: String(input instanceof Request ? input.url : input), headers: shown, sent });
						const response = await fetch(input, init);
						debug({ kind: "response", status: response.status, requestId: response.headers.get("request-id") });
						return response;
					}) as typeof fetch,
				}
			: {}),
	};

	let message: AssistantMessage | undefined;
	try {
		message = await source.streamSimple(model, context, streamOptions).result();
	} finally {
		clearTimeout(timer);
	}

	const collected = collector.snapshot();
	const timedOut = deadline.signal.aborted && !(options.signal?.aborted ?? false);
	if (options.signal?.aborted) throw new SearchError("Search cancelled", 499);

	const stopReason = message?.stopReason;
	if (stopReason === "error" && collected.hits.length === 0) {
		throw new SearchError(`Anthropic web search failed: ${message?.errorMessage ?? "unknown error"}`, 502);
	}
	if (timedOut && collected.hits.length === 0) {
		throw new SearchError(`Anthropic web search gave no results within ${settings.timeoutMs} ms`, 504);
	}
	if (collected.hits.length === 0 && collected.errors.length > 0) {
		throw new SearchError(`Anthropic web search error: ${collected.errors.join(", ")}`, 502);
	}

	const summary = assistantText(message) || collected.text.trim();
	return {
		model: `${modelRef.provider}/${modelRef.id}`,
		collected,
		summary,
		timedOut,
		durationMs: Date.now() - started,
		...(stopReason ? { stopReason } : {}),
	};
}
