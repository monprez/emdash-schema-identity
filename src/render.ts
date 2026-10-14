/**
 * The page:metadata hook: gather what the page needs, hand it to the pure
 * builder, return one JSON-LD contribution under "primary".
 *
 * It never throws. A failed lookup degrades (no bylines → the theme's author
 * inline; no stored data → less markup) and is logged.
 */

import type { PageMetadataEvent, PluginContext } from "emdash/plugin";

import { todayIn } from "./credentials.js";
import { buildGraph, type Credit, type SiteIdentity } from "./graph.js";
import {
	OWNER_ORGANIZATION,
	OWNER_SITE_PERSON,
	mergedOwnerGroup,
	ownerForGroup,
	roleFor,
	type CredentialRecord,
	type IdentitySettings,
	type PersonRecord,
	type RoleChoice,
} from "./model.js";
import { credentialsFor, getPeople, loadConfig, recordUnmappedLabels } from "./store.js";

interface BylineCredit {
	byline: {
		displayName: string;
		bio: string | null;
		websiteUrl: string | null;
		translationGroup: string;
	};
	roleLabel: string | null;
}

export async function renderPageMetadata(event: PageMetadataEvent, ctx: PluginContext) {
	const page = event.page;
	let config: Awaited<ReturnType<typeof loadConfig>>;
	try {
		config = await loadConfig(ctx);
	} catch (error) {
		ctx.log.warn("settings unavailable; leaving core's markup", { error: String(error) });
		return null;
	}
	const { identity, roles } = config;
	const today = todayIn(identity.timeZone);
	const siteUrl = page.siteUrl || ctx.site.url || new URL(page.url).origin;

	// Who is credited, and in what role.
	let credited: Array<{ credit: BylineCredit; role: Exclude<RoleChoice, "ignore"> }> | undefined;
	if (page.content && ctx.bylines) {
		try {
			const [entry] = await ctx.bylines.getEntriesBylines(page.content.collection, [page.content.id]);
			credited = [];
			const unmapped: string[] = [];
			for (const credit of (entry?.bylines ?? []) as BylineCredit[]) {
				const role = roleFor(credit.roleLabel, roles);
				if (role === "unmapped") unmapped.push(credit.roleLabel!.trim());
				else if (role !== "ignore") credited.push({ credit, role });
			}
			await recordUnmappedLabels(ctx, unmapped, Object.keys(roles).length).catch(() => undefined);
		} catch (error) {
			ctx.log.warn("byline lookup failed", { error: String(error) });
			credited = undefined;
		}
	}

	// Stored data for the site entity and the credited people, in two reads.
	// The owner byline uses the site Person's data only when that Person is
	// in the graph; otherwise it is an ordinary person with its own.
	const merged = mergedOwnerGroup(identity);
	const groups = [...new Set((credited ?? []).map((c) => c.credit.byline.translationGroup))].filter(
		(g) => g !== merged,
	);
	const owners = [OWNER_SITE_PERSON, OWNER_ORGANIZATION, ...groups.map(ownerForGroup)];
	let people = new Map<string, PersonRecord>();
	let creds = new Map<string, CredentialRecord[]>();
	try {
		[people, creds] = await Promise.all([getPeople(ctx, groups), credentialsFor(ctx, owners)]);
	} catch (error) {
		ctx.log.warn("stored identity data unavailable", { error: String(error) });
	}

	const credits: Credit[] | undefined = credited?.map(({ credit, role }) => {
		const b = credit.byline;
		const profile = people.get(b.translationGroup);
		return {
			group: b.translationGroup,
			name: b.displayName,
			bio: b.bio,
			websiteUrl: b.websiteUrl,
			role,
			profile: {
				jobTitle: profile?.jobTitle,
				image: profile?.image,
				sameAs: profile?.sameAs,
				knowsAbout: profile?.knowsAbout,
				worksFor: profile?.worksFor,
				credentials: creds.get(ownerForGroup(b.translationGroup)) ?? [],
			},
		};
	});

	let graph: ReturnType<typeof buildGraph>;
	try {
		graph = buildGraph({
			today,
			site: toSiteIdentity(identity, creds),
			credits,
			page: {
				url: page.url,
				canonical: page.canonical,
				siteUrl,
				siteName: page.siteName,
				isArticle: page.pageType === "article",
				// Same precedence core uses for its own headline and og:* tags.
				title: page.seo?.ogTitle ?? page.pageTitle ?? page.title,
				description: page.seo?.ogDescription || page.description,
				image: page.seo?.ogImage || page.image,
				datePublished: page.articleMeta?.publishedTime,
				dateModified: page.articleMeta?.modifiedTime,
				breadcrumbs: page.breadcrumbs,
				fallbackAuthor: page.articleMeta?.author,
			},
		});
	} catch (error) {
		ctx.log.warn("graph build failed; leaving core's markup", { error: String(error) });
		return null;
	}

	return { kind: "jsonld" as const, id: "primary", graph };
}

export function toSiteIdentity(identity: IdentitySettings, creds: Map<string, CredentialRecord[]>): SiteIdentity {
	return {
		mode: identity.mode,
		person: { ...identity.person, credentials: creds.get(OWNER_SITE_PERSON) ?? [] },
		organization: { ...identity.organization, certifications: creds.get(OWNER_ORGANIZATION) ?? [] },
		worksFor: identity.worksFor,
		founder: identity.founder,
		ownerGroup: identity.ownerGroup || undefined,
	};
}
