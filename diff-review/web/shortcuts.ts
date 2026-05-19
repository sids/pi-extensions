type ModifierEvent = {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
};

function normalizeKey(key: string): string {
	return key.length === 1 ? key.toLowerCase() : key;
}

function readNavigatorPlatform(): string {
	if (typeof navigator === "undefined") {
		return "";
	}
	const navigatorWithUserAgentData = navigator as Navigator & {
		userAgentData?: {
			platform?: string;
		};
	};
	return navigatorWithUserAgentData.userAgentData?.platform ?? navigator.platform ?? "";
}

export function isApplePlatform(platform: string = readNavigatorPlatform()): boolean {
	return /mac|iphone|ipad|ipod/i.test(platform);
}

export function getCommentSendHint(platform: string = readNavigatorPlatform()): string {
	return isApplePlatform(platform) ? "⌘↵" : "Ctrl+↵";
}

export function getSendAllHint(platform: string = readNavigatorPlatform()): string {
	return isApplePlatform(platform) ? "⌘⌥↵" : "Ctrl+Alt+↵";
}

export function isCommentSendShortcut(event: ModifierEvent, platform: string = readNavigatorPlatform()): boolean {
	if (event.key !== "Enter" || event.shiftKey || event.altKey) {
		return false;
	}
	if (isApplePlatform(platform)) {
		return event.metaKey;
	}
	return event.ctrlKey;
}

export function isSendAllShortcut(event: ModifierEvent, platform: string = readNavigatorPlatform()): boolean {
	if (event.key !== "Enter" || event.shiftKey || !event.altKey) {
		return false;
	}
	if (isApplePlatform(platform)) {
		return event.metaKey;
	}
	return event.ctrlKey;
}

export function isFocusSearchShortcut(event: ModifierEvent): boolean {
	return normalizeKey(event.key) === "t" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

export function isRefreshShortcut(event: ModifierEvent): boolean {
	return normalizeKey(event.key) === "r" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}
