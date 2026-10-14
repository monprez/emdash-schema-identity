/**
 * Parity with the WordPress plugin. scripts/wp-parity.php runs the WP
 * plugin's own builders on fixtures/wp-parity/input.json and saves
 * wp-output.json; this test runs ours on the same input and compares.
 *
 * The only allowed difference is deliberate: a pending *person*
 * credential (issue date still ahead) is published by WordPress and withheld
 * here, because hasCredential means a credential already awarded.
 *
 * Regenerate after changing either plugin:
 *   php scripts/wp-parity.php <path to a Monprez Schema Identity checkout>
 */

import { describe, expect, it } from "vitest";

import { buildCredentials, credentialStatus, type CredentialRow } from "../src/credentials.js";
import { buildGraph } from "../src/graph.js";
import input from "./fixtures/wp-parity/input.json";
import wp from "./fixtures/wp-parity/wp-output.json";

type WpRow = (typeof input.rows)[number] & Partial<Record<"issuer" | "date_issued" | "date_expires" | "cert_url" | "badge_url" | "cert_number", string>>;

/** WP's stored field names → ours. A translation of storage, not of behaviour. */
const toRow = (r: WpRow): CredentialRow => ({
	name: r.name,
	issuer: r.issuer,
	dateIssued: r.date_issued,
	dateExpires: r.date_expires,
	url: r.cert_url,
	badgeUrl: r.badge_url,
	certNumber: r.cert_number,
});

const rows = (input.rows as WpRow[]).map(toRow);
const pendingNames = new Set(rows.filter((r) => credentialStatus(r, input.today) === "pending").map((r) => r.name));
const withoutPending = (nodes: Array<Record<string, unknown>>) => nodes.filter((n) => !pendingNames.has(n.name as string));

describe("parity with the WordPress plugin", () => {
	it("was generated from the WordPress plugin", () => {
		expect(wp.source).toMatch(/^Monprez Schema Identity \d/);
		expect(pendingNames.size).toBeGreaterThan(0);
	});

	it("builds identical organisation certifications", () => {
		expect(buildCredentials(rows, "certification", input.today)).toEqual(wp.certification);
	});

	it("builds identical person credentials, except the deliberate pending rule", () => {
		expect(buildCredentials(rows, "credential", input.today)).toEqual(withoutPending(wp.credential));
		expect(wp.credential.length).toBeGreaterThan(withoutPending(wp.credential).length);
	});

	it("builds the same Person node", () => {
		const p = input.person;
		const graph = buildGraph({
			today: input.today,
			site: {
				mode: "person",
				person: {
					name: p.name,
					jobTitle: p.job_title,
					description: p.description,
					url: p.url,
					image: p.image_url,
					// WP stores LinkedIn separately and a comma-separated topic string.
					sameAs: [p.linkedin_url, ...p.same_as],
					knowsAbout: p.knows_about.split(","),
					credentials: rows,
				},
			},
			credits: [],
			page: { url: "https://example.com/", siteUrl: "https://example.com", isArticle: false },
		});
		const ours = (graph["@graph"] as Array<Record<string, unknown>>).find((n) => n["@type"] === "Person");
		expect(ours).toEqual({ ...wp.person, hasCredential: withoutPending(wp.person.hasCredential) });
	});
});
