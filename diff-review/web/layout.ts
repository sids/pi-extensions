export function getAppLayoutClassName(sidebarCollapsed: boolean, sidebarPopoverOpen: boolean): string {
	const classNames = ["app-layout"];
	if (sidebarCollapsed) {
		classNames.push("app-layout--sidebar-collapsed");
	}
	if (sidebarPopoverOpen) {
		classNames.push("app-layout--sidebar-popover-open");
	}
	return classNames.join(" ");
}
