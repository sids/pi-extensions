export const DEFAULT_SINGLE_QUERY_COUNT = 10;
export const DEFAULT_MULTI_QUERY_COUNT = 5;
export const MAX_COUNT = 20;

export type WebSearchQueryInput = {
	query?: string;
	queries?: string[];
	count?: number;
};

export type WebSearchErrorPayload = {
	queries: string[];
	message: string;
};

const ERROR_MARKER = "__WEB_SEARCH_ERROR__";

export function resolveQueries(params: WebSearchQueryInput): string[] {
	const queries: string[] = [];
	if (params.query?.trim()) {
		queries.push(params.query.trim());
	}
	if (params.queries?.length) {
		for (const query of params.queries) {
			if (query.trim()) {
				queries.push(query.trim());
			}
		}
	}
	return queries;
}

export function resolveCount(params: WebSearchQueryInput, queryCount: number): number {
	const defaultCount = queryCount > 1 ? DEFAULT_MULTI_QUERY_COUNT : DEFAULT_SINGLE_QUERY_COUNT;
	const requested = params.count ?? defaultCount;
	return Math.max(1, Math.min(requested, MAX_COUNT));
}

export function buildErrorPayload(queries: string[], message: string): string {
	return `${ERROR_MARKER}${JSON.stringify({ queries, message } as WebSearchErrorPayload)}`;
}

export function parseErrorPayload(text: string): WebSearchErrorPayload | null {
	if (!text.startsWith(ERROR_MARKER)) {
		return null;
	}
	const raw = text.slice(ERROR_MARKER.length).trim();
	if (!raw) {
		return null;
	}
	try {
		return JSON.parse(raw) as WebSearchErrorPayload;
	} catch {
		return null;
	}
}
