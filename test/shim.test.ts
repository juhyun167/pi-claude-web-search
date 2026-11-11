import assert from "node:assert/strict";
import { test } from "node:test";
import { addServerTool, buildServerTool, buildUserPrompt, SearchError, type SearchOutcome } from "../src/anthropic-search.ts";
import { startShimServer, toSearxngReply } from "../src/shim-server.ts";

const outcome: SearchOutcome = {
	model: "anthropic/claude-haiku-5-5",
	summary: "Node.js 24 was released on May 6, 2025.",
	timedOut: false,
	durationMs: 1234,
	collected: {
		queries: ["node 24 release date"],
		errors: [],
		text: "",
		hits: [
			{ title: "Node.js 24", url: "https://nodejs.org/a", pageAge: "May 6, 2025", citedText: ["Released May 6."] },
			{ title: "Schedule", url: "https://github.com/nodejs/release", citedText: [] },
		],
	},
};

test("server tool prefers allowed_domains and never sends both lists", () => {
	assert.deepEqual(buildServerTool({ query: "q", allowedDomains: ["a.com"], blockedDomains: ["b.com"] }, { maxUses: 1 }), {
		type: "web_search_20250305",
		name: "web_search",
		max_uses: 1,
		allowed_domains: ["a.com"],
	});
	assert.deepEqual(buildServerTool({ query: "q", allowedDomains: [], blockedDomains: ["b.com"] }, { maxUses: 2 }).blocked_domains, ["b.com"]);
});

test("user prompt matches Claude Code's side query and adds recency", () => {
	assert.equal(buildUserPrompt({ query: "x", allowedDomains: [], blockedDomains: [] }), "Perform a web search for the query: x");
	assert.match(buildUserPrompt({ query: "x", allowedDomains: [], blockedDomains: [], timeRange: "week" }), /past week/);
});

test("forced tool choice only when thinking is off", () => {
	const tool = { type: "web_search_20250305", name: "web_search" };
	const off = addServerTool({ model: "m", thinking: { type: "disabled" } }, tool) as Record<string, unknown>;
	assert.deepEqual(off.tool_choice, { type: "tool", name: "web_search" });
	assert.deepEqual(off.tools, [tool]);
	const on = addServerTool({ model: "m", thinking: { type: "adaptive" } }, tool) as Record<string, unknown>;
	assert.deepEqual(on.tool_choice, { type: "auto" });
});

test("SearXNG reply carries the summary as an answer and hits as results", () => {
	const reply = toSearxngReply("node 24", outcome);
	assert.match(reply.answers[0]!, /^\[Anthropic web search via anthropic\/claude-haiku-5-5\]\nNode\.js 24/);
	assert.deepEqual(reply.results[0], { title: "Node.js 24", url: "https://nodejs.org/a", content: '"Released May 6."\nPage age: May 6, 2025' });
	assert.equal(reply.results[1]!.content, "");
});

test("cited sources are ordered first", () => {
	const reordered: SearchOutcome = {
		...outcome,
		collected: { ...outcome.collected, hits: [...outcome.collected.hits].reverse() },
	};
	assert.deepEqual(toSearxngReply("q", reordered).results.map((result) => result.url), [
		"https://nodejs.org/a",
		"https://github.com/nodejs/release",
	]);
});

test("shim serves /<token>/search, rejects other paths, and maps errors to HTTP status", async () => {
	const seen: unknown[] = [];
	const shim = await startShimServer(async (request) => {
		seen.push(request);
		if (request.query === "fail") throw new SearchError("boom", 502);
		return outcome;
	});
	try {
		const ok = await fetch(`${shim.baseUrl}/search?q=${encodeURIComponent("node 24 site:nodejs.org")}&format=json&time_range=month`);
		assert.equal(ok.status, 200);
		const body = (await ok.json()) as { results: unknown[]; answers: string[] };
		assert.equal(body.results.length, 2);
		assert.deepEqual(seen[0], { query: "node 24", allowedDomains: ["nodejs.org"], blockedDomains: [], timeRange: "month" });

		const failed = await fetch(`${shim.baseUrl}/search?q=fail&format=json`);
		assert.equal(failed.status, 502);
		assert.match(((await failed.json()) as { error: string }).error, /boom/);

		const wrongToken = await fetch(`${shim.baseUrl.replace(/\/[0-9a-f]+$/, "/nope")}/search?q=x`);
		assert.equal(wrongToken.status, 404);
	} finally {
		await shim.close();
	}
});
