// Turns the SearXNG query string pi-web-access builds back into a plain query
// plus domain filters.
//
// pi-web-access (searxng.ts, buildSearXNGQuery) folds `domainFilter` into the
// query as `site:a`, `site:a OR site:b` and `-site:c` tokens. Anthropic's
// web_search tool takes the same filters as `allowed_domains` /
// `blocked_domains`, so the tokens are lifted out instead of being sent as text.

export interface ParsedQuery {
	query: string;
	allowedDomains: string[];
	blockedDomains: string[];
}

const SITE_TOKEN = /^(-?)site:(.+)$/i;

function cleanDomain(raw: string): string | undefined {
	const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
	return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(domain) ? domain : undefined;
}

export function parseSearxngQuery(raw: string): ParsedQuery {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	const kinds = tokens.map((token) => {
		const match = SITE_TOKEN.exec(token);
		if (!match) return "text" as const;
		return match[1] === "-" ? ("blocked" as const) : ("allowed" as const);
	});

	const allowed: string[] = [];
	const blocked: string[] = [];
	const kept: string[] = [];
	tokens.forEach((token, index) => {
		const kind = kinds[index];
		if (kind === "text") {
			// "OR" between two site: tokens belongs to the filter, not to the query.
			if (token === "OR" && kinds[index - 1] === "allowed" && kinds[index + 1] === "allowed") return;
			kept.push(token);
			return;
		}
		const domain = cleanDomain(SITE_TOKEN.exec(token)![2]!);
		if (!domain) {
			kept.push(token);
			return;
		}
		const target = kind === "allowed" ? allowed : blocked;
		if (!target.includes(domain)) target.push(domain);
	});

	return { query: kept.join(" "), allowedDomains: allowed, blockedDomains: blocked };
}
