import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { OpenAIParamsScreen } from "./settings-screen";
import {
	applyConfiguredParams,
	DEFAULT_SUPPORTED_MODEL_KEYS,
	getCurrentModelKey,
	OPENAI_PARAMS_COMMAND,
	parseSupportedModels,
	persistConfig,
	resolveConfig,
	type OpenAIParamsState,
	type ResolvedOpenAIParamsConfig,
} from "./utils";

function getConfigCwd(ctx: ExtensionContext): string {
	return ctx.cwd || process.cwd();
}

export default function openAIParams(pi: ExtensionAPI): void {
	let state: OpenAIParamsState = {
		fast: false,
		verbosity: undefined,
	};
	let config: ResolvedOpenAIParamsConfig = {
		configPath: "",
		fast: false,
		verbosity: undefined,
		supportedModels: parseSupportedModels(DEFAULT_SUPPORTED_MODEL_KEYS) ?? [],
	};

	function refreshConfig(ctx: ExtensionContext) {
		config = resolveConfig(getConfigCwd(ctx));
		state = {
			fast: config.fast,
			verbosity: config.verbosity,
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		refreshConfig(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		refreshConfig(ctx);
	});

	pi.registerCommand(OPENAI_PARAMS_COMMAND, {
		description: "Open OpenAI fast mode and verbosity settings",
		handler: async (_args, ctx) => {
			refreshConfig(ctx);

			if (!ctx.hasUI) {
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
				verbosity: state.verbosity,
			};
			persistConfig(config);
			ctx.ui.notify(
				`Saved OpenAI params: fast ${state.fast ? "on" : "off"}, verbosity ${state.verbosity ?? "default"}`,
				"info",
			);
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const next = applyConfiguredParams(event.payload, ctx.model, state, config.supportedModels);
		if (!next.changed) {
			return;
		}
		return next.payload;
	});
}
