import type { SandboxedPlugin } from "emdash/plugin";

import { handleAdmin } from "./admin/index.js";
import { handlePeopleRoute } from "./public.js";
import { renderPageMetadata } from "./render.js";
import { ensureSchema } from "./store.js";

/**
 * Schema Identity: owns the page's JSON-LD graph. The hook
 * replaces core's "primary" contribution on every page; the admin route
 * serves the Block Kit pages declared in emdash-plugin.jsonc; the public
 * `people` route lets themes show what the markup says.
 */
const plugin: SandboxedPlugin = {
	hooks: {
		"page:metadata": async (event, ctx) => renderPageMetadata(event, ctx),
		"plugin:activate": async (_event, ctx) => ensureSchema(ctx),
	},
	routes: {
		admin: {
			handler: async (routeCtx, ctx) => handleAdmin(routeCtx.input, ctx),
		},
		people: {
			public: true,
			methods: ["GET"],
			// Credentials change by date: five minutes keeps an expiry prompt.
			cacheControl: "public, max-age=300",
			handler: async (routeCtx, ctx) => handlePeopleRoute(routeCtx.input, ctx),
		},
	},
};

export default plugin;
