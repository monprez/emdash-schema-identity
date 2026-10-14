/**
 * Credential lists and the add/edit form. Block Kit on sandboxed pages has
 * no repeater, so a list is a table and each
 * credential is edited in its own form.
 *
 * One component serves three kinds of owner: the site Person and a byline
 * (person credentials) and the Organization (certifications).
 */

import type { Block, BlockResponse, FormField } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";

import { todayIn, type CredentialFormat } from "../credentials.js";
import {
	LIMITS,
	OWNER_ORGANIZATION,
	OWNER_SITE_PERSON,
	groupFromOwner,
	validateCredential,
	type CredentialRecord,
} from "../model.js";
import { credentialsFor, deleteCredential, getCredential, loadConfig, saveCredential } from "../store.js";
import { errorBanner, initial, statusLabel, textField, toast } from "./ui.js";

export const formatFor = (owner: string): CredentialFormat =>
	owner === OWNER_ORGANIZATION ? "certification" : "credential";

const noun = (owner: string) => (formatFor(owner) === "certification" ? "certification" : "credential");

/** Where "Back" goes after editing a credential. */
export type Back = { page: "/credentials" } | { person: string };
export const backFor = (owner: string): Back => {
	const group = groupFromOwner(owner);
	return group ? { person: group } : { page: "/credentials" };
};

/**
 * The table's "Load more" sends `{ cursor }`; ours is `<owner>|<offset>`. A
 * list holds at most LIMITS.credentialsPerOwner rows, so it pages only for
 * rows stored past that (see store.ts).
 */
export function credentialPage(value: unknown): { owner: string; offset: number } | null {
	const cursor = value && typeof value === "object" ? (value as Record<string, unknown>).cursor : undefined;
	const m = typeof cursor === "string" ? /^(.+)\|(\d{1,6})$/.exec(cursor) : null;
	return m && isOwner(m[1]!) ? { owner: m[1]!, offset: Number(m[2]) } : null;
}

/** A table of one owner's credentials with an Edit button per row and an Add button. */
export function credentialTable(owner: string, all: CredentialRecord[], today: string, offset = 0): Block[] {
	const format = formatFor(owner);
	const size = LIMITS.credentialsPerOwner;
	const start = offset < all.length ? offset : 0;
	const rows = all.slice(start, start + size);
	return [
		...(all.length > size
			? [
					{
						type: "context" as const,
						text: `Showing ${start + 1}–${start + rows.length} of ${all.length}, more than the limit of ${size}.`,
					},
				]
			: []),
		{
			type: "table",
			block_id: `creds:${owner}`,
			page_action_id: "credentials_page",
			...(start + size < all.length ? { next_cursor: `${owner}|${start + size}` } : {}),
			empty_text: `No ${noun(owner)}s yet.`,
			columns: [
				{ key: "name", label: "Name" },
				{ key: "issuer", label: "Issued by" },
				{ key: "issued", label: "Issued" },
				{ key: "expires", label: "Expires" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "edit", label: "", format: "element" },
			],
			rows: rows.map((r) => ({
				name: r.name,
				issuer: r.issuer ?? "",
				issued: r.dateIssued ?? "",
				expires: r.dateExpires || "Never",
				status: statusLabel(r, format, today),
				edit: { type: "button", action_id: "edit_credential", label: "Edit", value: { owner, id: r.id } },
			})),
		},
		{
			type: "actions",
			elements:
				all.length < size
					? [{ type: "button", action_id: "add_credential", label: `Add ${noun(owner)}`, style: "primary", value: { owner } }]
					: [],
		},
	];
}

/** The /credentials page: the site Person's credentials and the Organization's certifications. */
export async function renderSiteCredentials(ctx: PluginContext, page?: { owner: string; offset: number }): Promise<BlockResponse> {
	const offsetFor = (owner: string) => (page?.owner === owner ? page.offset : 0);
	const { identity } = await loadConfig(ctx);
	const today = todayIn(identity.timeZone);
	const creds = await credentialsFor(ctx, [OWNER_SITE_PERSON, OWNER_ORGANIZATION]);
	const blocks: Block[] = [{ type: "header", text: "Credentials and certifications" }];

	if (identity.mode !== "organization") {
		blocks.push(
			{ type: "section", text: `${identity.person.name || "Site person"}: licences, degrees and professional qualifications.` },
			...credentialTable(OWNER_SITE_PERSON, creds.get(OWNER_SITE_PERSON) ?? [], today, offsetFor(OWNER_SITE_PERSON)),
		);
	}
	if (identity.mode !== "person") {
		blocks.push(
			{ type: "section", text: `${identity.organization.name || "Organization"}: certifications and accreditations (ISO, memberships, approvals).` },
			...credentialTable(OWNER_ORGANIZATION, creds.get(OWNER_ORGANIZATION) ?? [], today, offsetFor(OWNER_ORGANIZATION)),
		);
	}
	blocks.push({
		type: "context",
		text: "Expired, hidden and invalid entries are left out of the structured data automatically. A person's credential with a future issue date is shown once it is issued.",
	});
	return { blocks };
}

/** Add (id null) or edit form. `submitted` refills the form after a validation error. */
export async function renderCredentialForm(
	ctx: PluginContext,
	owner: string,
	id: string | null,
	submitted?: Record<string, unknown>,
	errors: string[] = [],
): Promise<BlockResponse> {
	const existing = id ? await getCredential(ctx, id) : null;
	if (id && (!existing || existing.owner !== owner)) {
		return toast({ blocks: [{ type: "banner", variant: "error", title: "That credential no longer exists." }] }, "Not found", "error");
	}
	const r = existing;
	const isCert = formatFor(owner) === "certification";
	const fields: FormField[] = [
		textField("name", "Name", initial(submitted, "name", r?.name ?? ""), {
			placeholder: isCert ? "ISO 9001:2015" : "Chartered Physiotherapist (MCSP)",
		}),
		textField("issuer", "Issued by", initial(submitted, "issuer", r?.issuer ?? ""), {
			placeholder: isCert ? "Certification body" : "Awarding or registering body",
		}),
		...(isCert ? [textField("certNumber", "Certificate number", initial(submitted, "certNumber", r?.certNumber ?? ""))] : []),
		{ type: "date_input", action_id: "dateIssued", label: "Issue date", initial_value: initial(submitted, "dateIssued", r?.dateIssued ?? "") },
		{
			type: "date_input",
			action_id: "dateExpires",
			label: "Expiry date (leave empty if it never expires)",
			initial_value: initial(submitted, "dateExpires", r?.dateExpires ?? ""),
		},
		textField("url", "Verification link (where someone can check it)", initial(submitted, "url", r?.url ?? ""), { placeholder: "https://" }),
		textField("badgeUrl", "Badge image (public image address)", initial(submitted, "badgeUrl", r?.badgeUrl ?? ""), { placeholder: "https://" }),
		{
			type: "toggle",
			action_id: "published",
			label: "Published",
			description: "Turn off to hide it (for example if it was withdrawn), whatever its dates say.",
			initial_value: typeof submitted?.published === "boolean" ? submitted.published : r?.published !== false,
		},
	];

	const back = backFor(owner);
	return {
		blocks: [
			{ type: "header", text: `${id ? "Edit" : "Add"} ${noun(owner)}` },
			...errorBanner(errors),
			{ type: "form", block_id: `cred|${owner}|${id ?? "new"}`, fields, submit: { label: "Save", action_id: "save_credential" } },
			{
				type: "actions",
				elements: [
					{ type: "button", action_id: "back", label: "Back", value: back },
					...(id
						? [
								{
									type: "button" as const,
									action_id: "delete_credential",
									label: "Delete",
									style: "danger" as const,
									value: { owner, id },
									confirm: {
										title: `Delete this ${noun(owner)}?`,
										text: "It is removed from the structured data straight away. This cannot be undone.",
										confirm: "Delete",
										deny: "Cancel",
										style: "danger" as const,
									},
								},
							]
						: []),
				],
			},
		],
	};
}

/** Parse the form's block_id: `cred|<owner>|<id or "new">`. */
export function parseCredentialBlock(blockId: string | undefined): { owner: string; id: string | null } | null {
	const parts = blockId?.split("|");
	if (!parts || parts.length !== 3 || parts[0] !== "cred") return null;
	const [, owner, id] = parts;
	if (!isOwner(owner!)) return null;
	return { owner: owner!, id: id === "new" ? null : id! };
}

export function isOwner(owner: string): boolean {
	return owner === OWNER_SITE_PERSON || owner === OWNER_ORGANIZATION || /^group:[\w-]{1,128}$/.test(owner);
}

export async function submitCredential(
	ctx: PluginContext,
	owner: string,
	id: string | null,
	values: Record<string, unknown>,
	after: (message: string) => Promise<BlockResponse>,
): Promise<BlockResponse> {
	const result = validateCredential(values, formatFor(owner) === "certification");
	const shown = { ...values, ...result.echo };
	if (!result.value) return toast(await renderCredentialForm(ctx, owner, id, shown, result.errors), "Not saved", "error");
	const saved = await saveCredential(ctx, owner, id, result.value);
	if ("error" in saved) return toast(await renderCredentialForm(ctx, owner, id, shown, [saved.error]), "Not saved", "error");
	return after(`${noun(owner)[0]!.toUpperCase()}${noun(owner).slice(1)} saved`);
}

export async function removeCredential(
	ctx: PluginContext,
	owner: string,
	id: string,
	after: (message: string) => Promise<BlockResponse>,
): Promise<BlockResponse> {
	const deleted = await deleteCredential(ctx, owner, id);
	return after(deleted ? "Deleted" : "It was already gone");
}
