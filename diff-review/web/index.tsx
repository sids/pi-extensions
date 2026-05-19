import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./app";

declare global {
	interface Window {
		__PI_DIFF_REVIEW_TOKEN__?: string;
	}
}

const reviewToken = window.__PI_DIFF_REVIEW_TOKEN__;
const rootElement = document.getElementById("root");
if (!rootElement || !reviewToken) {
	throw new Error("Missing diff review bootstrap state.");
}

createRoot(rootElement).render(
	<React.StrictMode>
		<App reviewToken={reviewToken} />
	</React.StrictMode>,
);
