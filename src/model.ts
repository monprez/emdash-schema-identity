/**
 * Stored shapes, their normalisers, and form validation. Pure: no EmDash
 * imports, no I/O.
 *
 * Every read of stored data goes through a normaliser that guarantees the
 * shape the rest of the plugin indexes into, because stored values can come
 * from older versions or be written by hand. Normalisers never validate for
 * the user; that is what the form validators are for.
 */

import { credentialDatesUsable, dateIsUnusable, validYmd, type CredentialRow } from "./credentials.js";
import type { CreditRole, EntityMode } from "./graph.js";

/**
 * Admin pages are one Block Kit response, capped by EmDash at 2,000 nodes,
 * 256 KiB and 64 KiB (UTF-8) per string. These limits keep every page under
 * them with room to spare (measured: the Credentials page with 50 + 50 rows is
 * ~1,400 nodes; Roles with 60 labels ~1,700). Every text field is bounded
 * before it is saved, because a stored value too large to render would lock
 * its form; sizes that reach a response are counted in UTF-8 bytes, not
 * characters. The Identity form with every field at its limit and 400 bylines
 * is about 91 KiB (tested).
 */
export const LIMITS = {
	/** Adding a credential stops here. Reads allow more (see store.ts). */
	credentialsPerOwner: 50,
	/** Mapped and recorded-unmapped role labels together. */
	roleLabels: 60,
	listLines: 50,
	shortText: 200,
	longText: 2000,
	lineText: 200,
	url: 1000,
	/** A multi-line field as typed, in UTF-8 bytes (Block Kit counts bytes). */
	fieldBytes: 16 * 1024,
} as const;

const encoder = new TextEncoder();
export const utf8Bytes = (s: string): number => encoder.encode(s).length;

/** `s` cut to at most `max` UTF-8 bytes, on a character boundary. */
export function fitBytes(s: string, max: number): string {
	if (s.length * 3 <= max || utf8Bytes(s) <= max) return s;
	let used = 0;
	let end = 0;
	for (const ch of s) {
		const size = utf8Bytes(ch);
		if (used + size > max) break;
		used += size;
		end += ch.length;
	}
	return s.slice(0, end);
}

/** A submitted value quoted back in an error message, cut short. */
export const quote = (v: string, max = 80): string => (v.length > max ? `${v.slice(0, max)}…` : v);

// ── Identity (ctx.settings "identity") ───────────────────────────

export interface IdentitySettings {
	mode: EntityMode;
	timeZone: string;
	person: {
		name: string;
		jobTitle: string;
		description: string;
		url: string;
		image: string;
		sameAs: string[];
		knowsAbout: string[];
	};
	organization: {
		name: string;
		url: string;
		logo: string;
		description: string;
		sameAs: string[];
		knowsAbout: string[];
	};
	worksFor: boolean;
	founder: boolean;
	/** translationGroup of the byline that is the site Person, or "". */
	ownerGroup: string;
}

const MODES: readonly EntityMode[] = ["person", "organization", "both"];

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const obj = (v: unknown): Record<string, unknown> =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/**
 * A stored or submitted date. Absent stays absent; anything else that is not
 * a string becomes an unreadable marker, so the status rules reject the row
 * instead of reading a lost expiry as "never expires".
 */
const dateValue = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : "invalid");

export function normalizeIdentity(raw: unknown): IdentitySettings {
	const r = obj(raw);
	const p = obj(r.person);
	const o = obj(r.organization);
	return {
		mode: MODES.includes(r.mode as EntityMode) ? (r.mode as EntityMode) : "person",
		timeZone: str(r.timeZone) || "UTC",
		person: {
			name: str(p.name),
			jobTitle: str(p.jobTitle),
			description: str(p.description),
			url: str(p.url),
			image: str(p.image),
			sameAs: strList(p.sameAs),
			knowsAbout: strList(p.knowsAbout),
		},
		organization: {
			name: str(o.name),
			url: str(o.url),
			logo: str(o.logo),
			description: str(o.description),
			sameAs: strList(o.sameAs),
			knowsAbout: strList(o.knowsAbout),
		},
		worksFor: r.worksFor === true,
		founder: r.founder === true,
		ownerGroup: str(r.ownerGroup),
	};
}

/**
 * The byline group that merges into the site Person, or "". Only when the
 * graph emits a site Person (a person mode and a name) does the owner byline
 * share its @id and data; otherwise that byline is an ordinary person with
 * its own profile. The graph, the public route and the People page all ask this.
 */
export function mergedOwnerGroup(identity: IdentitySettings): string {
	return identity.mode !== "organization" && identity.person.name.trim() !== "" ? identity.ownerGroup : "";
}

// ── Role mapping (ctx.settings "roles") ──────────────────────────

export type RoleChoice = CreditRole | "ignore";
export const ROLE_CHOICES: readonly RoleChoice[] = ["author", "editor", "reviewer", "contributor", "ignore"];

/** Labels are free text, so the map has no prototype: "constructor" is a label, not a method. */
export function normalizeRoleMap(raw: unknown): Record<string, RoleChoice> {
	const out: Record<string, RoleChoice> = Object.create(null);
	for (const [label, role] of Object.entries(obj(raw))) {
		if (ROLE_CHOICES.includes(role as RoleChoice)) out[label] = role as RoleChoice;
	}
	return out;
}

/** No label is an author; a label counts only once it is mapped. */
export function roleFor(label: string | null | undefined, map: Record<string, RoleChoice>): RoleChoice | "unmapped" {
	const key = label?.trim() ?? "";
	if (key === "") return "author";
	const role = Object.hasOwn(map, key) ? map[key] : undefined;
	return role && ROLE_CHOICES.includes(role) ? role : "unmapped";
}

// ── People (storage "people", id = translationGroup) ─────────────

export interface PersonRecord {
	group: string;
	jobTitle: string;
	image: string;
	sameAs: string[];
	knowsAbout: string[];
	worksFor: boolean;
	updatedAt: string;
}

export function normalizePerson(raw: unknown, group: string): PersonRecord {
	const r = obj(raw);
	return {
		group,
		jobTitle: str(r.jobTitle),
		image: str(r.image),
		sameAs: strList(r.sameAs),
		knowsAbout: strList(r.knowsAbout),
		worksFor: r.worksFor === true,
		updatedAt: str(r.updatedAt),
	};
}

// ── Credentials (storage "credentials", id = generated) ──────────

/** Who a credential belongs to. */
export const OWNER_SITE_PERSON = "site-person";
export const OWNER_ORGANIZATION = "organization";
export const ownerForGroup = (group: string) => `group:${group}`;
export const groupFromOwner = (owner: string) => (owner.startsWith("group:") ? owner.slice(6) : null);

export interface CredentialRecord extends CredentialRow {
	id: string;
	owner: string;
	createdAt: string;
	updatedAt: string;
}

export function normalizeCredential(raw: unknown, id: string): CredentialRecord {
	const r = obj(raw);
	return {
		id,
		owner: str(r.owner),
		name: str(r.name),
		issuer: str(r.issuer),
		dateIssued: dateValue(r.dateIssued),
		dateExpires: dateValue(r.dateExpires),
		url: str(r.url),
		badgeUrl: str(r.badgeUrl),
		certNumber: str(r.certNumber),
		published: r.published !== false,
		createdAt: str(r.createdAt),
		updatedAt: str(r.updatedAt),
	};
}

// ── Form validation ──────────────────────────────────────────────

export interface Validated<T> {
	value?: T;
	errors: string[];
	/**
	 * The form's values to show again after an error, each within its field's
	 * budget: a value that could be accepted comes back exactly, and an
	 * oversized one comes back cut to its limit, with an error saying so.
	 */
	echo: Record<string, string>;
}

export function isHttpUrl(value: string): boolean {
	if (!/^https?:\/\//i.test(value)) return false;
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

export function isTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/** One entry per line, trimmed, blanks and duplicates removed. */
export function parseLines(text: unknown): string[] {
	const out: string[] = [];
	for (const line of str(text).split(/\r?\n/)) {
		const s = line.trim();
		if (s && !out.includes(s)) out.push(s);
	}
	return out;
}

class Checker {
	errors: string[] = [];
	echo: Record<string, string> = {};
	/** A one-line value of at most `max` characters: 4 UTF-8 bytes each at most. */
	keep(key: string, value: string, maxChars: number): void {
		this.echo[key] = fitBytes(value, maxChars * 4);
	}
	/** A multi-line field, checked as typed so the echo of an accepted value is never cut. */
	block(values: Record<string, unknown>, key: string, label: string): string[] | null {
		const raw = str(values[key]);
		this.echo[key] = fitBytes(raw, LIMITS.fieldBytes);
		if (utf8Bytes(raw) <= LIMITS.fieldBytes) return parseLines(raw);
		this.errors.push(`${label} is too long in total (the limit is ${LIMITS.fieldBytes / 1024} KB).`);
		return null;
	}
	text(values: Record<string, unknown>, key: string, label: string, max: number = LIMITS.shortText): string {
		const v = str(values[key]).trim();
		this.keep(key, v, max * 2);
		if (v.length > max) this.errors.push(`${label} is longer than ${max} characters.`);
		return v;
	}
	url(values: Record<string, unknown>, key: string, label: string): string {
		const v = str(values[key]).trim();
		this.keep(key, v, LIMITS.url * 2);
		if (v.length > LIMITS.url) this.errors.push(`${label} is longer than ${LIMITS.url} characters.`);
		else if (v && !isHttpUrl(v)) this.errors.push(`${label} must be a full web address starting with https://.`);
		return v;
	}
	urls(values: Record<string, unknown>, key: string, label: string): string[] {
		const lines = this.block(values, key, label);
		if (!lines) return [];
		if (lines.some((l) => l.length > LIMITS.url)) {
			this.errors.push(`${label}: each web address must be under ${LIMITS.url} characters.`);
		}
		const bad = lines.filter((l) => l.length <= LIMITS.url && !isHttpUrl(l));
		if (bad.length > 0) this.errors.push(`${label}: not a full web address: ${bad.slice(0, 3).map((b) => quote(b)).join(", ")}.`);
		if (lines.length > LIMITS.listLines) this.errors.push(`${label} has more than ${LIMITS.listLines} lines.`);
		return lines;
	}
	lines(values: Record<string, unknown>, key: string, label: string): string[] {
		const lines = this.block(values, key, label);
		if (!lines) return [];
		if (lines.length > LIMITS.listLines) this.errors.push(`${label} has more than ${LIMITS.listLines} lines.`);
		if (lines.some((l) => l.length > LIMITS.lineText)) {
			this.errors.push(`${label}: each line must be under ${LIMITS.lineText} characters.`);
		}
		return lines;
	}
}

/** Identity form → settings. Field names match the form's action_ids. */
export function validateIdentity(values: Record<string, unknown>): Validated<IdentitySettings> {
	const c = new Checker();
	const mode = str(values.mode) as EntityMode;
	if (!MODES.includes(mode)) c.errors.push("Choose whether the site is a person, an organization, or both.");
	const timeZone = str(values.timeZone).trim() || "UTC";
	if (timeZone.length > LIMITS.shortText || !isTimeZone(timeZone)) {
		c.errors.push(`"${quote(timeZone)}" is not a time zone. Use a name like Europe/Stockholm or UTC.`);
	}
	c.keep("timeZone", timeZone, LIMITS.shortText);
	const ownerGroup = str(values.ownerGroup).trim();
	c.echo.ownerGroup = /^[\w-]{0,128}$/.test(ownerGroup) ? ownerGroup : "";
	if (!c.echo.ownerGroup && ownerGroup) c.errors.push("Choose the person's byline from the list.");

	const value: IdentitySettings = {
		mode,
		timeZone,
		person: {
			name: c.text(values, "person_name", "Person name"),
			jobTitle: c.text(values, "person_jobTitle", "Job title"),
			description: c.text(values, "person_description", "Person description", LIMITS.longText),
			url: c.url(values, "person_url", "Person web address"),
			image: c.url(values, "person_image", "Person image"),
			sameAs: c.urls(values, "person_sameAs", "Person profiles"),
			knowsAbout: c.lines(values, "person_knowsAbout", "Person expertise"),
		},
		organization: {
			name: c.text(values, "org_name", "Organization name"),
			url: c.url(values, "org_url", "Organization web address"),
			logo: c.url(values, "org_logo", "Logo"),
			description: c.text(values, "org_description", "Organization description", LIMITS.longText),
			sameAs: c.urls(values, "org_sameAs", "Organization profiles"),
			knowsAbout: c.lines(values, "org_knowsAbout", "Organization expertise"),
		},
		worksFor: values.worksFor === true,
		founder: values.founder === true,
		ownerGroup,
	};
	return c.errors.length > 0 ? { errors: c.errors, echo: c.echo } : { value, errors: [], echo: c.echo };
}

/** Person profile form → record fields. */
export function validatePerson(
	values: Record<string, unknown>,
): Validated<Omit<PersonRecord, "group" | "updatedAt">> {
	const c = new Checker();
	const value = {
		jobTitle: c.text(values, "jobTitle", "Job title"),
		image: c.url(values, "image", "Image"),
		sameAs: c.urls(values, "sameAs", "Profiles"),
		knowsAbout: c.lines(values, "knowsAbout", "Expertise"),
		worksFor: values.worksFor === true,
	};
	return c.errors.length > 0 ? { errors: c.errors, echo: c.echo } : { value, errors: [], echo: c.echo };
}

/**
 * Credential form → row. Bad dates are refused with the reason, never
 * repaired: clearing a bad expiry would publish a lapsed
 * credential as permanent.
 */
export function validateCredential(values: Record<string, unknown>, withCertNumber: boolean): Validated<CredentialRow> {
	const c = new Checker();
	const name = c.text(values, "name", "Name");
	if (!name) c.errors.push("Name is required.");
	const dateIssued = dateValue(values.dateIssued).trim();
	const dateExpires = dateValue(values.dateExpires).trim();
	c.keep("dateIssued", dateIssued, 32);
	c.keep("dateExpires", dateExpires, 32);
	if (dateIsUnusable(dateIssued)) c.errors.push("Issue date is not a real date (use YYYY-MM-DD).");
	if (dateIsUnusable(dateExpires)) c.errors.push("Expiry date is not a real date (use YYYY-MM-DD).");
	const row: CredentialRow = {
		name,
		issuer: c.text(values, "issuer", "Issued by"),
		dateIssued: validYmd(dateIssued) || undefined,
		dateExpires: validYmd(dateExpires) || undefined,
		url: c.url(values, "url", "Verification link"),
		badgeUrl: c.url(values, "badgeUrl", "Badge image"),
		certNumber: withCertNumber ? c.text(values, "certNumber", "Certificate number") : undefined,
		published: values.published !== false,
	};
	if (c.errors.length === 0 && !credentialDatesUsable(row)) {
		c.errors.push("The expiry date must be after the issue date.");
	}
	return c.errors.length > 0 ? { errors: c.errors, echo: c.echo } : { value: row, errors: [], echo: c.echo };
}
