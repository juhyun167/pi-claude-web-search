// A SearXNG-compatible `/search` endpoint on 127.0.0.1.
//
// pi-web-access's SearXNG provider sends
//   GET <base>/search?q=<query>&format=json[&time_range=day|week|month|year]
// and reads `answers[]` and `results[{title,url,content}]` from the JSON reply.
// Any non-2xx reply makes pi-web-access fall through to its next provider.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { SearchOutcome, SearchRequest } from "./anthropic-search.ts";
import { parseSearxngQuery } from "./query.ts";

export type SearchHandler = (request: SearchRequest, signal: AbortSignal) => Promise<SearchOutcome>;

export interface SearxngResult {
	title: string;
	url: string;
	content: string;
}

export interface SearxngReply {
	query: string;
	answers: string[];
	results: SearxngResult[];
}

const TIME_RANGES = new Set(["day", "week", "month", "year"]);
const MAX_CITED_CHARS = 600;

export function toSearxngReply(query: string, outcome: SearchOutcome): SearxngReply {
	const label = `[Anthropic web search via ${outcome.model}${outcome.timedOut ? ", summary cut off by the deadline" : ""}]`;
	const answers = outcome.summary ? [`${label}\n${outcome.summary}`] : [`${label} (no summary)`];
	// pi-web-access keeps only the first `numResults` results, so the sources the
	// summary actually cites go first; the sort is stable otherwise.
	const hits = [...outcome.collected.hits].sort(
		(a, b) => Number(b.citedText.length > 0) - Number(a.citedText.length > 0),
	);
	const results = hits.map((hit) => {
		const parts: string[] = [];
		if (hit.citedText.length > 0) {
			const cited = hit.citedText.map((text) => `"${text}"`).join(" … ");
			parts.push(cited.length > MAX_CITED_CHARS ? `${cited.slice(0, MAX_CITED_CHARS - 1)}…` : cited);
		}
		if (hit.pageAge) parts.push(`Page age: ${hit.pageAge}`);
		return { title: hit.title, url: hit.url, content: parts.join("\n") };
	});
	return { query, answers, results };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	if (res.writableEnded || res.destroyed) return;
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
	res.end(text);
}

export interface ShimServer {
	/** Base URL to hand to pi-web-access, e.g. http://127.0.0.1:53211/<token>. */
	baseUrl: string;
	close(): Promise<void>;
}

export async function startShimServer(handler: SearchHandler, onError?: (error: unknown) => void): Promise<ShimServer> {
	const token = randomBytes(16).toString("hex");
	const searchPath = `/${token}/search`;

	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		void handle(req, res).catch((error) => {
			onError?.(error);
			sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method !== "GET" || url.pathname !== searchPath) {
			sendJson(res, 404, { error: "not found" });
			return;
		}
		const raw = url.searchParams.get("q")?.trim() ?? "";
		const parsed = parseSearxngQuery(raw);
		if (!parsed.query) {
			sendJson(res, 400, { error: "missing query" });
			return;
		}
		const timeRange = url.searchParams.get("time_range") ?? undefined;

		// pi-web-access aborts its fetch on timeout or cancel; stop the side query too.
		const aborter = new AbortController();
		res.on("close", () => {
			if (!res.writableFinished) aborter.abort(new Error("client closed"));
		});

		try {
			const outcome = await handler(
				{ ...parsed, ...(timeRange && TIME_RANGES.has(timeRange) ? { timeRange } : {}) },
				aborter.signal,
			);
			sendJson(res, 200, toSearxngReply(raw, outcome));
		} catch (error) {
			onError?.(error);
			const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 502;
			sendJson(res, status >= 400 && status < 600 ? status : 502, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	// The endpoint must never keep pi alive on its own.
	server.unref();

	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/${token}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}
