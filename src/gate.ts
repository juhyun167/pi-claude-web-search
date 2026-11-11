// Decides whether web_search should go to Anthropic for the model in use.
//
// The search runs on the Claude subscription, so it is offered only while the
// conversation itself runs on that provider. With another provider's model
// selected, SEARXNG_BASE_URL is withdrawn and pi-web-access picks its next
// provider as if this extension were not installed.

export interface ModelIdentity {
	provider: string;
	id: string;
}

export type RouteDecision = { route: true } | { route: false; reason: string };

export function decideRoute(chatModel: ModelIdentity | undefined, searchProvider: string): RouteDecision {
	if (!chatModel) return { route: false, reason: "no model is selected" };
	if (chatModel.provider !== searchProvider) {
		return { route: false, reason: `the current model ${chatModel.provider}/${chatModel.id} is not from provider ${searchProvider}` };
	}
	return { route: true };
}
