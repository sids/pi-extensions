import React from "react";
import { createRoot } from "react-dom/client";
import "react-diff-view/style/index.css";
import "./styles.css";
import { App } from "./app";

declare global {
	interface Window {
		__PI_DIFF_CMUX_VIEWER_TOKEN__?: string;
	}
}

const viewerToken = window.__PI_DIFF_CMUX_VIEWER_TOKEN__;
const rootElement = document.getElementById("root");
if (!rootElement || !viewerToken) {
	throw new Error("Missing diff viewer bootstrap state.");
}

createRoot(rootElement).render(
	<React.StrictMode>
		<App viewerToken={viewerToken} />
	</React.StrictMode>,
);
