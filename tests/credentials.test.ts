import { describe, expect, it } from "vitest";

import {
	buildCredentials,
	credentialStatus,
	isPublishable,
	todayIn,
	validYmd,
	type CredentialRow,
} from "../src/credentials.js";

describe("validYmd", () => {
	it("accepts real calendar dates only", () => {
		expect(validYmd("2024-02-29")).toBe("2024-02-29");
		expect(validYmd("2026-02-29")).toBe("");
		expect(validYmd("2026-02-30")).toBe("");
		expect(validYmd("2026-13-01")).toBe("");
		expect(validYmd("0000-01-01")).toBe("");
	});

	it("rejects anything that is not strictly YYYY-MM-DD", () => {
		for (const bad of ["2026-1-01", "2026-01-01\n", " 2026-01-01", "2026-01-01T00:00", "2026-01-01\u0000", "", 20260101, null, undefined, {}]) {
			expect(validYmd(bad)).toBe("");
		}
	});
});

describe("credentialStatus", () => {
	const today = "2026-09-30";
	const row = (r: Partial<CredentialRow>): CredentialRow => ({ name: "X", ...r });

	it("is active on its expiry date and expired the day after", () => {
		expect(credentialStatus(row({ dateExpires: "2026-09-30" }), today)).toBe("active");
		expect(credentialStatus(row({ dateExpires: "2026-09-29" }), today)).toBe("expired");
	});

	it("is pending until its issue date", () => {
		expect(credentialStatus(row({ dateIssued: "2026-10-01" }), today)).toBe("pending");
		expect(credentialStatus(row({ dateIssued: "2026-09-30" }), today)).toBe("active");
	});

	it("rejects unusable dates rather than repairing them", () => {
		expect(credentialStatus(row({ dateExpires: "2026-02-30" }), today)).toBe("invalid");
		expect(credentialStatus(row({ dateIssued: "garbage" }), today)).toBe("invalid");
		// Valid for no days.
		expect(credentialStatus(row({ dateIssued: "2025-01-01", dateExpires: "2025-01-01" }), today)).toBe("invalid");
		expect(credentialStatus(row({ dateIssued: "2025-01-02", dateExpires: "2025-01-01" }), today)).toBe("invalid");
	});

	it("treats absent dates as open-ended", () => {
		expect(credentialStatus(row({}), today)).toBe("active");
	});
});

describe("isPublishable", () => {
	const today = "2026-09-30";

	it("publishes a pending certification but not a pending person credential", () => {
		const pending: CredentialRow = { name: "X", dateIssued: "2027-01-01" };
		expect(isPublishable(pending, "certification", today)).toBe(true);
		expect(isPublishable(pending, "credential", today)).toBe(false);
	});

	it("honours the Published switch whatever the dates say", () => {
		expect(isPublishable({ name: "X", published: false }, "credential", today)).toBe(false);
	});

	it("needs a name", () => {
		expect(isPublishable({ name: "  " }, "credential", today)).toBe(false);
	});
});

describe("expiry at midnight with no save", () => {
	const rows: CredentialRow[] = [{ name: "Licence", dateIssued: "2024-10-01", dateExpires: "2026-09-30" }];

	it("drops the credential when the site's day changes", () => {
		const lastMinute = new Date("2026-09-30T21:59:00Z"); // 23:59 in Stockholm (CEST)
		const nextMinute = new Date("2026-09-30T22:00:00Z"); // 00:00 on 1 October
		expect(buildCredentials(rows, "credential", todayIn("Europe/Stockholm", lastMinute))).toHaveLength(1);
		expect(buildCredentials(rows, "credential", todayIn("Europe/Stockholm", nextMinute))).toHaveLength(0);
	});

	it("uses the configured zone, not UTC", () => {
		const now = new Date("2026-09-30T22:30:00Z");
		expect(todayIn("Europe/Stockholm", now)).toBe("2026-10-01");
		expect(todayIn("UTC", now)).toBe("2026-09-30");
	});

	it("falls back to UTC for an unknown zone instead of throwing", () => {
		expect(todayIn("Not/AZone", new Date("2026-09-30T22:30:00Z"))).toBe("2026-09-30");
	});
});

describe("buildCredentials", () => {
	it("asserts CertificationActive only when active", () => {
		const [active, pending] = buildCredentials(
			[
				{ name: "ISO 9001", issuer: "Body", certNumber: "N1", dateIssued: "2024-01-01" },
				{ name: "ISO 14001", dateIssued: "2027-01-01" },
			],
			"certification",
			"2026-09-30",
		);
		expect(active).toMatchObject({
			"@type": "Certification",
			issuedBy: { "@type": "Organization", name: "Body" },
			certificationIdentification: "N1",
			certificationStatus: "https://schema.org/CertificationActive",
			validFrom: "2024-01-01",
		});
		expect(pending).not.toHaveProperty("certificationStatus");
		expect(pending).toHaveProperty("validFrom", "2027-01-01");
	});

	it("uses recognizedBy and dateCreated for a person's credential, and expires not validUntil", () => {
		const [node] = buildCredentials(
			[{ name: "MCSP", issuer: "CSP", dateIssued: "2019-06-01", dateExpires: "2030-01-01" }],
			"credential",
			"2026-09-30",
		);
		expect(node).toEqual({
			"@type": "EducationalOccupationalCredential",
			name: "MCSP",
			recognizedBy: { "@type": "Organization", name: "CSP" },
			dateCreated: "2019-06-01",
			expires: "2030-01-01",
		});
	});
});
