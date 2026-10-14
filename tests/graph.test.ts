import { describe, expect, it } from "vitest";

import { buildGraph, type Credit, type GraphInput, type SiteIdentity } from "../src/graph.js";

type Node = Record<string, unknown>;

const SITE = "https://example.com";

const site: SiteIdentity = {
	mode: "both",
	person: { name: "Alex Morgan", credentials: [{ name: "MCSP", dateIssued: "2019-06-01" }] },
	organization: { name: "Morgan Physio AB" },
	worksFor: true,
	founder: true,
	ownerGroup: "g-owner",
};

function input(overrides: Partial<GraphInput> = {}): GraphInput {
	return {
		today: "2026-09-30",
		site,
		credits: [],
		page: {
			url: `${SITE}/posts/a`,
			canonical: `${SITE}/posts/a`,
			siteUrl: SITE,
			siteName: "Site",
			isArticle: true,
			title: "A post",
			datePublished: "2026-09-01T00:00:00Z",
		},
		...overrides,
	};
}

const nodes = (g: Node) => g["@graph"] as Node[];
const byType = (g: Node, type: string) => nodes(g).filter((n) => n["@type"] === type);
const article = (g: Node) => byType(g, "BlogPosting")[0]!;

/** Every { "@id" } reference must point at a node in the graph. */
function danglingRefs(g: Node): string[] {
	const defined = new Set(nodes(g).map((n) => n["@id"]));
	const missing: string[] = [];
	const walk = (v: unknown, top: boolean) => {
		if (Array.isArray(v)) return v.forEach((x) => walk(x, false));
		if (v && typeof v === "object") {
			const o = v as Node;
			if (!top && Object.keys(o).length === 1 && typeof o["@id"] === "string" && !defined.has(o["@id"])) {
				missing.push(o["@id"]);
			}
			for (const x of Object.values(o)) walk(x, false);
		}
	};
	nodes(g).forEach((n) => walk(n, true));
	return missing;
}

const credit = (c: Partial<Credit> & { group: string }): Credit => ({ name: c.group, role: "author", ...c });

describe("buildGraph", () => {
	it("credits bylines by translationGroup @id and never leaves a dangling reference", () => {
		const g = buildGraph(input({ credits: [credit({ group: "g1", name: "Sam" }), credit({ group: "g2", name: "Kim", role: "editor" })] }));
		expect(article(g).author).toEqual({ "@id": `${SITE}/#/schema/person/g1` });
		expect(article(g).editor).toEqual([{ "@id": `${SITE}/#/schema/person/g2` }]);
		expect(danglingRefs(g)).toEqual([]);
	});

	it("merges the owner byline into the site Person: one node, the site Person's credentials", () => {
		const g = buildGraph(
			input({ credits: [credit({ group: "g-owner", name: "Alex M.", bio: "Byline bio", websiteUrl: "https://alex.example" })] }),
		);
		const people = byType(g, "Person");
		expect(people).toHaveLength(1);
		expect(people[0]).toMatchObject({
			"@id": `${SITE}/#/schema/person`,
			name: "Alex Morgan",
			description: "Byline bio",
			sameAs: ["https://alex.example"],
		});
		expect(people[0]!.hasCredential).toHaveLength(1);
		expect(article(g).author).toEqual({ "@id": `${SITE}/#/schema/person` });
	});

	it("names the theme's author inline, with no @id, when bylines could not be read", () => {
		const g = buildGraph(input({ credits: undefined, page: { ...input().page, fallbackAuthor: "Jo" } }));
		expect(article(g).author).toEqual({ "@type": "Person", name: "Jo" });
	});

	it("emits an Article without author rather than dropping it when nobody is credited", () => {
		const g = buildGraph(input({ credits: [] }));
		expect(article(g)).toBeDefined();
		expect(article(g)).not.toHaveProperty("author");
	});

	it("puts reviewedBy on the WebPage, not the article", () => {
		const g = buildGraph(input({ credits: [credit({ group: "g3", role: "reviewer" })] }));
		expect(byType(g, "WebPage")[0]!.reviewedBy).toEqual([{ "@id": `${SITE}/#/schema/person/g3` }]);
		expect(article(g)).not.toHaveProperty("reviewedBy");
	});

	it("does not set about on pages by default", () => {
		const g = buildGraph(input());
		expect(byType(g, "WebPage")[0]).not.toHaveProperty("about");
	});

	it("only links worksFor and founder to an Organization that is in the graph", () => {
		const g = buildGraph(input({ site: { ...site, organization: { name: "" } } }));
		expect(byType(g, "Organization")).toHaveLength(0);
		expect(byType(g, "Person")[0]).not.toHaveProperty("worksFor");
		expect(danglingRefs(g)).toEqual([]);
	});

	it("uses the Person as publisher when the site is a person", () => {
		const g = buildGraph(input({ site: { mode: "person", person: { name: "Alex" } } }));
		expect(article(g).publisher).toEqual({ "@id": `${SITE}/#/schema/person` });
	});

	it("gives each page its own page-level @ids", () => {
		const a = buildGraph(input());
		const b = buildGraph(input({ page: { ...input().page, url: `${SITE}/posts/b`, canonical: `${SITE}/posts/b` } }));
		expect(article(a)["@id"]).not.toBe(article(b)["@id"]);
		expect(byType(a, "WebSite")[0]!["@id"]).toBe(byType(b, "WebSite")[0]!["@id"]);
	});

	it("leaves image out when the page has none, rather than guessing core's default image", () => {
		const g = buildGraph(input({ page: { ...input().page, image: null } }));
		expect(article(g)).not.toHaveProperty("image");
		expect(byType(g, "ImageObject")).toHaveLength(0);
		expect(byType(g, "WebPage")[0]).not.toHaveProperty("primaryImageOfPage");
	});

	it("keeps an unlinked byline as its own Person, without the site Person's credentials", () => {
		const g = buildGraph(input({ site: { ...site, ownerGroup: undefined }, credits: [credit({ group: "g-owner", name: "Alex M." })] }));
		const people = byType(g, "Person");
		expect(people.map((p) => p["@id"])).toEqual([`${SITE}/#/schema/person`, `${SITE}/#/schema/person/g-owner`]);
		expect(people[1]).not.toHaveProperty("hasCredential");
		expect(article(g).author).toEqual({ "@id": `${SITE}/#/schema/person/g-owner` });
	});

	it("builds breadcrumbs from the theme's trail and skips a malformed url instead of throwing", () => {
		const g = buildGraph(
			input({ page: { ...input().page, breadcrumbs: [{ name: "Home", url: "/" }, { name: "Bad", url: "http://[" }] } }),
		);
		const list = byType(g, "BreadcrumbList")[0]!.itemListElement as Node[];
		expect(list[0]).toEqual({ "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` });
		expect(list[1]).not.toHaveProperty("item");
	});
});
