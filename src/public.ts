/**
 * The public `people` route: the display data a theme needs to *show* the
 * credentials this plugin publishes, since structured data should reflect
 * what readers can see.
 *
 * Returns exactly what the graph would publish for that person today:
 * the same status rules, the same Published switch. Nothing else is exposed,
 * and nothing for a byline that no longer exists: data kept for a deleted
 * byline stays private until it is restored or deleted.
 *
 *   GET /_emdash/api/plugins/schema-identity/people?group=<translationGroup>
 *   GET /_emdash/api/plugins/schema-identity/people?site=person
 */

import type { PluginContext } from "emdash/plugin";

import { isPublishable, todayIn } from "./credentials.js";
import { OWNER_SITE_PERSON, mergedOwnerGroup, ownerForGroup, type CredentialRecord } from "./model.js";
import { credentialsFor, getPerson, loadConfig } from "./store.js";

export interface PublicCredential {
	name: string;
	issuer?: string;
	dateIssued?: string;
	dateExpires?: string;
	url?: string;
	badgeUrl?: string;
}

export interface PublicPerson {
	jobTitle?: string;
	knowsAbout: string[];
	credentials: PublicCredential[];
}

const GROUP = /^[\w-]{1,128}$/;
const nothing = (): PublicPerson => ({ knowsAbout: [], credentials: [] });

/**
 * Whether a byline group still exists, in one read. EmDash names a group after
 * its first byline's row ID, so on a single-language site (v1) the group *is*
 * that row. If the first translation of a multilingual byline is deleted
 * while another survives, this says no: it fails closed. Multilingual support
 * (a later version) must revisit this.
 */
async function groupExists(ctx: PluginContext, group: string): Promise<boolean> {
	if (!ctx.bylines) return false;
	try {
		return (await ctx.bylines.get(group))?.translationGroup === group;
	} catch {
		return false;
	}
}

function publicCredentials(rows: CredentialRecord[], today: string): PublicCredential[] {
	return rows
		.filter((r) => isPublishable(r, "credential", today))
		.map((r) => ({
			name: r.name,
			...(r.issuer ? { issuer: r.issuer } : {}),
			...(r.dateIssued ? { dateIssued: r.dateIssued } : {}),
			...(r.dateExpires ? { dateExpires: r.dateExpires } : {}),
			...(r.url ? { url: r.url } : {}),
			...(r.badgeUrl ? { badgeUrl: r.badgeUrl } : {}),
		}));
}

export async function handlePeopleRoute(input: unknown, ctx: PluginContext): Promise<PublicPerson | { error: string }> {
	const q = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const { identity } = await loadConfig(ctx);
	const today = todayIn(identity.timeZone);

	const wantsSite = q.site === "person";
	const group = typeof q.group === "string" ? q.group : "";
	if (!wantsSite && !GROUP.test(group)) return { error: "Pass ?group=<byline translation group> or ?site=person." };

	// The owner byline *is* the site Person: answer with the site Person's data.
	const merged = mergedOwnerGroup(identity);
	if (wantsSite || (merged !== "" && group === merged)) {
		if (identity.mode === "organization" || !identity.person.name.trim()) return nothing();
		const rows = (await credentialsFor(ctx, [OWNER_SITE_PERSON])).get(OWNER_SITE_PERSON) ?? [];
		return {
			...(identity.person.jobTitle ? { jobTitle: identity.person.jobTitle } : {}),
			knowsAbout: identity.person.knowsAbout,
			credentials: publicCredentials(rows, today),
		};
	}

	if (!(await groupExists(ctx, group))) return nothing();
	const owner = ownerForGroup(group);
	const [person, creds] = await Promise.all([getPerson(ctx, group), credentialsFor(ctx, [owner])]);
	return {
		...(person.jobTitle ? { jobTitle: person.jobTitle } : {}),
		knowsAbout: person.knowsAbout,
		credentials: publicCredentials(creds.get(owner) ?? [], today),
	};
}

