/**
 * Regressions from the 1.0.0 release review and its follow-up (7 October 2026): settings
 * transitions, deleted bylines, admin response limits, prototype-named role
 * labels and non-string dates. Runtime cases go through EmDash's test host;
 * the large-site cases render with a stub context and check the response with
 * EmDash's own Block Kit validator, since creating hundreds of bylines through
 * the host is slow.
 */

import { afterEach, describe, expect, it } from "vitest";

import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

import { renderIdentity, submitIdentity } from "../src/admin/identity.js";
import { handleAdmin } from "../src/admin/index.js";
import { renderPeople } from "../src/admin/people.js";
import { renderRoles, submitRoles } from "../src/admin/roles.js";
import { buildCredentials } from "../src/credentials.js";
import { LIMITS, normalizeCredential, normalizeRoleMap, roleFor, utf8Bytes, validateCredential, validateIdentity } from "../src/model.js";
import { renderPageMetadata } from "../src/render.js";
import { renderWidget } from "../src/admin/widget.js";
import { recordUnmappedLabels } from "../src/store.js";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

type Node = Record<string, unknown>;

const SITE = "https://example.com";
const PUBLIC = `${SITE}/_emdash/api/plugins/schema-identity/people`;

async function setup() {
	host = await createPluginRuntimeTestHost({ site: { name: "Test Site", url: SITE } });
	return host;
}

const identity = {
	mode: "both",
	timeZone: "UTC",
	person: { name: "Alex Morgan" },
	organization: { name: "Morgan Physio AB" },
	ownerGroup: "",
};

const page = {
	url: `${SITE}/posts/a`,
	path: "/posts/a",
	locale: null,
	kind: "content",
	pageType: "article",
	title: "A",
	description: null,
	canonical: `${SITE}/posts/a`,
	image: null,
	siteName: "Test Site",
};

/** A post by Sam, credited through Sam's user (an inferred byline credit). */
async function postBySam(h: PluginRuntimeTestHost) {
	await h.fixtures.collection({ slug: "posts", label: "Posts", fields: [{ slug: "title", label: "Title", type: "string" }] });
	const user = await h.fixtures.user({ email: "sam@example.com", role: "author" });
	const byline = await h.fixtures.byline({ slug: "sam", displayName: "Sam Lee", userId: user.id });
	const entry = await h.fixtures.content("posts", { data: { title: "Hello" }, authorId: user.id, status: "published" });
	if (!byline.translationGroup) throw new Error("fixture byline has no translation group");
	return { group: byline.translationGroup, entry };
}

async function graphFor(h: PluginRuntimeTestHost, entryId: string): Promise<Node[]> {
	const r = (await h.transport.invokeHook("page:metadata", {
		page: { ...page, content: { collection: "posts", id: entryId, slug: null } },
	})) as { graph: { "@graph": Node[] } } | Array<{ graph: { "@graph": Node[] } }>;
	return (Array.isArray(r) ? r[0]! : r).graph["@graph"];
}

async function publicPerson(h: PluginRuntimeTestHost, query: string) {
	const response = await h.actions.routes.request("people", { method: "GET", url: `${PUBLIC}?${query}` });
	expect(response.status).toBe(200);
	const body = (await response.json()) as { success: boolean; data: Record<string, unknown> };
	expect(body.success).toBe(true);
	return body.data;
}

// ── Pure rules ───────────────────────────────────────────────────

describe("non-string dates are unreadable, never absent", () => {
	it("does not publish a stored credential whose expiry is a number", () => {
		const row = normalizeCredential({ name: "Licence", dateExpires: 20200101 }, "c");
		expect(buildCredentials([row], "credential", "2026-10-07")).toEqual([]);
	});

	it("refuses a submitted number, object or boolean as a date", () => {
		for (const bad of [20200101, { y: 2020 }, true]) {
			expect(validateCredential({ name: "Licence", dateExpires: bad }, false).value).toBeUndefined();
			expect(validateCredential({ name: "Licence", dateIssued: bad }, false).value).toBeUndefined();
		}
	});

	it("still treats null and a missing date as absent", () => {
		expect(validateCredential({ name: "Licence", dateExpires: null }, false).value?.dateExpires).toBeUndefined();
		expect(normalizeCredential({ name: "Licence" }, "c").dateExpires).toBe("");
	});
});

describe("role labels are data, not object keys", () => {
	it("treats Object.prototype names as unmapped labels", () => {
		const map = normalizeRoleMap({});
		for (const label of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
			expect(roleFor(label, map)).toBe("unmapped");
		}
	});

	it("maps a prototype-named label like any other", () => {
		expect(roleFor("constructor", normalizeRoleMap({ constructor: "reviewer" }))).toBe("reviewer");
	});

	it("keeps the page hook from throwing on such a label", async () => {
		const ctx = {
			settings: { list: async () => [] },
			site: { url: SITE },
			bylines: {
				getEntriesBylines: async () => [
					{ bylines: [{ byline: { displayName: "Sam", translationGroup: "g" }, roleLabel: "constructor" }] },
				],
			},
			storage: {
				people: { getMany: async () => new Map() },
				credentials: { query: async () => ({ items: [], hasMore: false }) },
			},
			kv: { get: async () => [], set: async () => {} },
			log: { warn: () => {} },
		};
		const result = await renderPageMetadata({ page: { ...page, content: { collection: "posts", id: "p" } } } as never, ctx as never);
		expect(result).toHaveProperty("graph");
	});
});

// ── Owner byline and deleted bylines ─────────────────────────────

describe("the owner byline", () => {
	it("keeps its own profile when organization mode leaves no site Person", async () => {
		const h = await setup();
		const { group, entry } = await postBySam(h);
		await h.fixtures.plugin.setting("identity", { ...identity, mode: "organization", ownerGroup: group });
		await h.fixtures.plugin.storage("people", group, { jobTitle: "Reporter" });
		await h.fixtures.plugin.storage("credentials", "c", { owner: `group:${group}`, name: "Diploma", createdAt: "2026-01-01" });

		const sam = (await graphFor(h, entry.id)).find((n) => n.name === "Sam Lee");
		expect(sam).toMatchObject({ jobTitle: "Reporter", hasCredential: [{ name: "Diploma" }] });
		expect(await publicPerson(h, `group=${group}`)).toMatchObject({ jobTitle: "Reporter", credentials: [{ name: "Diploma" }] });
		// People offers Sam's own editor instead of pointing at Identity.
		expect(JSON.stringify(await h.admin.loadPage("/people"))).not.toContain("Site owner");
	});

	it("keeps its own profile when the site Person has no name", async () => {
		const h = await setup();
		const { group, entry } = await postBySam(h);
		await h.fixtures.plugin.setting("identity", { ...identity, mode: "person", person: { name: "" }, ownerGroup: group });
		await h.fixtures.plugin.storage("people", group, { jobTitle: "Reporter" });

		expect((await graphFor(h, entry.id)).find((n) => n.name === "Sam Lee")).toMatchObject({ jobTitle: "Reporter" });
	});

	it("merges into the site Person when there is one", async () => {
		const h = await setup();
		const { group, entry } = await postBySam(h);
		await h.fixtures.plugin.setting("identity", { ...identity, ownerGroup: group });
		await h.fixtures.plugin.storage("people", group, { jobTitle: "Reporter" });

		const graph = await graphFor(h, entry.id);
		expect(graph.find((n) => n.name === "Sam Lee")).toBeUndefined();
		expect(graph.find((n) => n["@type"] === "BlogPosting")?.author).toEqual({ "@id": `${SITE}/#/schema/person` });
		expect(JSON.stringify(await h.admin.loadPage("/people"))).toContain("Site owner");
	});

	it("leaves the Identity page usable after the linked byline is deleted", async () => {
		const h = await setup();
		await h.fixtures.plugin.setting("identity", { ...identity, ownerGroup: "deleted-owner" });
		const response = JSON.stringify(await h.admin.loadPage("/identity"));
		expect(response).toContain("The byline linked to this person was deleted");
		expect(response).toContain("How to check");

		// Choosing None saves and clears the warning.
		await h.admin.submit("/identity", "save_identity", {
			mode: "both",
			timeZone: "UTC",
			person_name: "Alex Morgan",
			org_name: "Morgan Physio AB",
			ownerGroup: "",
		}, { blockId: "identity" });
		expect(JSON.stringify(await h.admin.loadPage("/identity"))).not.toContain("was deleted");
	});
});

describe("data kept for a deleted byline", () => {
	it("is not served by the public route", async () => {
		const h = await setup();
		await h.fixtures.plugin.storage("people", "deleted-byline", { jobTitle: "Former reporter" });
		await h.fixtures.plugin.storage("credentials", "c", {
			owner: "group:deleted-byline",
			name: "Retained licence",
			published: true,
			createdAt: "2026-01-01",
		});
		const body = JSON.stringify(await publicPerson(h, "group=deleted-byline"));
		expect(body).not.toContain("Retained licence");
		expect(body).not.toContain("Former reporter");
	});

	it("is served again once the group has a byline", async () => {
		const h = await setup();
		const { group } = await postBySam(h);
		await h.fixtures.plugin.storage("credentials", "c", { owner: `group:${group}`, name: "Diploma", createdAt: "2026-01-01" });
		expect(JSON.stringify(await publicPerson(h, `group=${group}`))).toContain("Diploma");
	});
});

// ── Admin response limits ────────────────────────────────────────

describe("admin pages stay within EmDash's response limits", () => {
	it("renders the Credentials page with both lists full", async () => {
		const h = await setup();
		await h.fixtures.plugin.setting("identity", identity);
		for (const owner of ["site-person", "organization"]) {
			for (let i = 0; i < LIMITS.credentialsPerOwner; i++) {
				await h.fixtures.plugin.storage("credentials", `${owner}-${i}`, {
					owner,
					name: `Chartered Physiotherapist ${i}`,
					issuer: "Health and Care Professions Council",
					dateIssued: "2020-01-01",
					dateExpires: "2030-01-01",
					url: "https://example.com/verify",
					createdAt: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
				});
			}
		}
		const response = JSON.stringify(await h.admin.loadPage("/credentials"));
		expect(response).toContain(`Chartered Physiotherapist ${LIMITS.credentialsPerOwner - 1}`);
		// Full: no Add button.
		expect(response).not.toContain("add_credential");
	});

	it("refuses a credential past the limit", async () => {
		const h = await setup();
		for (let i = 0; i < LIMITS.credentialsPerOwner; i++) {
			await h.fixtures.plugin.storage("credentials", `c-${i}`, { owner: "site-person", name: `C ${i}`, createdAt: "2026-01-01" });
		}
		const r = (await h.admin.submit("/credentials", "save_credential", { name: "One more", published: true }, {
			blockId: "cred|site-person|new",
		})) as { toast?: { type: string } };
		expect(r.toast?.type).toBe("error");
	});

	it("renders the Roles page with every label slot used", async () => {
		const h = await setup();
		const half = LIMITS.roleLabels / 2;
		await h.fixtures.plugin.setting("roles", Object.fromEntries(Array.from({ length: half }, (_, i) => [`Mapped label ${i}`, "reviewer"])));
		await h.fixtures.plugin.kv("state:unmappedRoles", Array.from({ length: half }, (_, i) => `Unmapped label ${i}`));
		await expect(h.admin.loadPage("/roles")).resolves.toHaveProperty("blocks");
	});

	it("records no unmapped labels past the shared limit", async () => {
		let stored: string[] = Array.from({ length: LIMITS.roleLabels - 12 }, (_, i) => `Seen ${i}`);
		const ctx = { kv: { get: async () => stored, set: async (_k: string, v: string[]) => void (stored = v) } };
		await recordUnmappedLabels(ctx as never, ["New 1", "New 2", "New 3"], 10);
		expect(stored).toHaveLength(LIMITS.roleLabels - 10);
		expect(stored).toContain("New 2");
		expect(stored).not.toContain("New 3");
	});

	it("does not add a label on the Roles form past the limit", async () => {
		let roles: Record<string, string> = Object.fromEntries(
			Array.from({ length: LIMITS.roleLabels }, (_, i) => [`Mapped label ${i}`, "reviewer"]),
		);
		let unmapped: string[] = [];
		const ctx = {
			settings: {
				list: async () => [{ key: "roles", value: roles }],
				set: async (_k: string, v: Record<string, string>) => void (roles = v),
			},
			kv: { get: async () => unmapped, set: async (_k: string, v: string[]) => void (unmapped = v) },
		};
		const values = Object.fromEntries([
			...Object.keys(roles).map((l) => [`role_${encodeURIComponent(l)}`, "reviewer"]),
			["new_label", "Photos"],
			["new_role", "ignore"],
		]);
		const r = await submitRoles(ctx as never, values);
		expect(r.toast?.type).toBe("error");
		expect(Object.keys(roles)).not.toContain("Photos");
		expect(Object.keys(roles)).toHaveLength(LIMITS.roleLabels);
		expect(valid(await renderRoles(ctx as never))).toBe(true);
	});
});

/** A stub context for a site with `count` bylines and nothing stored. */
function largeSite(count: number, ownerGroup = "") {
	const bylines = Array.from({ length: count }, (_, i) => {
		const id = `01JBYLINE${String(i).padStart(17, "0")}`;
		return { id, translationGroup: id, displayName: `Person Name ${String(i).padStart(4, "0")}`, slug: `person-${i}` };
	});
	let saved: unknown;
	const ctx = {
		settings: {
			list: async () => [{ key: "identity", value: saved ?? { ...identity, ownerGroup } }],
			set: async (_k: string, v: unknown) => void (saved = v),
		},
		kv: { get: async () => [], set: async () => {} },
		bylines: {
			list: async ({ cursor }: { cursor?: string } = {}) => {
				const start = Number(cursor ?? 0);
				const items = bylines.slice(start, start + 100);
				return { items, hasMore: start + 100 < bylines.length, cursor: String(start + 100) };
			},
		},
		storage: {
			people: { query: async () => ({ items: [], hasMore: false }) },
			credentials: { query: async () => ({ items: [], hasMore: false }) },
		},
	};
	return {
		ctx: ctx as never,
		bylines,
		saved: () => saved as { ownerGroup: string } | undefined,
		ctx_set: async (v: unknown) => void (saved = v),
	};
}

const PAGES = ["/identity", "/credentials", "/people", "/roles"];
const valid = (response: unknown) => {
	const result = validateBlockResponse(response, { pluginPagePaths: PAGES });
	if (!result.valid) throw new Error(JSON.stringify(result.errors));
	return result.valid;
};

describe("large sites", () => {
	it("pages the People list", async () => {
		const site = largeSite(250);
		const first = await renderPeople(site.ctx);
		expect(valid(first)).toBe(true);
		const table = first.blocks.find((b) => b.type === "table") as { rows: unknown[]; next_cursor?: string };
		expect(table.rows).toHaveLength(100);
		expect(table.next_cursor).toBe("100");

		const last = await renderPeople(site.ctx, 200);
		expect(valid(last)).toBe(true);
		const lastTable = last.blocks.find((b) => b.type === "table") as { rows: unknown[]; next_cursor?: string };
		expect(lastTable.rows).toHaveLength(50);
		expect(lastTable.next_cursor).toBeUndefined();
		expect(JSON.stringify(last)).toContain("Showing 201–250 of 250");
	});

	it("lists the owner picker up to 400 bylines", async () => {
		const response = await renderIdentity(largeSite(400).ctx);
		expect(valid(response)).toBe(true);
		expect(JSON.stringify(response)).toContain('"combobox"');
	});

	it("asks for the owner's slug past 400 bylines, and saves it as the group", async () => {
		const site = largeSite(1200, "01JBYLINE00000000000000007");
		const response = await renderIdentity(site.ctx);
		expect(valid(response)).toBe(true);
		const text = JSON.stringify(response);
		expect(text).not.toContain('"combobox"');
		expect(text).toContain('"initial_value":"person-7"');

		const values = { mode: "both", timeZone: "UTC", person_name: "Alex Morgan", org_name: "Morgan Physio AB", ownerSlug: "person-999" };
		expect((await submitIdentity(site.ctx, values)).toast?.type).toBe("success");
		expect(site.saved()?.ownerGroup).toBe(site.bylines[999]!.id);

		const bad = await submitIdentity(site.ctx, { ...values, ownerSlug: "nobody" });
		expect(bad.toast?.type).toBe("error");
		expect(JSON.stringify(bad)).toContain('no byline with the slug \\"nobody\\"');
	});
});

// ── Expiry widget ────────────────────────────────────────────────

describe("expiry widget", () => {
	it("puts upcoming renewals before old expiries", async () => {
		const h = await setup();
		await h.fixtures.plugin.setting("identity", identity);
		const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
		for (let i = 0; i < 25; i++) {
			await h.fixtures.plugin.storage("credentials", `old-${i}`, {
				owner: "site-person",
				name: `Old ${i}`,
				dateExpires: "2020-01-01",
				createdAt: "2019-01-01",
			});
		}
		await h.fixtures.plugin.storage("credentials", "soon", {
			owner: "site-person",
			name: "Renew this week",
			dateExpires: soon,
			createdAt: "2026-01-01",
		});
		const widget = JSON.stringify(await h.admin.loadWidget("expiring"));
		expect(widget).toContain("Renew this week");
		expect(widget.indexOf("Renew this week")).toBeLessThan(widget.indexOf("Old "));
		expect(widget).toContain("More not shown");
	});

	it("leaves out credentials that cannot be published", async () => {
		const h = await setup();
		await h.fixtures.plugin.setting("identity", { ...identity, mode: "person" });
		const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
		await h.fixtures.plugin.storage("credentials", "org", { owner: "organization", name: "ISO cert", dateExpires: soon, createdAt: "2026-01-01" });
		await h.fixtures.plugin.storage("credentials", "orphan", { owner: "group:gone", name: "Orphan cert", dateExpires: soon, createdAt: "2026-01-01" });
		const widget = JSON.stringify(await h.admin.loadWidget("expiring"));
		expect(widget).not.toContain("ISO cert");
		expect(widget).not.toContain("Orphan cert");
	});
});

// ── Follow-up review: data past the limits, input size, scans ────

describe("credentials stored past the limit", () => {
	async function seed(h: PluginRuntimeTestHost) {
		await h.fixtures.plugin.setting("identity", identity);
		// 100 each, the person's all older: a read bounded by the add limit would never reach the organization's.
		for (const owner of ["site-person", "organization"]) {
			for (let i = 0; i < 100; i++) {
				await h.fixtures.plugin.storage("credentials", `${owner}-${i}`, {
					owner,
					name: `${owner} ${i}`,
					createdAt: owner === "site-person" ? "2020-01-01" : "2021-01-01",
				});
			}
		}
	}

	it("are all published, for every owner", async () => {
		const h = await setup();
		await seed(h);
		const r = (await h.transport.invokeHook("page:metadata", { page: { ...page, kind: "custom", pageType: "website" } })) as {
			graph: { "@graph": Node[] };
		};
		const graph = r.graph["@graph"];
		expect(graph.find((n) => n["@type"] === "Organization")?.hasCertification).toHaveLength(100);
		expect(graph.find((n) => n["@id"] === `${SITE}/#/schema/person`)?.hasCredential).toHaveLength(100);
	});

	it("are paged on the Credentials page, each list on its own", async () => {
		const h = await setup();
		await seed(h);
		const first = JSON.stringify(await h.admin.loadPage("/credentials"));
		expect(first).toContain("Showing 1–50 of 100");
		expect(first).toContain('"next_cursor":"organization|50"');
		const next = JSON.stringify(
			await h.admin.act("/credentials", "credentials_page", { value: { cursor: "organization|50" } }),
		);
		expect(next).toContain("organization 99");
		expect(next).not.toContain("organization 0\"");
	});
});

describe("role labels stored past the limit", () => {
	it("still render, and saving keeps the ones not shown", async () => {
		const h = await setup();
		const labels = Array.from({ length: 200 }, (_, i) => `Label ${String(i).padStart(3, "0")}`);
		await h.fixtures.plugin.setting("roles", { "Label 199": "reviewer" });
		await h.fixtures.plugin.kv("state:unmappedRoles", labels.slice(0, 199));
		const page = JSON.stringify(await h.admin.loadPage("/roles"));
		expect(page).toContain(`200 labels stored; the first ${LIMITS.roleLabels} are shown`);

		// Map one shown label and remove another; "Label 199" (not shown) stays mapped.
		await h.admin.submit("/roles", "save_roles", { "role_Label%20000": "author", "role_Label%20001": "forget" }, { blockId: "roles" });
		const roles = (await h.inspect.setting("roles")) as Record<string, string>;
		expect(roles).toMatchObject({ "Label 000": "author", "Label 199": "reviewer" });
		const unmapped = (await h.inspect.kv.get("state:unmappedRoles")) as string[];
		expect(unmapped).not.toContain("Label 001");
		expect(unmapped).not.toContain("Label 000");
	});

	it("can be removed to make room at the limit", async () => {
		const h = await setup();
		await h.fixtures.plugin.kv("state:unmappedRoles", Array.from({ length: LIMITS.roleLabels }, (_, i) => `Old ${i}`));
		const r = (await h.admin.submit("/roles", "save_roles", { "role_Old%200": "forget", new_label: "Photos", new_role: "ignore" }, {
			blockId: "roles",
		})) as { toast?: { type: string } };
		expect(r.toast?.type).toBe("success");
		expect(await h.inspect.setting("roles")).toMatchObject({ Photos: "ignore" });
	});
});

describe("data kept for many deleted bylines", () => {
	it("is paged, so the 26th is reachable without deleting the first 25", async () => {
		const orphans = Array.from({ length: 26 }, (_, i) => ({ id: `orphan-${String(i).padStart(2, "0")}`, data: {} }));
		const ctx = {
			settings: { list: async () => [{ key: "identity", value: identity }] },
			kv: { get: async () => 1, set: async () => {} },
			bylines: { list: async () => ({ items: [], hasMore: false }) },
			storage: {
				people: { query: async () => ({ items: orphans, hasMore: false }) },
				credentials: { query: async () => ({ items: [], hasMore: false }) },
			},
		} as never;
		const first = await renderPeople(ctx);
		expect(JSON.stringify(first)).toContain("Showing 1–25 of 26");
		expect(JSON.stringify(first)).toContain('"next_cursor":"25"');
		const next = await handleAdmin({ type: "block_action", action_id: "orphans_page", value: { cursor: "25" } }, ctx);
		expect(valid(next)).toBe(true);
		expect(JSON.stringify(next)).toContain("orphan-25");
		expect(JSON.stringify(next)).not.toContain("orphan-00");
	});
});

describe("oversized input", () => {
	it("is refused before it is saved, and the form still renders", async () => {
		const h = await setup();
		const tooLong = `https://example.com/${"x".repeat(66_000)}`;
		const r = (await h.admin.submit(
			"/identity",
			"save_identity",
			{ mode: "person", timeZone: "UTC", person_name: "Alex", person_url: tooLong, person_sameAs: `${tooLong}\nhttps://example.com/b` },
			{ blockId: "identity" },
		)) as { toast?: { type: string } };
		expect(r.toast?.type).toBe("error");
		expect(JSON.stringify(r)).toContain(`longer than ${LIMITS.url} characters`);
		expect(await h.inspect.setting("identity")).toBeFalsy();
		await expect(h.admin.loadPage("/identity")).resolves.toHaveProperty("blocks");
	});

	it("refuses an owner value that is not a byline group, and a long role label", async () => {
		expect(validateIdentityOwner("../../x")).toBe(false);
		const h = await setup();
		const r = (await h.admin.submit("/roles", "save_roles", { new_label: "x".repeat(300), new_role: "author" }, { blockId: "roles" })) as {
			toast?: { type: string; message: string };
		};
		expect(r.toast?.type).toBe("error");
		expect(await h.inspect.setting("roles")).not.toHaveProperty("x".repeat(300));
	});
});

function validateIdentityOwner(ownerGroup: string): boolean {
	return validateIdentity({ mode: "person", timeZone: "UTC", ownerGroup }).errors.length === 0;
}

describe("expiry widget on a large site", () => {
	it("reads only the date ranges it shows, whatever else is stored", async () => {
		// 5,000 credentials that never expire, then one due next week: a scan of
		// the oldest records would stop before reaching it.
		const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
		const stored = Array.from({ length: 5001 }, (_, i) => ({
			id: `c${i}`,
			data: { owner: "site-person", name: i === 5000 ? "Renew next week" : "No expiry", dateExpires: i === 5000 ? soon : "", createdAt: "2020-01-01" },
		}));
		let scanned = 0;
		const inRange = (v: string, r: Record<string, string>) =>
			(r.gt === undefined || v > r.gt) && (r.gte === undefined || v >= r.gte) && (r.lt === undefined || v < r.lt) && (r.lte === undefined || v <= r.lte);
		const ctx = {
			settings: { list: async () => [{ key: "identity", value: identity }] },
			kv: { get: async () => [], set: async () => {} },
			bylines: { list: async () => ({ items: [], hasMore: false }) },
			storage: {
				credentials: {
					query: async ({ where }: { where?: { dateExpires?: Record<string, string> } }) => {
						if (!where?.dateExpires) throw new Error("the widget must query by expiry date");
						const items = stored.filter((s) => inRange(s.data.dateExpires, where.dateExpires!));
						scanned += items.length;
						return { items, hasMore: false };
					},
				},
			},
		} as never;
		const widget = JSON.stringify(await renderWidget(ctx));
		expect(widget).toContain("Renew next week");
		expect(scanned).toBe(1);
	});

	it("runs its range queries against real storage", async () => {
		const h = await setup();
		await h.fixtures.plugin.setting("identity", identity);
		const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
		const later = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
		await h.fixtures.plugin.storage("credentials", "never", { owner: "site-person", name: "Never expires", createdAt: "2020-01-01" });
		await h.fixtures.plugin.storage("credentials", "later", { owner: "site-person", name: "Expires later", dateExpires: later, createdAt: "2020-01-01" });
		await h.fixtures.plugin.storage("credentials", "soon", { owner: "site-person", name: "Due soon", dateExpires: soon, createdAt: "2020-01-01" });
		await h.fixtures.plugin.storage("credentials", "gone", { owner: "site-person", name: "Lapsed", dateExpires: "2025-01-01", createdAt: "2020-01-01" });
		const widget = JSON.stringify(await h.admin.loadWidget("expiring"));
		expect(widget).toContain("Due soon");
		expect(widget).toContain("Lapsed");
		expect(widget).not.toContain("Never expires");
		expect(widget).not.toContain("Expires later");
		expect(widget.indexOf("Due soon")).toBeLessThan(widget.indexOf("Lapsed"));
	});
});

// ── Second follow-up: echoed values, UTF-8 size, filtered scans ──

describe("a refused form", () => {
	it("gives back every valid field exactly, so correcting one error loses nothing", async () => {
		const h = await setup();
		const topics = Array.from({ length: 50 }, (_, i) => `${i}: ${"x".repeat(190)}`).join("\n");
		const profiles = Array.from({ length: 50 }, (_, i) => `https://example.com/${"p".repeat(250)}/${i}`).join("\n");
		const values = { mode: "person", timeZone: "UTC", person_name: "Alex", person_knowsAbout: topics, person_sameAs: profiles };
		const refused = (await h.admin.submit("/identity", "save_identity", { ...values, timeZone: "Invalid/Zone" }, { blockId: "identity" })) as unknown as {
			toast?: { type: string };
			blocks: Node[];
		};
		expect(refused.toast?.type).toBe("error");
		const fields = (refused.blocks.find((b) => b.type === "form") as { fields: Array<{ action_id: string; initial_value: unknown }> }).fields;
		const echoed = Object.fromEntries(fields.map((f) => [f.action_id, f.initial_value]));
		expect(echoed.person_knowsAbout).toBe(topics);
		expect(echoed.person_sameAs).toBe(profiles);

		await h.admin.submit("/identity", "save_identity", { ...echoed, timeZone: "UTC" }, { blockId: "identity" });
		const saved = (await h.inspect.setting("identity")) as { person: { knowsAbout: string[]; sameAs: string[] } };
		expect(saved.person.knowsAbout).toHaveLength(50);
		expect(saved.person.sameAs).toHaveLength(50);
	});

	it("shows the stored mode, not an unknown submitted one", async () => {
		const h = await setup();
		const r = (await h.admin.submit("/identity", "save_identity", { mode: "nonsense", timeZone: "UTC" }, { blockId: "identity" })) as {
			toast?: { type: string };
		};
		expect(r.toast?.type).toBe("error");
	});

	it("gives back an invalid date on the credential form", async () => {
		const h = await setup();
		const r = (await h.admin.submit("/credentials", "save_credential", { name: "Licence", dateExpires: "2026-02-30" }, {
			blockId: "cred|site-person|new",
		})) as { toast?: { type: string } };
		expect(r.toast?.type).toBe("error");
	});
});

describe("list fields are measured in UTF-8 bytes", () => {
	it("refuses a list too large to render, though every line is within its limits", async () => {
		const h = await setup();
		const urls = Array.from({ length: 50 }, (_, i) => `https://example.com/${"漢".repeat(450)}/${i}`).join("\n");
		const values = { mode: "person", timeZone: "UTC", person_name: "Alex", person_sameAs: urls };
		const r = (await h.admin.submit("/identity", "save_identity", values, { blockId: "identity" })) as { toast?: { type: string } };
		expect(r.toast?.type).toBe("error");
		expect(JSON.stringify(r)).toContain("too long in total");
		expect(await h.inspect.setting("identity")).toBeFalsy();
		await expect(h.admin.loadPage("/identity")).resolves.toHaveProperty("blocks");
	});

	it("renders the Identity form with every field at its limit", async () => {
		const full = (bytes: number, line: string) => {
			const lines: string[] = [];
			while (utf8Bytes([...lines, line].join("\n")) <= bytes && lines.length < LIMITS.listLines) lines.push(`${line}${lines.length}`);
			return lines.join("\n");
		};
		const values: Record<string, unknown> = { mode: "both", timeZone: "UTC", worksFor: true, founder: true, ownerGroup: "" };
		for (const side of ["person", "org"]) {
			values[`${side}_name`] = "漢".repeat(LIMITS.shortText);
			values[`${side}_description`] = "漢".repeat(LIMITS.longText);
			values[`${side}_sameAs`] = full(LIMITS.fieldBytes - 64, `https://example.com/${"漢".repeat(60)}/`);
			values[`${side}_knowsAbout`] = full(LIMITS.fieldBytes - 64, "漢".repeat(60));
		}
		values.person_jobTitle = "漢".repeat(LIMITS.shortText);
		values.person_url = values.person_image = values.org_url = values.org_logo = `https://example.com/${"x".repeat(LIMITS.url - 20)}`;
		const result = validateIdentity(values);
		expect(result.errors).toEqual([]);
		const site = largeSite(400);
		await site.ctx_set(result.value);
		const response = await renderIdentity(site.ctx);
		expect(valid(response)).toBe(true);
		expect(utf8Bytes(JSON.stringify(response))).toBeLessThan(200 * 1024);
	});
});

describe("expiry widget with many unlisted credentials", () => {
	function rangeStore(rows: Array<{ id: string; data: Record<string, unknown> }>) {
		return {
			query: async ({ where, orderBy, cursor, limit = 100 }: { where?: Record<string, Record<string, string>>; orderBy?: Record<string, string>; cursor?: string; limit?: number }) => {
				const r = where?.dateExpires ?? {};
				let found = rows.filter((row) => {
					const v = String(row.data.dateExpires ?? "");
					return (r.gt === undefined || v > r.gt) && (r.gte === undefined || v >= r.gte) && (r.lt === undefined || v < r.lt) && (r.lte === undefined || v <= r.lte);
				});
				if (orderBy?.dateExpires === "desc") found = [...found].reverse();
				const start = Number(cursor ?? 0);
				return { items: found.slice(start, start + limit), hasMore: start + limit < found.length, cursor: String(start + limit) };
			},
		};
	}
	const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
	const ctxWith = (rows: Array<{ id: string; data: Record<string, unknown> }>) =>
		({
			settings: { list: async () => [{ key: "identity", value: identity }] },
			kv: { get: async () => [], set: async () => {} },
			bylines: { list: async () => ({ items: [], hasMore: false }) },
			storage: { credentials: rangeStore(rows) },
		}) as never;

	it("reads past hidden ones to the renewal behind them", async () => {
		const rows = Array.from({ length: 1000 }, (_, i) => ({
			id: `h${i}`,
			data: { owner: "site-person", name: "Hidden", published: false, dateExpires: day(1), createdAt: "2020" },
		}));
		rows.push({ id: "due", data: { owner: "site-person", name: "Renew next week", published: true, dateExpires: day(7), createdAt: "2021" } });
		const widget = JSON.stringify(await renderWidget(ctxWith(rows)));
		expect(widget).toContain("Renew next week");
		expect(widget).not.toContain("Nothing expiring");
	});

	it("says it could not check everything rather than giving an all-clear", async () => {
		const rows = Array.from({ length: 2500 }, (_, i) => ({
			id: `h${i}`,
			data: { owner: "site-person", name: "Hidden", published: false, dateExpires: day(1), createdAt: "2020" },
		}));
		rows.push({ id: "due", data: { owner: "site-person", name: "Renew next week", published: true, dateExpires: day(7), createdAt: "2021" } });
		const widget = JSON.stringify(await renderWidget(ctxWith(rows)));
		expect(widget).not.toContain("Nothing expiring");
		expect(widget).toContain("Not every credential was checked");
	});
});

describe("finding data kept for deleted bylines", () => {
	it("finds a credential-only group however many live credentials come first", async () => {
		const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `c${i}`, data: { owner: `group:g${String(Math.floor(i / 50)).padStart(3, "0")}`, name: "Live" } }));
		rows.push({ id: "tail", data: { owner: "group:zz-deleted", name: "Kept licence" } });
		let queries = 0;
		const ctx = {
			settings: { list: async () => [{ key: "identity", value: identity }] },
			kv: { get: async () => [], set: async () => {} },
			bylines: {
				list: async () => ({
					items: Array.from({ length: 100 }, (_, i) => {
						const g = `g${String(i).padStart(3, "0")}`;
						return { id: g, translationGroup: g, displayName: `Person ${i}`, slug: `p${i}` };
					}),
					hasMore: false,
				}),
			},
			storage: {
				people: { query: async () => ({ items: [], hasMore: false }) },
				credentials: {
					query: async ({ where, orderBy, limit = 100 }: { where?: Record<string, unknown>; orderBy?: Record<string, string>; limit?: number }) => {
						const owner = where?.owner as { gt?: string; lt?: string; in?: string[] } | string | undefined;
						let found = rows.filter((r) =>
							typeof owner === "string"
								? r.data.owner === owner
								: owner?.in
									? owner.in.includes(r.data.owner)
									: (owner?.gt === undefined || r.data.owner > owner.gt) && (owner?.lt === undefined || r.data.owner < owner.lt),
						);
						if (orderBy?.owner) {
							queries++;
							found = [...found].sort((a, b) => a.data.owner.localeCompare(b.data.owner));
						}
						return { items: found.slice(0, limit), hasMore: found.length > limit, cursor: "" };
					},
				},
			},
		} as never;
		const page = JSON.stringify(await renderPeople(ctx));
		expect(page).toContain("zz-deleted");
		expect(page).not.toContain("may not be listed");
		expect(queries).toBeLessThanOrEqual(51);
	});

	it("runs the owner scan against real storage", async () => {
		const h = await setup();
		const { group } = await postBySam(h);
		await h.fixtures.plugin.storage("credentials", "live", { owner: `group:${group}`, name: "Live", createdAt: "2020" });
		await h.fixtures.plugin.storage("credentials", "gone", { owner: "group:deleted-one", name: "Kept", createdAt: "2020" });
		await h.fixtures.plugin.storage("credentials", "site", { owner: "site-person", name: "Site", createdAt: "2020" });
		const page = JSON.stringify(await h.admin.loadPage("/people"));
		expect(page).toContain("Data kept for 1 deleted byline");
		expect(page).toContain("deleted-one");
	});

	it("lists nothing, and says so, when the byline listing was cut short", async () => {
		const ctx = {
			settings: { list: async () => [{ key: "identity", value: identity }] },
			kv: { get: async () => [], set: async () => {} },
			bylines: { list: async ({ cursor }: { cursor?: string } = {}) => ({ items: [{ id: `b${cursor ?? 0}`, translationGroup: `b${cursor ?? 0}`, displayName: "B", slug: "b" }], hasMore: true, cursor: String(Number(cursor ?? 0) + 1) }) },
			storage: {
				people: { query: async () => ({ items: [{ id: "someone-live-past-the-bound", data: {} }], hasMore: false }) },
				credentials: { query: async () => ({ items: [], hasMore: false }) },
			},
		} as never;
		const page = JSON.stringify(await renderPeople(ctx));
		expect(page).not.toContain("someone-live-past-the-bound");
		expect(page).toContain("may not be listed");
	});
});
