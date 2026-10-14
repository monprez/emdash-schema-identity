/**
 * Shared admin helpers: interaction parsing, status labels, byline lookup
 * and small Block Kit builders. Block Kit is JSON the host renders; nothing
 * here runs in the browser.
 */

import type { Block, BlockResponse, FormField } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";

import { credentialStatus, isPublishable, type CredentialFormat, type CredentialRow } from "../credentials.js";
import { LIMITS, fitBytes } from "../model.js";

export type Interaction =
	| { type: "page_load"; page: string }
	| { type: "block_action"; action_id: string; value?: unknown; page?: string }
	| { type: "form_submit"; action_id: string; block_id?: string; values: Record<string, unknown>; page?: string };

/** routeCtx.input is `unknown`: anything can call a private route, so check the shape. */
export function parseInteraction(input: unknown): Interaction | null {
	if (!input || typeof input !== "object") return null;
	const i = input as Record<string, unknown>;
	const page = typeof i.page === "string" ? i.page : undefined;
	if (i.type === "page_load" && page) return { type: "page_load", page };
	if (i.type === "block_action" && typeof i.action_id === "string") {
		return { type: "block_action", action_id: i.action_id, value: i.value, page };
	}
	if (i.type === "form_submit" && typeof i.action_id === "string" && i.values && typeof i.values === "object") {
		return {
			type: "form_submit",
			action_id: i.action_id,
			block_id: typeof i.block_id === "string" ? i.block_id : undefined,
			values: i.values as Record<string, unknown>,
			page,
		};
	}
	return null;
}

export const toast = (response: BlockResponse, message: string, type: "success" | "error" | "info" = "success"): BlockResponse => ({
	...response,
	toast: { message, type },
});

export function errorBanner(errors: string[]): Block[] {
	if (errors.length === 0) return [];
	return [{ type: "banner", variant: "error", title: "Not saved", description: errors.join(" ") }];
}

/**
 * A field's initial value: what was just submitted (after an error), else what
 * is stored. Submit handlers pass the validator's `echo`, which already keeps
 * each field within its budget; the cap here only guards a value stored past
 * the limits (written by hand), which would otherwise make the page unrenderable.
 */
export function initial(submitted: Record<string, unknown> | undefined, key: string, stored: string): string {
	const v = submitted?.[key];
	return fitBytes(typeof v === "string" ? v : stored, LIMITS.fieldBytes);
}

export function textField(
	action_id: string,
	label: string,
	initial_value: string,
	opts: { multiline?: boolean; placeholder?: string; condition?: FormField["condition"] } = {},
): FormField {
	return {
		type: "text_input",
		action_id,
		label,
		initial_value,
		...(opts.multiline ? { multiline: true } : {}),
		...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
		...(opts.condition ? { condition: opts.condition } : {}),
	} as FormField;
}

// ── Credential status for the admin ──────────────────────────────

/** The badge text, from the same status function and toggle the graph uses. */
export function statusLabel(row: CredentialRow, format: CredentialFormat, today: string): string {
	if (row.published === false) return "Hidden";
	const status = credentialStatus(row, today);
	if (status === "pending" && !isPublishable(row, format, today)) return "Pending (shown once issued)";
	return { invalid: "Invalid dates", expired: "Expired", pending: "Pending", active: "Active" }[status];
}

/** Whole days from `today` to `ymd` (negative if past). */
export function daysUntil(ymd: string, today: string): number {
	const t = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
	return Math.round((t(ymd) - t(today)) / 86_400_000);
}

// ── Bylines ──────────────────────────────────────────────────────

export interface BylineGroup {
	group: string;
	name: string;
	slug: string;
}

/** Every byline, one entry per translationGroup, by name (bounded). */
export async function listBylineGroups(ctx: PluginContext): Promise<BylineGroup[]> {
	return (await listBylines(ctx)).groups;
}

/** As listBylineGroups, saying whether the listing stopped at its bound (5,000 rows). */
export async function listBylines(ctx: PluginContext): Promise<{ groups: BylineGroup[]; complete: boolean }> {
	if (!ctx.bylines) return { groups: [], complete: true };
	const out = new Map<string, BylineGroup>();
	let cursor: string | undefined;
	let pages = 0;
	do {
		const page = await ctx.bylines.list({ limit: 100, cursor });
		for (const b of page.items) {
			if (!out.has(b.translationGroup)) {
				out.set(b.translationGroup, { group: b.translationGroup, name: b.displayName, slug: b.slug });
			}
		}
		cursor = page.hasMore ? page.cursor : undefined;
		pages++;
	} while (cursor && pages < 50);
	return { groups: [...out.values()].sort((a, b) => a.name.localeCompare(b.name)), complete: !cursor };
}
