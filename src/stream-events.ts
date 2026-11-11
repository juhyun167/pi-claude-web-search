// Collects web search results from Anthropic's raw stream events.
//
// pi-ai's Anthropic stream parser keeps text, thinking and tool_use blocks and
// skips every other block type, so `server_tool_use` and
// `web_search_tool_result` never reach the final AssistantMessage. pi-ai does
// hand each parsed event to `onProviderStreamEvent` before normalizing it, and
// this collector reads the search blocks from there.

export interface SearchHit {
	title: string;
	url: string;
	pageAge?: string;
	citedText: string[];
}

export interface CollectedSearch {
	/** Queries the server-side tool actually ran. */
	queries: string[];
	hits: SearchHit[];
	/** `error_code` values from web_search_tool_result_error blocks. */
	errors: string[];
	/** Text the model streamed so far; used when the deadline cuts the reply off. */
	text: string;
}

type RawEvent = {
	type?: string;
	index?: number;
	content_block?: Record<string, unknown>;
	delta?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class SearchEventCollector {
	readonly #hits = new Map<string, SearchHit>();
	readonly #queries: string[] = [];
	readonly #errors: string[] = [];
	readonly #toolInput = new Map<number, string>();
	#text = "";

	push(data: unknown): void {
		if (!isRecord(data)) return;
		const event = data as RawEvent;
		if (event.type === "content_block_start" && isRecord(event.content_block)) {
			this.#onBlockStart(event.index ?? -1, event.content_block);
		} else if (event.type === "content_block_delta" && isRecord(event.delta)) {
			this.#onDelta(event.index ?? -1, event.delta);
		} else if (event.type === "content_block_stop") {
			this.#onBlockStop(event.index ?? -1);
		}
	}

	#onBlockStart(index: number, block: Record<string, unknown>): void {
		if (block.type === "server_tool_use") {
			const input = isRecord(block.input) ? block.input : {};
			if (typeof input.query === "string" && input.query) this.#queries.push(input.query);
			else this.#toolInput.set(index, "");
			return;
		}
		if (block.type === "web_search_tool_result") {
			const content = block.content;
			if (Array.isArray(content)) {
				for (const item of content) {
					if (!isRecord(item) || typeof item.url !== "string" || !item.url) continue;
					this.#hit(item.url, typeof item.title === "string" ? item.title : "", typeof item.page_age === "string" ? item.page_age : undefined);
				}
			} else if (isRecord(content) && typeof content.error_code === "string") {
				this.#errors.push(content.error_code);
			}
			return;
		}
		if (block.type === "text") {
			if (typeof block.text === "string") this.#text += block.text;
			if (Array.isArray(block.citations)) for (const citation of block.citations) this.#cite(citation);
		}
	}

	#onDelta(index: number, delta: Record<string, unknown>): void {
		if (delta.type === "text_delta" && typeof delta.text === "string") {
			this.#text += delta.text;
		} else if (delta.type === "citations_delta") {
			this.#cite(delta.citation);
		} else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && this.#toolInput.has(index)) {
			this.#toolInput.set(index, this.#toolInput.get(index)! + delta.partial_json);
		}
	}

	#onBlockStop(index: number): void {
		const json = this.#toolInput.get(index);
		if (json === undefined) return;
		this.#toolInput.delete(index);
		try {
			const input = JSON.parse(json) as unknown;
			if (isRecord(input) && typeof input.query === "string" && input.query) this.#queries.push(input.query);
		} catch {
			// A partial input (cut off by the deadline) carries no usable query.
		}
	}

	#hit(url: string, title: string, pageAge?: string): SearchHit {
		let hit = this.#hits.get(url);
		if (!hit) {
			hit = { title: title || url, url, citedText: [] };
			if (pageAge) hit.pageAge = pageAge;
			this.#hits.set(url, hit);
		} else if (!hit.title || hit.title === url) {
			if (title) hit.title = title;
		}
		return hit;
	}

	#cite(citation: unknown): void {
		if (!isRecord(citation) || typeof citation.url !== "string") return;
		const hit = this.#hit(citation.url, typeof citation.title === "string" ? citation.title : "");
		const cited = typeof citation.cited_text === "string" ? citation.cited_text.trim() : "";
		if (cited && !hit.citedText.includes(cited)) hit.citedText.push(cited);
	}

	snapshot(): CollectedSearch {
		return {
			queries: [...this.#queries],
			hits: [...this.#hits.values()].map((hit) => ({ ...hit, citedText: [...hit.citedText] })),
			errors: [...this.#errors],
			text: this.#text,
		};
	}
}
