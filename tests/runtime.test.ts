/**
 * Admin pages, the page hook and the public route through EmDash's runtime
 * test host: production sandbox, real storage, and Block Kit validation of
 * every page response (an invalid block fails the call, as in the admin).
 */

import { afterEach, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

type Node = Record<string, unknown>;
type Response = { blocks: Node[]; toast?: { message: string; type: string } };

const SITE = "https://example.com";

async function setup() {
	host = await createPluginRuntimeTestHost({ site: { name: "Test Site", url: SITE } });
	return host;
}

const identityValues = {
	mode: "both",
	timeZone: "Europe/Stockholm",
	person_name: "Alex Morgan",
	person_jobTitle: "Physiotherapist",
	person_sameAs: "https://www.linkedin.com/in/alex",
	person_knowsAbout: "Physiotherapy\nRunning injuries",
	org_name: "Morgan Physio AB",
	worksFor: true,
	founder: true,
	ownerGroup: "",
};

async function pageGraph(h: PluginRuntimeTestHost, page: Record<string, unknown>) {
	const result = (await h.transport.invokeHook("page:metadata", {
		page: {
			url: `${SITE}/posts/a`,
			path: "/posts/a",
			locale: null,
			kind: "custom",
			pageType: "website",
			title: "A",
			description: null,
			canonical: `${SITE}/posts/a`,
			image: null,
			siteName: "Test Site",
			...page,
		},
	})) as { graph: { "@graph": Node[] } } | Array<{ graph: { "@graph": Node[] } }>;
	const contribution = Array.isArray(result) ? result[0]! : result;
	return contribution.graph["@graph"];
}

describe("admin pages render valid Block Kit", () => {
	it("loads every page and the widget on a fresh install", async () => {
		const h = await setup();
		for (const path of ["/identity", "/credentials", "/people", "/roles"]) {
			const r = (await h.admin.loadPage(path)) as unknown as Response;
			expect(r.blocks.length, path).toBeGreaterThan(0);
		}
		const w = (await h.admin.loadWidget("expiring")) as unknown as Response;
		expect(w.blocks.length).toBeGreaterThan(0);
	});
});

describe("identity and credentials, end to end", () => {
	it("saves the identity, adds credentials, and publishes them in the graph", async () => {
		const h = await setup();

		const saved = (await h.admin.submit("/identity", "save_identity", identityValues, { blockId: "identity" })) as unknown as Response;
		expect(saved.toast?.type).toBe("success");

		// Add a person credential through the form, as the admin would.
		const form = (await h.admin.act("/credentials", "add_credential", { value: { owner: "site-person" } })) as unknown as Response;
		const formBlock = form.blocks.find((b) => b.type === "form")!;
		const added = (await h.admin.submit(
			"/credentials",
			"save_credential",
			{ name: "MCSP", issuer: "CSP", dateIssued: "2019-06-01", dateExpires: "", url: "", badgeUrl: "", published: true },
			{ blockId: formBlock.block_id as string },
		)) as unknown as Response;
		expect(added.toast?.type).toBe("success");

		// A bad date is refused with the reason, and nothing is stored.
		const refused = (await h.admin.submit(
			"/credentials",
			"save_credential",
			{ name: "Bad", dateIssued: "2026-02-30", published: true },
			{ blockId: "cred|site-person|new" },
		)) as unknown as Response;
		expect(refused.toast?.type).toBe("error");
		expect(JSON.stringify(refused.blocks)).toContain("Issue date is not a real date");

		// An organisation certification.
		await h.admin.submit(
			"/credentials",
			"save_credential",
			{ name: "ISO 9001", issuer: "Body", certNumber: "N1", dateIssued: "2024-01-01", published: true },
			{ blockId: "cred|organization|new" },
		);

		const graph = await pageGraph(h, {});
		const person = graph.find((n) => n["@type"] === "Person")!;
		const org = graph.find((n) => n["@type"] === "Organization")!;
		expect(person).toMatchObject({ name: "Alex Morgan", jobTitle: "Physiotherapist", knowsAbout: ["Physiotherapy", "Running injuries"] });
		expect(person.hasCredential).toEqual([
			{ "@type": "EducationalOccupationalCredential", name: "MCSP", recognizedBy: { "@type": "Organization", name: "CSP" }, dateCreated: "2019-06-01" },
		]);
		expect(person.worksFor).toEqual({ "@id": `${SITE}/#/schema/organization` });
		expect(org.hasCertification).toMatchObject([{ name: "ISO 9001", certificationIdentification: "N1" }]);
		expect(org.founder).toEqual({ "@id": `${SITE}/#/schema/person` });
	});

	it("refuses an invalid identity and keeps what was typed", async () => {
		const h = await setup();
		const r = (await h.admin.submit("/identity", "save_identity", { ...identityValues, timeZone: "Mars/Olympus" }, { blockId: "identity" })) as unknown as Response;
		expect(r.toast?.type).toBe("error");
		expect(JSON.stringify(r.blocks)).toContain("Mars/Olympus");
	});
});

describe("bylines on a real entry", () => {
	it("credits the byline linked to the post's author (an inferred credit) with their stored credentials", async () => {
		const h = await setup();
		await h.admin.submit("/identity", "save_identity", identityValues, { blockId: "identity" });
		await h.fixtures.collection({
			slug: "posts",
			label: "Posts",
			labelSingular: "Post",
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const user = await h.fixtures.user({ email: "sam@example.com", name: "Sam", role: "author" });
		const byline = await h.fixtures.byline({ slug: "sam", displayName: "Sam Lee", bio: "Writes things.", userId: user.id });
		const entry = await h.fixtures.content("posts", { data: { title: "Hello" }, authorId: user.id, status: "published" });

		// No explicit credit: EmDash falls back to the author's linked byline, by the
		// same rule for the theme (getEmDashEntry) and for plugins (bylines/credits.ts).
		expect(await h.inspect.content.bylines("posts", entry.id)).toEqual([]);

		// Give Sam a credential through the People page.
		await h.admin.submit(
			"/people",
			"save_credential",
			{ name: "NCTJ Diploma", dateIssued: "2015-07-01", published: true },
			{ blockId: `cred|group:${byline.translationGroup}|new` },
		);

		const graph = await pageGraph(h, {
			kind: "content",
			pageType: "article",
			content: { collection: "posts", id: entry.id, slug: null },
			articleMeta: { publishedTime: "2026-09-01T00:00:00Z" },
		});
		const sam = graph.find((n) => n.name === "Sam Lee")!;
		expect(sam["@id"]).toBe(`${SITE}/#/schema/person/${byline.translationGroup}`);
		expect(sam.description).toBe("Writes things.");
		expect(sam.hasCredential).toMatchObject([{ name: "NCTJ Diploma" }]);
		const article = graph.find((n) => n["@type"] === "BlogPosting")!;
		expect(article.author).toEqual({ "@id": sam["@id"] });

		// The People page lists Sam and the public route shows the same credential.
		const people = (await h.admin.loadPage("/people")) as unknown as Response;
		expect(JSON.stringify(people.blocks)).toContain("Sam Lee");
		const pub = (await h.transport.invokeRoute("people", { group: byline.translationGroup })) as { credentials: Node[] };
		expect(pub.credentials).toEqual([{ name: "NCTJ Diploma", dateIssued: "2015-07-01" }]);
	});
});

describe("public route", () => {
	it("rejects a malformed group", async () => {
		const h = await setup();
		const r = (await h.transport.invokeRoute("people", { group: "../etc" })) as { error?: string };
		expect(r.error).toBeDefined();
	});
});
