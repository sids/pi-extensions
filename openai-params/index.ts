import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isTuiMode } from "@siddr/pi-shared-qna/extension-mode";
import { isProjectTrusted } from "@siddr/pi-shared-qna/project-trust";
import { OpenAIParamsScreen } from "./settings-screen";
import {
	applyConfiguredParams,
	getCurrentModelKey,
	OPENAI_PARAMS_COMMAND,
	OPENAI_PARAMS_EVENT_CHANNEL,
	persistConfig,
	PROMPT_CACHE_RETENTION_EVENT_CHANNEL,
	resolveConfig,
	toOpenAIParamsEventPayload,
	toPromptCacheRetentionEventPayload,
	type OpenAIParamsState,
	type ResolvedOpenAIParamsConfig,
} from "./utils";

function getConfigCwd(ctx: ExtensionContext): string {
	return ctx.cwd;
}

export default function openAIParams(pi: ExtensionAPI): void {
	let state: OpenAIParamsState = {
		fast: false,
		longCache: false,
		verbosity: undefined,
	};
	let config: ResolvedOpenAIParamsConfig = {
		configPath: "",
		fast: false,
		longCache: false,
		verbosity: undefined,
	};

	function refreshConfig(ctx: ExtensionContext) {
		config = resolveConfig(getConfigCwd(ctx), undefined, { projectTrusted: isProjectTrusted(ctx) });
		state = {
			fast: config.fast,
			longCache: config.longCache,
			verbosity: config.verbosity,
		};
	}

	function emitOpenAIParamsState(ctx: ExtensionContext) {
		pi.events.emit(OPENAI_PARAMS_EVENT_CHANNEL, toOpenAIParamsEventPayload(getConfigCwd(ctx), state));
	}

	pi.on("session_start", async (_event, ctx) => {
		refreshConfig(ctx);
		emitOpenAIParamsState(ctx);
	});

	pi.registerCommand(OPENAI_PARAMS_COMMAND, {
		description: "Open OpenAI fast mode, long cache, and verbosity settings",
		handler: async (_args, ctx) => {
			refreshConfig(ctx);

			if (!isTuiMode(ctx)) {
				if (ctx.hasUI) {
					ctx.ui.notify("OpenAI params settings require TUI mode", "error");
				}
				return;
			}

			const result = await ctx.ui.custom<OpenAIParamsState | null>((tui, theme, _keybindings, done) =>
				new OpenAIParamsScreen(tui, theme, state, {
					modelLabel: getCurrentModelKey(ctx.model),
					onSave: (nextState) => done(nextState),
					onCancel: () => done(null),
				}),
			);

			if (!result) {
				return;
			}

			state = result;
			config = {
				...config,
				fast: state.fast,
				longCache: state.longCache,
				verbosity: state.verbosity,
			};
			persistConfig(config);
			emitOpenAIParamsState(ctx);
			ctx.ui.notify(
				`Saved OpenAI params: fast ${state.fast ? "on" : "off"}, long cache ${state.longCache ? "on" : "off"}, verbosity ${state.verbosity ?? "default"}`,
				"info",
			);
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const next = applyConfiguredParams(event.payload, ctx.model, state);
		if (next.longCacheApplied) {
			pi.events.emit(
				PROMPT_CACHE_RETENTION_EVENT_CHANNEL,
				toPromptCacheRetentionEventPayload(getConfigCwd(ctx)),
			);
		}
		if (!next.changed) {
			return;
		}
		return next.payload;
	});
}
