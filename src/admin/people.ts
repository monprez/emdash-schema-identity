/**
 * The People page: every byline, and the data this plugin keeps for each
 * (keyed by translationGroup, shared by a byline's translations). Display data (name, bio,
 * website) stays in EmDash's byline editor; this page adds what bylines
 * cannot hold.
 */

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";

import { todayIn } from "../credentials.js";
import { mergedOwnerGroup, ownerForGroup, validatePerson, type PersonRecord } from "../model.js";
import { credentialGroups, credentialsFor, getPerson, loadConfig, peopleGroups, savePerson } from "../store.js";
import { credentialTable } from "./credentials.js";
import { errorBanner, initial, listBylineGroups, listBylines, textField, toast } from "./ui.js";

/** Bylines and deleted-byline rows per page: the page stays well under EmDash's 2,000-node response limit. */
const PAGE_SIZE = 100;
const ORPHAN_PAGE_SIZE = 25;

/** A table's "Load more" sends `{ cursor }`; ours is the offset of the next page. */
export function peopleOffset(value: unknown): number | null {
	const cursor = value && typeof value === "object" ? (value as Record<string, unknown>).cursor : undefined;
	if (typeof cursor !== "string" || !/^\d{1,6}$/.test(cursor)) return null;
	return Number(cursor);
}

/** `offset` pages the bylines, `orphanOffset` the data kept for deleted bylines. */
export async function renderPeople(ctx: PluginContext, offset = 0, orphanOffset = 0): Promise<BlockResponse> {
	const { identity } = await loadConfig(ctx);
	const { groups: bylines, complete: allBylines } = await listBylines(ctx);
	const start = offset < bylines.length ? offset : 0;
	const pageBylines = bylines.slice(start, start + PAGE_SIZE);
	const creds = await credentialsFor(ctx, pageBylines.map((b) => ownerForGroup(b.group)));
	const known = new Set(bylines.map((b) => b.group));

	const merged = mergedOwnerGroup(identity);
	const rows = pageBylines.map((b) => {
		const isOwner = merged !== "" && b.group === merged;
		return {
			name: b.name,
			slug: b.slug,
			credentials: isOwner ? "See Identity" : String(creds.get(ownerForGroup(b.group))?.length ?? 0),
			edit: isOwner
				? { type: "link", label: "Site owner: edit on Identity", target: { kind: "plugin-page", path: "/identity" } }
				: { type: "button", action_id: "open_person", label: "Edit", value: b.group },
		};
	});

	// Data left behind by bylines that no longer exist: kept, never deleted
	// automatically. If the byline listing stopped at its bound, a byline past
	// it would look deleted, so nothing is listed rather than a wrong list.
	const orphanGroups = new Set<string>();
	let orphansComplete = allBylines;
	if (allBylines) {
		const [people, withCredentials] = await Promise.all([peopleGroups(ctx), credentialGroups(ctx)]);
		for (const g of [...people.groups, ...withCredentials.groups]) if (!known.has(g)) orphanGroups.add(g);
		orphansComplete = people.complete && withCredentials.complete;
	}
	const orphans = [...orphanGroups].sort();
	const orphanStart = orphanOffset < orphans.length ? orphanOffset : 0;
	const orphanRows = orphans.slice(orphanStart, orphanStart + ORPHAN_PAGE_SIZE);

	const blocks: Block[] = [
		{ type: "header", text: "People" },
		{
			type: "context",
			text: "Everyone with a byline. Each person credited on a post gets their own structured data, with the job title, expertise and credentials you add here. Name, bio and website come from the byline itself.",
		},
		...(bylines.length > PAGE_SIZE
			? [
					{
						type: "context" as const,
						text: `Showing ${start + 1}–${start + pageBylines.length} of ${bylines.length} bylines, by name.`,
					},
				]
			: []),
		{
			type: "table",
			page_action_id: "people_page",
			empty_text: "No bylines yet. Create them under Bylines.",
			columns: [
				{ key: "name", label: "Name" },
				{ key: "slug", label: "Slug", format: "code" },
				{ key: "credentials", label: "Credentials" },
				{ key: "edit", label: "", format: "element" },
			],
			rows,
			...(start + PAGE_SIZE < bylines.length ? { next_cursor: String(start + PAGE_SIZE) } : {}),
		},
		...(start > 0 || orphanStart > 0
			? [{ type: "actions" as const, elements: [{ type: "link" as const, label: "Back to the first page", target: { kind: "plugin-page" as const, path: "/people" } }] }]
			: []),
	];

	if (orphans.length > 0) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: `Data kept for ${orphans.length} deleted byline${orphans.length === 1 ? "" : "s"}`,
			description: `It is no longer published. It stays here in case the byline is restored; delete it if you no longer need it.${
				orphans.length > ORPHAN_PAGE_SIZE ? ` Showing ${orphanStart + 1}–${orphanStart + orphanRows.length} of ${orphans.length}.` : ""
			}`,
		});
		blocks.push({
			type: "table",
			page_action_id: "orphans_page",
			...(orphanStart + ORPHAN_PAGE_SIZE < orphans.length ? { next_cursor: String(orphanStart + ORPHAN_PAGE_SIZE) } : {}),
			columns: [
				{ key: "group", label: "Byline ID", format: "code" },
				{ key: "action", label: "", format: "element" },
			],
			rows: orphanRows.map((group) => ({
				group,
				action: {
					type: "button",
					action_id: "delete_orphan",
					label: "Delete data",
					style: "danger",
					value: group,
					confirm: {
						title: "Delete this person's data?",
						text: "Their profile and credentials are removed for good.",
						confirm: "Delete",
						deny: "Cancel",
						style: "danger",
					},
				},
			})),
		});
	}
	if (!orphansComplete) {
		blocks.push({
			type: "context",
			text: "This site has too many bylines or stored records to check them all for deleted bylines, so data kept for some deleted bylines may not be listed here.",
		});
	}
	return { blocks };
}

export async function renderPerson(
	ctx: PluginContext,
	group: string,
	submitted?: Record<string, unknown>,
	errors: string[] = [],
	credentialOffset = 0,
): Promise<BlockResponse> {
	const { identity } = await loadConfig(ctx);
	const byline = (await listBylineGroups(ctx)).find((b) => b.group === group);
	const person: PersonRecord = await getPerson(ctx, group);
	const owner = ownerForGroup(group);
	const creds = (await credentialsFor(ctx, [owner])).get(owner) ?? [];
	const lines = (v: string[]) => v.join("\n");

	return {
		blocks: [
			{ type: "header", text: byline ? byline.name : "Deleted byline" },
			{ type: "context", text: "Name, bio and website are edited on the byline itself, under Bylines." },
			...errorBanner(errors),
			{
				type: "form",
				block_id: `person|${group}`,
				fields: [
					textField("jobTitle", "Job title", initial(submitted, "jobTitle", person.jobTitle)),
					textField("image", "Photo (public image address)", initial(submitted, "image", person.image), { placeholder: "https://" }),
					textField("sameAs", "Profiles elsewhere (one web address per line, e.g. LinkedIn)", initial(submitted, "sameAs", lines(person.sameAs)), {
						multiline: true,
					}),
					textField("knowsAbout", "Areas of expertise (one per line)", initial(submitted, "knowsAbout", lines(person.knowsAbout)), {
						multiline: true,
					}),
					...(identity.mode !== "person"
						? [
								{
									type: "toggle" as const,
									action_id: "worksFor",
									label: `Works for ${identity.organization.name || "the organization"}`,
									initial_value: typeof submitted?.worksFor === "boolean" ? submitted.worksFor : person.worksFor,
								},
							]
						: []),
				],
				submit: { label: "Save", action_id: "save_person" },
			},
			{ type: "header", text: "Credentials" },
			...credentialTable(owner, creds, todayIn(identity.timeZone), credentialOffset),
			{ type: "actions", elements: [{ type: "link", label: "Back to People", target: { kind: "plugin-page", path: "/people" } }] },
		],
	};
}

export function parsePersonBlock(blockId: string | undefined): string | null {
	const m = /^person\|([\w-]{1,128})$/.exec(blockId ?? "");
	return m ? m[1]! : null;
}

export async function submitPerson(ctx: PluginContext, group: string, values: Record<string, unknown>): Promise<BlockResponse> {
	const result = validatePerson(values);
	if (!result.value) return toast(await renderPerson(ctx, group, { ...values, ...result.echo }, result.errors), "Not saved", "error");
	await savePerson(ctx, { group, ...result.value });
	return toast(await renderPerson(ctx, group), "Saved");
}
