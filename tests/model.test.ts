import { describe, expect, it } from "vitest";

import {
	normalizeIdentity,
	normalizeRoleMap,
	parseLines,
	roleFor,
	validateCredential,
	validateIdentity,
	validatePerson,
} from "../src/model.js";

describe("normalizers never trust stored shapes", () => {
	it("turns garbage into a usable identity", () => {
		for (const raw of [null, "x", 42, [], { mode: "nonsense", person: "x", organization: [1] }]) {
			const id = normalizeIdentity(raw);
			expect(id.mode).toBe("person");
			expect(id.timeZone).toBe("UTC");
			expect(id.person.sameAs).toEqual([]);
			expect(id.organization.knowsAbout).toEqual([]);
		}
	});

	it("keeps only valid role choices", () => {
		expect(normalizeRoleMap({ "Reviewed by": "reviewer", Photos: "photographer", x: 1 })).toEqual({ "Reviewed by": "reviewer" });
	});
});

describe("role policy", () => {
	it("treats no label as author and an unknown label as unmapped", () => {
		expect(roleFor(null, {})).toBe("author");
		expect(roleFor("  ", {})).toBe("author");
		expect(roleFor("Guest essay", {})).toBe("unmapped");
		expect(roleFor("Guest essay", { "Guest essay": "author" })).toBe("author");
	});
});

describe("parseLines", () => {
	it("trims, drops blanks and duplicates", () => {
		expect(parseLines(" a \n\nb\r\na\n")).toEqual(["a", "b"]);
	});
});

describe("validateIdentity", () => {
	const base = { mode: "both", timeZone: "Europe/Stockholm", person_name: "Alex", org_name: "Org" };

	it("accepts a complete form", () => {
		const r = validateIdentity({ ...base, person_sameAs: "https://linkedin.com/in/a\n", founder: true });
		expect(r.errors).toEqual([]);
		expect(r.value?.person.sameAs).toEqual(["https://linkedin.com/in/a"]);
		expect(r.value?.founder).toBe(true);
		expect(r.value?.worksFor).toBe(false);
	});

	it("refuses a bad time zone and non-web addresses, saying which", () => {
		const r = validateIdentity({ ...base, timeZone: "Mars/Olympus", person_url: "javascript:alert(1)", org_sameAs: "linkedin.com/x" });
		expect(r.value).toBeUndefined();
		expect(r.errors.join(" ")).toMatch(/time zone/);
		expect(r.errors.join(" ")).toMatch(/Person web address/);
		expect(r.errors.join(" ")).toMatch(/linkedin\.com\/x/);
	});

	it("refuses an unknown mode", () => {
		expect(validateIdentity({ ...base, mode: "robot" }).value).toBeUndefined();
	});
});

describe("validatePerson", () => {
	it("caps list length", () => {
		const r = validatePerson({ knowsAbout: Array.from({ length: 60 }, (_, i) => `t${i}`).join("\n") });
		expect(r.errors.join(" ")).toMatch(/more than 50/);
	});
});

describe("validateCredential", () => {
	it("requires a name", () => {
		expect(validateCredential({ name: " " }, false).errors).toContain("Name is required.");
	});

	it("says which date is bad instead of repairing it", () => {
		const r = validateCredential({ name: "X", dateIssued: "2026-02-30" }, false);
		expect(r.value).toBeUndefined();
		expect(r.errors).toContain("Issue date is not a real date (use YYYY-MM-DD).");
	});

	it("refuses an expiry on or before the issue date", () => {
		const r = validateCredential({ name: "X", dateIssued: "2026-01-01", dateExpires: "2026-01-01" }, false);
		expect(r.errors).toContain("The expiry date must be after the issue date.");
	});

	it("keeps the certificate number only for certifications", () => {
		expect(validateCredential({ name: "X", certNumber: "N1" }, true).value?.certNumber).toBe("N1");
		expect(validateCredential({ name: "X", certNumber: "N1" }, false).value?.certNumber).toBeUndefined();
	});

	it("defaults Published to on", () => {
		expect(validateCredential({ name: "X" }, false).value?.published).toBe(true);
		expect(validateCredential({ name: "X", published: false }, false).value?.published).toBe(false);
	});
});
