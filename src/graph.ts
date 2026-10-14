/**
 * Pure schema.org graph assembly. No EmDash imports, no I/O: everything the
 * page needs arrives in `GraphInput`, including `today`, so the same input
 * always gives the same graph and the file is testable in plain Node.
 *
 * Site-wide nodes use `<site>/#/schema/<type>[/<translationGroup>]` and page
 * nodes `<page>#/schema/<type>`, so they never collide with other plugins'
 * `#article`-style ids. Relationships are asserted only where
 * something confirms them, and a node is referenced only if it
 * is in the graph.
 */

import { buildCredentials, type CredentialRow } from "./credentials.js";

type Node = Record<string, unknown>;

export type EntityMode = "person" | "organization" | "both";

/** What a credit contributes. Unmapped role labels never reach the builder. */
export type CreditRole = "author" | "editor" | "reviewer" | "contributor";

export interface SitePerson {
	name: string;
	jobTitle?: string;
	description?: string;
	url?: string;
	image?: string;
	sameAs?: string[];
	knowsAbout?: string[];
	credentials?: CredentialRow[];
}

export interface SiteOrganization {
	name: string;
	url?: string;
	logo?: string;
	description?: string;
	sameAs?: string[];
	knowsAbout?: string[];
	certifications?: CredentialRow[];
}

export interface SiteIdentity {
	mode: EntityMode;
	person?: SitePerson;
	organization?: SiteOrganization;
	/** The site Person works for the Organization. */
	worksFor?: boolean;
	/** The site Person founded the Organization. A separate claim from worksFor. */
	founder?: boolean;
	/** Byline translationGroup that *is* the site Person (they share one @id and one credential list). */
	ownerGroup?: string;
}

/** Shared per-person data kept by the plugin, keyed by translationGroup. */
export interface PersonProfile {
	jobTitle?: string;
	image?: string;
	sameAs?: string[];
	knowsAbout?: string[];
	worksFor?: boolean;
	credentials?: CredentialRow[];
}

/** One credited byline, already resolved to a role. Display data comes from the byline itself. */
export interface Credit {
	group: string;
	name: string;
	bio?: string | null;
	websiteUrl?: string | null;
	role: CreditRole;
	profile?: PersonProfile;
}

export interface PageFacts {
	/** Page URL as served. */
	url: string;
	canonical?: string | null;
	/** Public site origin, e.g. https://example.com */
	siteUrl: string;
	siteName?: string | null;
	isArticle: boolean;
	/** Page title without the site name. */
	title?: string | null;
	description?: string | null;
	image?: string | null;
	datePublished?: string | null;
	dateModified?: string | null;
	/** Root first, as EmDash's BreadcrumbItem: absolute or root-relative url. */
	breadcrumbs?: { name: string; url: string }[];
	/**
	 * Author name from the theme, used only when bylines are unavailable:
	 * an inline Person with no @id and no credentials.
	 */
	fallbackAuthor?: string | null;
}

export interface GraphInput {
	page: PageFacts;
	site: SiteIdentity;
	/** Undefined when bylines could not be read; [] when the entry has none. */
	credits?: Credit[];
	/** YYYY-MM-DD, one per request. */
	today: string;
}

const clean = (v: string | null | undefined): string => (typeof v === "string" ? v.trim() : "");

function list(values: readonly (string | null | undefined)[] | undefined): string[] {
	const out: string[] = [];
	for (const v of values ?? []) {
		const s = clean(v);
		if (s && !out.includes(s)) out.push(s);
	}
	return out;
}

/** Drop undefined, "", and empty arrays. Validators prefer absent keys. */
function prune(node: Node): Node {
	const out: Node = {};
	for (const [k, v] of Object.entries(node)) {
		if (v === undefined || v === null || v === "") continue;
		if (Array.isArray(v) && v.length === 0) continue;
		out[k] = v;
	}
	return out;
}

const imageObject = (url: string): Node | undefined => (url ? { "@type": "ImageObject", url } : undefined);

/** Resolve a theme-supplied href against the site; a malformed one is left out rather than thrown. */
function absoluteUrl(href: string, siteUrl: string): string | undefined {
	if (!href) return undefined;
	try {
		return new URL(href, `${siteBase(siteUrl)}/`).href;
	} catch {
		return undefined;
	}
}

export function siteBase(siteUrl: string): string {
	return siteUrl.replace(/\/+$/, "");
}

export function ids(siteUrl: string, pageUrl: string) {
	const site = siteBase(siteUrl);
	return {
		website: `${site}/#/schema/website`,
		organization: `${site}/#/schema/organization`,
		person: `${site}/#/schema/person`,
		byline: (group: string) => `${site}/#/schema/person/${encodeURIComponent(group)}`,
		webpage: `${pageUrl}#/schema/webpage`,
		article: `${pageUrl}#/schema/article`,
		breadcrumb: `${pageUrl}#/schema/breadcrumb`,
		primaryImage: `${pageUrl}#/schema/primaryimage`,
	};
}

export function buildGraph(input: GraphInput): Node {
	const { page, site, today } = input;
	const pageUrl = clean(page.canonical) || page.url;
	const id = ids(page.siteUrl, pageUrl);
	const graph: Node[] = [];

	// ── Site entity ────────────────────────────────────────────────
	const wantPerson = site.mode === "person" || site.mode === "both";
	const wantOrg = site.mode === "organization" || site.mode === "both";
	const personName = clean(site.person?.name);
	const orgName = clean(site.organization?.name);
	const hasPerson = wantPerson && personName !== "";
	const hasOrg = wantOrg && orgName !== "";

	// The owner byline, if credited here, fills gaps in the site Person.
	const ownerCredit =
		hasPerson && site.ownerGroup
			? input.credits?.find((c) => c.group === site.ownerGroup)
			: undefined;

	if (hasPerson && site.person) {
		const p = site.person;
		graph.push(
			prune({
				"@type": "Person",
				"@id": id.person,
				name: personName,
				jobTitle: clean(p.jobTitle),
				description: clean(p.description) || clean(ownerCredit?.bio),
				url: clean(p.url),
				image: imageObject(clean(p.image)),
				sameAs: list([...(p.sameAs ?? []), ownerCredit?.websiteUrl]),
				// knowsAbout sits on the Person; the Organization carries it only
				// when there is no Person to (as in WP).
				knowsAbout: list(p.knowsAbout),
				hasCredential: buildCredentials(p.credentials ?? [], "credential", today),
				worksFor: hasOrg && site.worksFor ? { "@id": id.organization } : undefined,
			}),
		);
	}

	if (hasOrg && site.organization) {
		const o = site.organization;
		graph.push(
			prune({
				"@type": "Organization",
				"@id": id.organization,
				name: orgName,
				url: clean(o.url) || `${siteBase(page.siteUrl)}/`,
				logo: imageObject(clean(o.logo)),
				description: clean(o.description),
				sameAs: list(o.sameAs),
				knowsAbout: hasPerson ? undefined : list(o.knowsAbout),
				hasCertification: buildCredentials(o.certifications ?? [], "certification", today),
				founder: hasPerson && site.founder ? { "@id": id.person } : undefined,
			}),
		);
	}

	// Publisher: the Organization when there is one, otherwise the Person.
	const publisherId = hasOrg ? id.organization : hasPerson ? id.person : undefined;
	const publisher = publisherId ? { "@id": publisherId } : undefined;

	const siteName = clean(page.siteName) || (hasOrg ? orgName : personName);
	graph.push(
		prune({
			"@type": "WebSite",
			"@id": id.website,
			url: `${siteBase(page.siteUrl)}/`,
			name: siteName,
			publisher,
		}),
	);

	// ── People credited on this page ───────────────────────────────
	const refs: Record<CreditRole, Node[]> = { author: [], editor: [], reviewer: [], contributor: [] };
	const emitted = new Set<string>();

	for (const credit of input.credits ?? []) {
		if (hasPerson && site.ownerGroup && credit.group === site.ownerGroup) {
			refs[credit.role].push({ "@id": id.person });
			continue;
		}
		const personId = id.byline(credit.group);
		refs[credit.role].push({ "@id": personId });
		if (emitted.has(personId)) continue;
		emitted.add(personId);
		const prof = credit.profile ?? {};
		graph.push(
			prune({
				"@type": "Person",
				"@id": personId,
				name: clean(credit.name),
				description: clean(credit.bio),
				url: clean(credit.websiteUrl),
				jobTitle: clean(prof.jobTitle),
				image: imageObject(clean(prof.image)),
				sameAs: list(prof.sameAs),
				knowsAbout: list(prof.knowsAbout),
				hasCredential: buildCredentials(prof.credentials ?? [], "credential", today),
				worksFor: hasOrg && prof.worksFor ? { "@id": id.organization } : undefined,
			}),
		);
	}

	// ── The page ───────────────────────────────────────────────────
	const title = clean(page.title);
	const image = clean(page.image);
	const crumbs = (page.breadcrumbs ?? []).filter((b) => clean(b.name));

	graph.push(
		prune({
			"@type": "WebPage",
			"@id": id.webpage,
			url: pageUrl,
			name: title,
			description: clean(page.description),
			isPartOf: { "@id": id.website },
			publisher,
			primaryImageOfPage: image ? { "@id": id.primaryImage } : undefined,
			breadcrumb: crumbs.length > 0 ? { "@id": id.breadcrumb } : undefined,
			// reviewedBy is defined on WebPage, not on the article.
			reviewedBy: refs.reviewer.length > 0 ? refs.reviewer : undefined,
		}),
	);

	if (image) {
		graph.push({ "@type": "ImageObject", "@id": id.primaryImage, url: image });
	}

	if (crumbs.length > 0) {
		graph.push({
			"@type": "BreadcrumbList",
			"@id": id.breadcrumb,
			itemListElement: crumbs.map((b, i) =>
				prune({
					"@type": "ListItem",
					position: i + 1,
					name: clean(b.name),
					item: absoluteUrl(clean(b.url), page.siteUrl),
				}),
			),
		});
	}

	if (page.isArticle) {
		let author: Node | Node[] | undefined;
		if (input.credits === undefined) {
			// Bylines unavailable: name the theme's author inline, never with an
			// @id or credentials, since nothing confirms who that is.
			const name = clean(page.fallbackAuthor);
			author = name ? { "@type": "Person", name } : undefined;
		} else if (refs.author.length > 0) {
			author = refs.author.length === 1 ? refs.author[0] : refs.author;
		}

		graph.push(
			prune({
				"@type": "BlogPosting",
				"@id": id.article,
				headline: title,
				description: clean(page.description),
				image: image ? { "@id": id.primaryImage } : undefined,
				datePublished: clean(page.datePublished),
				dateModified: clean(page.dateModified) || clean(page.datePublished),
				mainEntityOfPage: { "@id": id.webpage },
				isPartOf: { "@id": id.website },
				author,
				editor: refs.editor.length > 0 ? refs.editor : undefined,
				contributor: refs.contributor.length > 0 ? refs.contributor : undefined,
				publisher,
			}),
		);
	}

	return { "@context": "https://schema.org", "@graph": graph };
}
