/**
 * Credential date and status rules.
 *
 * Ported from the WordPress plugin (`Schema_Identity::valid_ymd()`,
 * `date_is_unusable()`, `credential_dates_usable()`, `credential_status()`),
 * with two deliberate changes: a pending *person* credential
 * is not published, and every row has a `published` switch kept apart from its
 * date status.
 *
 * Status is never cached. The graph builder, the admin badges and the expiry
 * widget all call `credentialStatus()` with one `today` per request, so an
 * expiry takes effect at midnight without a save.
 *
 * No EmDash imports, no I/O.
 */

export interface CredentialRow {
	/** Stable row ID. Absent for rows that were never stored. */
	id?: string;
	name: string;
	issuer?: string;
	/** YYYY-MM-DD */
	dateIssued?: string;
	/** YYYY-MM-DD. Absent means "never expires". */
	dateExpires?: string;
	/** Where the credential can be verified. */
	url?: string;
	badgeUrl?: string;
	/** Certificate number; organisation certifications only. */
	certNumber?: string;
	/** Defaults to true. False hides the row whatever its dates say. */
	published?: boolean;
}

export type CredentialStatus = "invalid" | "expired" | "pending" | "active";

/** `credential` = a person's, under hasCredential. `certification` = an organisation's, under hasCertification. */
export type CredentialFormat = "credential" | "certification";

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The date if it is a real calendar date in strict YYYY-MM-DD form, else "".
 * A shape check then a calendar check, never a date parser: parsers accept
 * too much ("2026-02-30" rolls over to March).
 */
export function validYmd(value: unknown): string {
	if (typeof value !== "string") return "";
	const m = YMD.exec(value);
	if (!m) return "";
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	// Year 0 is rejected, matching PHP's checkdate().
	if (year < 1 || month < 1 || month > 12 || day < 1) return "";
	const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return day <= daysInMonth ? value : "";
}

/** Set but unreadable. Not the same as unset: "" and undefined are usable (absent). */
export function dateIsUnusable(value: unknown): boolean {
	if (value === undefined || value === null || value === "") return false;
	return validYmd(value) === "";
}

/**
 * Whether a row's dates can be published at all. Either date set but
 * unreadable, or an expiry on or before the issue date (a credential valid
 * for no days), and the row is unusable. It is rejected, not repaired:
 * dropping a bad expiry would turn a lapsed credential into a permanent one.
 */
export function credentialDatesUsable(row: CredentialRow): boolean {
	if (dateIsUnusable(row.dateIssued) || dateIsUnusable(row.dateExpires)) return false;
	const issued = validYmd(row.dateIssued);
	const expires = validYmd(row.dateExpires);
	return !(issued !== "" && expires !== "" && expires <= issued);
}

/**
 * The single answer to "what state is this credential in on `today`".
 * A credential is still active on its expiry date and expired from the next day.
 */
export function credentialStatus(row: CredentialRow, today: string): CredentialStatus {
	if (!credentialDatesUsable(row)) return "invalid";
	const expires = validYmd(row.dateExpires);
	if (expires !== "" && expires < today) return "expired";
	const issued = validYmd(row.dateIssued);
	if (issued !== "" && issued > today) return "pending";
	return "active";
}

/**
 * Whether a row goes into the graph. Needs a name, the Published switch on,
 * and a date status its format allows: an organisation certification that is
 * pending is "issued, in force later", which `Certification` can say with a
 * future validFrom; a person's pending credential has not been awarded yet.
 */
export function isPublishable(row: CredentialRow, format: CredentialFormat, today: string): boolean {
	if (!row.name?.trim() || row.published === false) return false;
	const status = credentialStatus(row, today);
	if (status === "active") return true;
	return status === "pending" && format === "certification";
}

/**
 * Today's date as YYYY-MM-DD in a time zone. Computed once per request and
 * passed to everything that asks for a status, so they cannot disagree.
 * An unknown time zone falls back to UTC rather than throwing on a public page.
 */
export function todayIn(timeZone: string, now: Date = new Date()): string {
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(now);
	} catch {
		return now.toISOString().slice(0, 10);
	}
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Credential or Certification nodes for the rows that are publishable on `today`. */
export function buildCredentials(
	rows: readonly CredentialRow[],
	format: CredentialFormat,
	today: string,
): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const row of rows) {
		if (!isPublishable(row, format, today)) continue;
		const issued = validYmd(row.dateIssued);
		const expires = validYmd(row.dateExpires);
		const node: Record<string, unknown> =
			format === "certification"
				? { "@type": "Certification", name: row.name.trim() }
				: { "@type": "EducationalOccupationalCredential", name: row.name.trim() };

		if (row.issuer?.trim()) {
			// Certification: the body issues it. A person's credential is
			// recognised by the body (EducationalOccupationalCredential has no issuedBy).
			node[format === "certification" ? "issuedBy" : "recognizedBy"] = {
				"@type": "Organization",
				name: row.issuer.trim(),
			};
		}
		if (format === "certification") {
			if (row.certNumber?.trim()) node.certificationIdentification = row.certNumber.trim();
			// Pending rows reach here only as certifications: say nothing about
			// status rather than CertificationInactive, which reads as lapsed.
			if (credentialStatus(row, today) === "active") {
				node.certificationStatus = "https://schema.org/CertificationActive";
			}
			if (issued) node.validFrom = issued;
		} else if (issued) {
			node.dateCreated = issued;
		}
		// `expires`, not `validUntil`: validUntil exists only on Permit.
		if (expires) node.expires = expires;
		if (row.url?.trim()) node.url = row.url.trim();
		if (row.badgeUrl?.trim()) node.image = row.badgeUrl.trim();
		out.push(node);
	}
	return out;
}
