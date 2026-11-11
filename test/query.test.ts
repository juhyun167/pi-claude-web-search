import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSearxngQuery } from "../src/query.ts";

test("plain query passes through", () => {
	assert.deepEqual(parseSearxngQuery("rust async programming"), {
		query: "rust async programming",
		allowedDomains: [],
		blockedDomains: [],
	});
});

test("single site: token becomes an allowed domain", () => {
	assert.deepEqual(parseSearxngQuery("tokio runtime site:docs.rs"), {
		query: "tokio runtime",
		allowedDomains: ["docs.rs"],
		blockedDomains: [],
	});
});

test("OR-joined site: tokens and -site: tokens are lifted out (pi-web-access buildSearXNGQuery shape)", () => {
	assert.deepEqual(parseSearxngQuery("react hooks site:react.dev OR site:github.com -site:medium.com"), {
		query: "react hooks",
		allowedDomains: ["react.dev", "github.com"],
		blockedDomains: ["medium.com"],
	});
});

test("an OR that is part of the query is kept", () => {
	assert.equal(parseSearxngQuery("cats OR dogs").query, "cats OR dogs");
});

test("a malformed site: token stays in the query", () => {
	assert.equal(parseSearxngQuery("x site:").query, "x site:");
});
