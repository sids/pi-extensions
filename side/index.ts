import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { createParentSessionTools, ParentSessionView } from "./parent-session";
import { createSideSession, type SideSessionController, type SideThinkingLevel } from "./side-session";
import { SideChatComponent, SIDE_OVERLAY_OPTIONS } from "./side-tui";
import {
	captureParentSessionSnapshot,
	summarizeParentSnapshot,
	type ParentSessionSnapshot,
} from "./summary";

interface ActiveSideRun {
	parentSessionId: string;
	parentSessionFile?: string;
	parentView?: ParentSessionView;
	controller?: SideSessionController;
	component?: SideChatComponent;
	overlayHandle?: OverlayHandle;
	closeOverlay?: () => void;
	startupAbortController: AbortController;
	hidden: boolean;
	teardownPromise?: Promise<void>;
}

type SideDependencies = {
	summarize: typeof summarizeParentSnapshot;
	createSession: typeof createSideSession;
};

const DEFAULT_DEPENDENCIES: SideDependencies = {
	summarize: summarizeParentSnapshot,
	createSession: createSideSession,
};

export function registerSideExtension(
	pi: ExtensionAPI,
	dependencies: SideDependencies = DEFAULT_DEPENDENCIES,
): void {
	let active: ActiveSideRun | undefined;

	const teardown = (run: ActiveSideRun | undefined): Promise<void> => {
		if (!run) {
			return Promise.resolve();
		}
		if (run.teardownPromise) {
			return run.teardownPromise;
		}
		run.teardownPromise = (async () => {
			run.startupAbortController.abort();
			run.parentView?.dispose();
			run.closeOverlay?.();
			run.overlayHandle?.hide();
			run.component?.dispose();
			await run.controller?.dispose();
			if (active === run) {
				active = undefined;
			}
		})();
		return run.teardownPromise;
	};

	const setVisible = (run: ActiveSideRun, visible: boolean): void => {
		if (!run.overlayHandle || run.teardownPromise) {
			return;
		}
		run.hidden = !visible;
		run.overlayHandle.setHidden(!visible);
		if (visible) {
			run.overlayHandle.focus();
		}
	};

	const toggle = async (ctx: ExtensionContext): Promise<void> => {
		if (active) {
			if (!active.overlayHandle) {
				ctx.ui.notify("Side chat is still starting.", "info");
				return;
			}
			setVisible(active, active.hidden);
			return;
		}
		await start("", ctx);
	};

	const start = async (args: string, ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) {
				ctx.ui.notify("/side requires TUI mode.", "error");
			}
			return;
		}
		if (!ctx.model) {
			ctx.ui.notify("Select a model before opening /side.", "error");
			return;
		}
		if (active) {
			setVisible(active, true);
			ctx.ui.notify("A side chat is already open.", "info");
			return;
		}

		const snapshot = captureParentSessionSnapshot(ctx, pi.getThinkingLevel());
		const run: ActiveSideRun = {
			parentSessionId: snapshot.sessionId,
			parentSessionFile: snapshot.sessionFile,
			startupAbortController: new AbortController(),
			hidden: false,
		};
		active = run;

		try {
			const parentView = new ParentSessionView(pi, ctx, snapshot);
			run.parentView = parentView;
			const parentTools = createParentSessionTools(parentView);
			const controller = await dependencies.createSession({
				ctx,
				snapshot,
				parentView,
				parentTools,
				mainThinkingLevel: snapshot.thinkingLevel as SideThinkingLevel,
			});
			if (active !== run || run.teardownPromise) {
				await controller.dispose();
				return;
			}
			run.controller = controller;

			const overlayPromise = ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => {
					run.closeOverlay = () => done(undefined);
					const component = new SideChatComponent(
						tui,
						theme,
						keybindings,
						controller,
						parentView,
						ctx.cwd,
						() => run.closeOverlay?.(),
						async () => {
							const models = await controller.getAvailableModels();
							if (models.length === 0) {
								controller.state.statusMessage = "No authenticated models are available";
								return;
							}
							const labels = models.map((model) => `${model.provider}/${model.id}`);
							const selected = await ctx.ui.select("Side model", labels);
							if (!selected) {
								return;
							}
							const index = labels.indexOf(selected);
							if (index >= 0) {
								await controller.setModel(models[index]);
							}
						},
						() => setVisible(run, false),
						args.trim(),
					);
					run.component = component;
					return component as Component;
				},
				{
					overlay: true,
					overlayOptions: SIDE_OVERLAY_OPTIONS,
					onHandle: (handle) => {
						run.overlayHandle = handle;
					},
				},
			);
			void overlayPromise
				.catch((error) => {
					ctx.ui.notify(
						`Side chat closed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				})
				.finally(() => teardown(run));

			void dependencies
				.summarize(ctx, snapshot, { signal: run.startupAbortController.signal })
				.then((summary) => controller.installParentSummary(summary))
				.catch(async (error) => {
					if (run.startupAbortController.signal.aborted || run.teardownPromise) {
						return;
					}
					ctx.ui.notify(
						`Could not summarize the main chat: ${error instanceof Error ? error.message : String(error)}. Using live-session tools only.`,
						"warning",
					);
					await controller.installParentSummary(null);
				});
		} catch (error) {
			ctx.ui.notify(
				`Could not start side chat: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			await teardown(run);
		}
	};

	pi.registerCommand("side", {
		description: "Open an ephemeral read-only side chat",
		handler: (args, ctx) => start(args, ctx),
	});
	pi.registerShortcut("ctrl+shift+s", {
		description: "Open or toggle the side chat",
		handler: (ctx) => toggle(ctx),
	});

	pi.on("session_shutdown", async () => {
		await teardown(active);
	});
	pi.on("session_start", async () => {
		if (active) {
			await teardown(active);
		}
	});
}

export default function sideExtension(pi: ExtensionAPI): void {
	registerSideExtension(pi);
}
