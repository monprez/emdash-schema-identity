/**
 * The Roles page. A byline credited with no role label is an author. Any
 * other label ("Reviewed by", "Photos") is left out of the structured data
 * until it is mapped here: we never guess from the words.
 */

import type { BlockResponse, FormField } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";

import { LIMITS, ROLE_CHOICES, quote, type RoleChoice } from "../model.js";
import { forgetUnmappedLabels, loadConfig, loadUnmappedLabels, recordUnmappedLabels, saveRoles } from "../store.js";
import { toast } from "./ui.js";

const OPTIONS = [
	{ label: "Leave out (not mapped)", value: "unmapped" },
	{ label: "Author", value: "author" },
	{ label: "Editor", value: "editor" },
	{ label: "Reviewer (reviewedBy, on the page)", value: "reviewer" },
	{ label: "Contributor", value: "contributor" },
	{ label: "Ignore on purpose", value: "ignore" },
	{ label: "Remove from this list", value: "forget" },
];
const NEW_LABEL_OPTIONS = OPTIONS.filter((o) => o.value !== "unmapped" && o.value !== "forget");

/** Labels travel in action_ids, so encode them. */
const fieldId = (label: string) => `role_${encodeURIComponent(label)}`;
function labelFromField(id: string): string | null {
	if (!id.startsWith("role_")) return null;
	try {
		return decodeURIComponent(id.slice(5));
	} catch {
		return null;
	}
}

export async function renderRoles(ctx: PluginContext): Promise<BlockResponse> {
	const { roles } = await loadConfig(ctx);
	const unmapped = await loadUnmappedLabels(ctx);
	const all = [...new Set([...Object.keys(roles), ...unmapped])].sort((a, b) => a.localeCompare(b));
	// Writes keep the total within the limit; this guards the page against
	// anything stored past it. Saving keeps labels that are not shown.
	const labels = all.slice(0, LIMITS.roleLabels);

	// Radio rather than select: EmDash 1.0's Block Kit select shows the raw
	// value, not the label, once an option is chosen.
	const fields: FormField[] = labels.map((label) => ({
		type: "radio",
		action_id: fieldId(label),
		label: `"${label}"${roles[label] ? "" : " (seen on your site, not mapped yet)"}`,
		options: OPTIONS,
		initial_value: roles[label] ?? "unmapped",
	}));
	fields.push(
		{ type: "text_input", action_id: "new_label", label: "Add a label before it is used (exactly as written on the byline)", initial_value: "" },
		{ type: "radio", action_id: "new_role", label: "…mapped to", options: NEW_LABEL_OPTIONS, initial_value: "author" },
	);

	return {
		blocks: [
			{ type: "header", text: "Byline roles" },
			{
				type: "context",
				text: `A byline credited without a role is an author. A byline with a role label (such as "Reviewed by") is left out of the structured data until you say what the label means. Labels appear here once a page that uses them has been viewed, up to ${LIMITS.roleLabels} labels in all. Remove ones you no longer use to make room; a label still used on a page comes back, unmapped, when that page is viewed.`,
			},
			...(all.length > labels.length
				? [
						{
							type: "banner" as const,
							variant: "alert" as const,
							title: `${all.length} labels stored; the first ${labels.length} are shown`,
							description: "Remove labels you no longer use to see the rest. Saving keeps the ones not shown.",
						},
					]
				: []),
			...(unmapped.length > 0
				? [{ type: "banner" as const, variant: "alert" as const, title: `${unmapped.length} label${unmapped.length === 1 ? "" : "s"} not mapped yet` }]
				: []),
			{ type: "form", block_id: "roles", fields, submit: { label: "Save roles", action_id: "save_roles" } },
		],
	};
}

/** Applies the form to the stored mapping: labels the form did not show are kept as they are. */
export async function submitRoles(ctx: PluginContext, values: Record<string, unknown>): Promise<BlockResponse> {
	const { roles } = await loadConfig(ctx);
	const map: Record<string, RoleChoice> = Object.assign(Object.create(null), roles);
	const cleared: string[] = [];
	const removed: string[] = [];
	for (const [key, value] of Object.entries(values)) {
		const label = labelFromField(key);
		if (!label) continue;
		if (ROLE_CHOICES.includes(value as RoleChoice)) {
			map[label] = value as RoleChoice;
			continue;
		}
		delete map[label];
		(value === "forget" ? removed : cleared).push(label);
	}

	// Mapped and unmapped labels share one limit, so the page fits in one response.
	const stillUnmapped = (await loadUnmappedLabels(ctx)).filter((l) => !removed.includes(l) && !Object.hasOwn(map, l));
	const known = new Set([...Object.keys(map), ...cleared, ...stillUnmapped]);
	const newLabel = typeof values.new_label === "string" ? values.new_label.trim() : "";
	let refused = "";
	if (newLabel && ROLE_CHOICES.includes(values.new_role as RoleChoice)) {
		if (newLabel.length > LIMITS.shortText) refused = `labels are limited to ${LIMITS.shortText} characters`;
		else if (!known.has(newLabel) && known.size >= LIMITS.roleLabels) refused = `there is a limit of ${LIMITS.roleLabels} labels`;
		else map[newLabel] = values.new_role as RoleChoice;
	}

	await saveRoles(ctx, map);
	await forgetUnmappedLabels(ctx, [...Object.keys(map), ...removed]);
	// A label set back to "leave out" stays listed, so it can be mapped later.
	await recordUnmappedLabels(ctx, cleared, Object.keys(map).length);
	return refused
		? toast(await renderRoles(ctx), `Roles saved, but "${quote(newLabel, 40)}" was not added: ${refused}`, "error")
		: toast(await renderRoles(ctx), "Roles saved");
}
