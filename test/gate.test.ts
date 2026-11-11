import assert from "node:assert/strict";
import { test } from "node:test";
import { decideRoute } from "../src/gate.ts";

test("routes while an Anthropic model is in use", () => {
	assert.deepEqual(decideRoute({ provider: "anthropic", id: "claude-opus-5-5" }, "anthropic"), { route: true });
});

test("does not route for another provider's model, even a Claude one served elsewhere", () => {
	const openai = decideRoute({ provider: "openai-codex", id: "gpt-5.3-codex" }, "anthropic");
	assert.equal(openai.route, false);
	assert.match((openai as { reason: string }).reason, /openai-codex\/gpt-5\.3-codex is not from provider anthropic/);
	assert.equal(decideRoute({ provider: "openrouter", id: "anthropic/claude-sonnet-5" }, "anthropic").route, false);
});

test("does not route without a model", () => {
	assert.equal(decideRoute(undefined, "anthropic").route, false);
});
