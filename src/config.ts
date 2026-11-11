import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeWebSearchConfig {
	enabled: boolean;
	/** `provider/id` or a bare Anthropic model id. */
	model: string;
	/** `max_uses` for the server tool. */
	maxUses: number;
	/** Deadline for one search, below pi-web-access's 30 s SearXNG timeout. */
	timeoutMs: number;
	/** `max_tokens` for the side query's reply. */
	maxTokens: number;
	/** Append request payloads and headers (credentials redacted) to claude-web-search.log. */
	debug: boolean;
}

export const DEFAULT_CONFIG: ClaudeWebSearchConfig = {
	enabled: true,
	model: "anthropic/claude-haiku-5-5",
	maxUses: 1,
	timeoutMs: 25_000,
	maxTokens: 4_096,
	debug: false,
};

export const CONFIG_FILE_NAME = "claude-web-search.json";

function positiveInt(value: unknown, fallback: number, max: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

export function loadConfig(agentDir: string): { config: ClaudeWebSearchConfig; path: string; error?: string } {
	const path = join(agentDir, CONFIG_FILE_NAME);
	if (!existsSync(path)) return { config: { ...DEFAULT_CONFIG }, path };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		return { config: { ...DEFAULT_CONFIG }, path, error: `Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}` };
	}
	const input = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	return {
		path,
		config: {
			enabled: input.enabled !== false,
			model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : DEFAULT_CONFIG.model,
			maxUses: positiveInt(input.maxUses, DEFAULT_CONFIG.maxUses, 10),
			timeoutMs: positiveInt(input.timeoutMs, DEFAULT_CONFIG.timeoutMs, 29_000),
			maxTokens: positiveInt(input.maxTokens, DEFAULT_CONFIG.maxTokens, 32_000),
			debug: input.debug === true,
		},
	};
}

export function parseModelRef(ref: string): { provider: string; id: string } {
	const slash = ref.indexOf("/");
	return slash > 0 ? { provider: ref.slice(0, slash), id: ref.slice(slash + 1) } : { provider: "anthropic", id: ref };
}

/**
 * Files pi-web-access may read its config from (utils.ts, getWebSearchConfigDir).
 * Returns the first existing one.
 */
export function findWebAccessConfig(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const candidates: string[] = [];
	if (env.PI_CODING_AGENT_DIR) candidates.push(join(env.PI_CODING_AGENT_DIR, "web-search.json"));
	if (env.XDG_CONFIG_HOME) candidates.push(join(env.XDG_CONFIG_HOME, "pi", "web-search.json"));
	candidates.push(join(homedir(), ".pi", "agent", "web-search.json"), join(homedir(), ".pi", "web-search.json"));
	return candidates.find((candidate) => existsSync(candidate));
}

export interface WebAccessConfigFacts {
	path?: string;
	/** A real SearXNG endpoint the user configured; the shim must not shadow it. */
	searxngBaseUrl?: string;
	/** The default provider when it is pinned to something the shim is never asked through. */
	pinnedProvider?: string;
}

export function readWebAccessConfigFacts(env: NodeJS.ProcessEnv = process.env): WebAccessConfigFacts {
	const path = findWebAccessConfig(env);
	if (!path) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const facts: WebAccessConfigFacts = { path };
		if (typeof raw.searxngBaseUrl === "string" && raw.searxngBaseUrl.trim()) facts.searxngBaseUrl = raw.searxngBaseUrl.trim();
		const provider = raw.searchProvider ?? raw.provider;
		const names = Array.isArray(provider) ? provider : typeof provider === "string" ? provider.split(",") : [];
		const normalized = names.map((name) => String(name).trim().toLowerCase()).filter(Boolean);
		if (normalized.length > 0 && !normalized.includes("auto") && !normalized.includes("searxng")) {
			facts.pinnedProvider = normalized.join(",");
		}
		return facts;
	} catch {
		return { path };
	}
}
