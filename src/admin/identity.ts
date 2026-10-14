/** The Identity page: who the site is, and settings that apply site-wide. */

import type { BlockResponse, FormField } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";

import { LIMITS, fitBytes, quote, validateIdentity } from "../model.js";
import { loadConfig, saveIdentity } from "../store.js";
import { errorBanner, initial, listBylineGroups, textField, toast } from "./ui.js";

const notOrg = { field: "mode", neq: "organization" } as const;
const notPerson = { field: "mode", neq: "person" } as const;
const both = { field: "mode", eq: "both" } as const;

/**
 * Up to this many bylines the owner is picked from a list (3 nodes each in a
 * 2,000-node response); past it the admin types the byline's slug instead.
 */
const OWNER_PICKER_MAX = 400;
const OWNER_LABEL =
	"Which byline is this person? Their posts then credit this identity and its credentials. While linked, anything added for that byline on People is kept but not published.";

export async function renderIdentity(
	ctx: PluginContext,
	submitted?: Record<string, unknown>,
	errors: string[] = [],
): Promise<BlockResponse> {
	const { identity: id } = await loadConfig(ctx);
	const bylines = await listBylineGroups(ctx);
	// A linked byline that has since been deleted stays selectable, so the
	// form still renders and the admin can choose another or None.
	const owner = initial(submitted, "ownerGroup", id.ownerGroup);
	const ownerMissing = owner !== "" && !bylines.some((b) => b.group === owner);
	const picker = bylines.length <= OWNER_PICKER_MAX;
	const lines = (v: string[]) => v.join("\n");
	const bool = (key: string, stored: boolean) =>
		typeof submitted?.[key] === "boolean" ? (submitted[key] as boolean) : stored;

	const fields: FormField[] = [
		// Radio and combobox rather than select: EmDash 1.0's Block Kit select
		// shows the raw value, not the label, once an option is chosen.
		{
			type: "radio",
			action_id: "mode",
			label: "This site represents",
			options: [
				{ label: "A person", value: "person" },
				{ label: "An organization", value: "organization" },
				{ label: "Both: a person and their organization", value: "both" },
			],
			// A radio's value must be one of its options, so an unknown submitted mode shows the stored one.
			initial_value: ["person", "organization", "both"].includes(submitted?.mode as string) ? (submitted!.mode as string) : id.mode,
		},

		textField("person_name", "Person: name", initial(submitted, "person_name", id.person.name), { condition: notOrg }),
		textField("person_jobTitle", "Person: job title", initial(submitted, "person_jobTitle", id.person.jobTitle), {
			condition: notOrg,
		}),
		textField("person_description", "Person: short description", initial(submitted, "person_description", id.person.description), {
			multiline: true,
			condition: notOrg,
		}),
		textField("person_url", "Person: web address", initial(submitted, "person_url", id.person.url), {
			placeholder: "https://",
			condition: notOrg,
		}),
		textField("person_image", "Person: photo (public image address)", initial(submitted, "person_image", id.person.image), {
			placeholder: "https://",
			condition: notOrg,
		}),
		textField("person_sameAs", "Person: profiles elsewhere (one web address per line, e.g. LinkedIn)", initial(submitted, "person_sameAs", lines(id.person.sameAs)), {
			multiline: true,
			condition: notOrg,
		}),
		textField("person_knowsAbout", "Person: areas of expertise (one per line)", initial(submitted, "person_knowsAbout", lines(id.person.knowsAbout)), {
			multiline: true,
			condition: notOrg,
		}),
		picker
			? {
					type: "combobox",
					action_id: "ownerGroup",
					label: OWNER_LABEL,
					options: [
						{ label: "None: publish the identity, credit posts to their real bylines", value: "" },
						...(ownerMissing ? [{ label: "Deleted byline: choose another, or None", value: owner }] : []),
						...bylines.map((b) => ({ label: `${b.name} (${b.slug})`, value: b.group })),
					],
					initial_value: owner,
					placeholder: "Search bylines…",
					condition: notOrg,
				}
			: textField(
					"ownerSlug",
					`${OWNER_LABEL} Type the byline's slug, or leave empty for none.`,
					initial(submitted, "ownerSlug", bylines.find((b) => b.group === owner)?.slug ?? ""),
					{ condition: notOrg },
				),

		textField("org_name", "Organization: name", initial(submitted, "org_name", id.organization.name), { condition: notPerson }),
		textField("org_url", "Organization: web address (defaults to this site)", initial(submitted, "org_url", id.organization.url), {
			placeholder: "https://",
			condition: notPerson,
		}),
		textField("org_logo", "Organization: logo (public image address)", initial(submitted, "org_logo", id.organization.logo), {
			placeholder: "https://",
			condition: notPerson,
		}),
		textField("org_description", "Organization: short description", initial(submitted, "org_description", id.organization.description), {
			multiline: true,
			condition: notPerson,
		}),
		textField("org_sameAs", "Organization: profiles elsewhere (one web address per line)", initial(submitted, "org_sameAs", lines(id.organization.sameAs)), {
			multiline: true,
			condition: notPerson,
		}),
		textField("org_knowsAbout", "Organization: areas of expertise (one per line; used only when there is no person)", initial(submitted, "org_knowsAbout", lines(id.organization.knowsAbout)), {
			multiline: true,
			condition: notPerson,
		}),

		{
			type: "toggle",
			action_id: "worksFor",
			label: "The person works for the organization",
			initial_value: bool("worksFor", id.worksFor),
			condition: both,
		},
		{
			type: "toggle",
			action_id: "founder",
			label: "The person founded the organization",
			description: "A separate claim: an employee is not a founder.",
			initial_value: bool("founder", id.founder),
			condition: both,
		},

		textField("timeZone", "Time zone for credential dates", initial(submitted, "timeZone", id.timeZone), {
			placeholder: "Europe/Stockholm",
		}),
	];

	return {
		blocks: [
			{ type: "header", text: "Identity" },
			{
				type: "context",
				text: "Who this site represents. Published as schema.org structured data on every page. Only fill in what is true and shown on your site.",
			},
			...errorBanner(errors),
			...(ownerMissing
				? [
						{
							type: "banner" as const,
							variant: "alert" as const,
							title: "The byline linked to this person was deleted",
							description: "Choose another byline for the person, or None, and save.",
						},
					]
				: []),
			{ type: "form", block_id: "identity", fields, submit: { label: "Save identity", action_id: "save_identity" } },
			{
				type: "actions",
				elements: [
					{ type: "link", label: "Credentials and certifications", target: { kind: "plugin-page", path: "/credentials" } },
					{ type: "link", label: "People", target: { kind: "plugin-page", path: "/people" } },
				],
			},
			{ type: "header", text: "How to check" },
			{
				type: "context",
				text: "Open a published article that has a byline, and paste its address into Google's Rich Results Test (what Google can use) and the Schema.org validator (every node). Changes show on the next page view, unless your pages are cached.",
			},
			{
				type: "actions",
				elements: [
					{ type: "link", label: "Rich Results Test", target: { kind: "external", url: "https://search.google.com/test/rich-results" } },
					{ type: "link", label: "Schema.org validator", target: { kind: "external", url: "https://validator.schema.org/" } },
				],
			},
		],
	};
}

export async function submitIdentity(ctx: PluginContext, values: Record<string, unknown>): Promise<BlockResponse> {
	// Past OWNER_PICKER_MAX bylines the form sends a slug, not a group.
	const errors: string[] = [];
	let resolved = values;
	let slugEcho: Record<string, string> = {};
	if (typeof values.ownerSlug === "string") {
		const slug = values.ownerSlug.trim();
		slugEcho = { ownerSlug: fitBytes(slug, LIMITS.shortText * 4) };
		const byline = slug ? (await listBylineGroups(ctx)).find((b) => b.slug === slug) : undefined;
		if (slug && !byline) errors.push(`There is no byline with the slug "${quote(slug)}".`);
		resolved = { ...values, ownerGroup: byline?.group ?? "" };
	}
	const result = validateIdentity(resolved);
	errors.push(...result.errors);
	if (!result.value || errors.length > 0) {
		// Booleans come from the submission; text from the validator's bounded echo.
		return toast(await renderIdentity(ctx, { ...values, ...result.echo, ...slugEcho }, errors), "Identity not saved", "error");
	}
	await saveIdentity(ctx, result.value);
	return toast(await renderIdentity(ctx), "Identity saved");
}
