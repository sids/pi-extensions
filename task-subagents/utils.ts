export function resolveSubagentConcurrency(value: number | undefined): number | null {
	const concurrency = value ?? 2;
	if (!Number.isFinite(concurrency) || !Number.isInteger(concurrency)) {
		return null;
	}
	if (concurrency < 1 || concurrency > 4) {
		return null;
	}
	return concurrency;
}
