import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchEventCollector } from "../src/stream-events.ts";

// Event shapes as the Anthropic SDK yields them for a web_search_20250305 call.
const events = [
	{ type: "message_start", message: { id: "msg_1" } },
	{ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
	{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query": "node 24 rel' } },
	{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'ease date"}' } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "content_block_start",
		index: 1,
		content_block: {
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_1",
			content: [
				{ type: "web_search_result", title: "Node.js 24", url: "https://nodejs.org/en/blog/release/v24.0.0", encrypted_content: "x", page_age: "May 6, 2025" },
				{ type: "web_search_result", title: "Release schedule", url: "https://github.com/nodejs/release", encrypted_content: "y" },
			],
		},
	},
	{ type: "content_block_stop", index: 1 },
	{ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Node.js 24 was released " } },
	{ type: "content_block_stop", index: 2 },
	{ type: "content_block_start", index: 3, content_block: { type: "text", text: "", citations: [] } },
	{
		type: "content_block_delta",
		index: 3,
		delta: {
			type: "citations_delta",
			citation: { type: "web_search_result_location", url: "https://nodejs.org/en/blog/release/v24.0.0", title: "Node.js 24", cited_text: "Node.js 24 is released on May 6, 2025." },
		},
	},
	{ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "on May 6, 2025." } },
	{ type: "content_block_stop", index: 3 },
];

test("collects queries, hits, citations and text", () => {
	const collector = new SearchEventCollector();
	for (const event of events) collector.push(event);
	const snapshot = collector.snapshot();
	assert.deepEqual(snapshot.queries, ["node 24 release date"]);
	assert.equal(snapshot.hits.length, 2);
	assert.deepEqual(snapshot.hits[0], {
		title: "Node.js 24",
		url: "https://nodejs.org/en/blog/release/v24.0.0",
		pageAge: "May 6, 2025",
		citedText: ["Node.js 24 is released on May 6, 2025."],
	});
	assert.equal(snapshot.text, "Node.js 24 was released on May 6, 2025.");
	assert.deepEqual(snapshot.errors, []);
});

test("records web_search_tool_result_error", () => {
	const collector = new SearchEventCollector();
	collector.push({
		type: "content_block_start",
		index: 1,
		content_block: { type: "web_search_tool_result", tool_use_id: "x", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
	});
	assert.deepEqual(collector.snapshot().errors, ["max_uses_exceeded"]);
});

test("ignores unrelated and malformed events", () => {
	const collector = new SearchEventCollector();
	collector.push(null);
	collector.push("ping");
	collector.push({ type: "message_delta", delta: { stop_reason: "end_turn" } });
	assert.deepEqual(collector.snapshot(), { queries: [], hits: [], errors: [], text: "" });
});
