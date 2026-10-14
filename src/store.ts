/**
 * Everything that touches ctx.settings, ctx.storage and ctx.kv. Reads always
 * pass through the normalisers in model.ts.
 *
 * No cache of our own: a page render costs one settings list,
 * one byline lookup, one people read and one credentials query, and a cache
 * would add invalidation bugs for no measurable gain. Credential status is
 * never stored; it is computed per request.
 */

import type { PluginContext } from "emdash/plugin";

import {
	LIMITS,
	groupFromOwner,
	normalizeCredential,
	normalizeIdentity,
	normalizePerson,
	normalizeRoleMap,
	type CredentialRecord,
	type IdentitySettings,
	type PersonRecord,
	type RoleChoice,
} from "./model.js";
import type { CredentialRow } from "./credentials.js";

const SETTINGS_IDENTITY = "identity";
const SETTINGS_ROLES = "roles";
const KV_UNMAPPED = "state:unmappedRoles";
const KV_SCHEMA = "state:schemaVersion";
export const SCHEMA_VERSION = 1;

/** Every setting in one call: the render path's first read. */
export async function loadConfig(ctx: PluginContext): Promise<{
	identity: IdentitySettings;
	roles: Record<string, RoleChoice>;
}> {
	const all = await ctx.settings.list();
	const get = (key: string) => all.find((e) => e.key === key)?.value;
	return { identity: normalizeIdentity(get(SETTINGS_IDENTITY)), roles: normalizeRoleMap(get(SETTINGS_ROLES)) };
}

export async function saveIdentity(ctx: PluginContext, identity: IdentitySettings): Promise<void> {
	await ctx.settings.set(SETTINGS_IDENTITY, identity);
}

/** Saved as a plain object: the role map has no prototype, which the sandbox bridge cannot clone. */
export async function saveRoles(ctx: PluginContext, roles: Record<string, RoleChoice>): Promise<void> {
	await ctx.settings.set(SETTINGS_ROLES, Object.fromEntries(Object.entries(roles)));
}

// ── Unmapped role labels (recorded while rendering) ──────────────

export async function loadUnmappedLabels(ctx: PluginContext): Promise<string[]> {
	const v = await ctx.kv.get<unknown>(KV_UNMAPPED);
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Writes only when a label is new, so steady-state renders never write.
 * Mapped and unmapped labels share LIMITS.roleLabels, so the Roles page fits
 * in one response; past it, new labels are not recorded (and stay unmapped).
 */
export async function recordUnmappedLabels(ctx: PluginContext, labels: string[], mappedCount: number): Promise<void> {
	if (labels.length === 0) return;
	const seen = await loadUnmappedLabels(ctx);
	// A label too long to map from the Roles form is not recorded; it stays unmapped.
	const fresh = [...new Set(labels)].filter((l) => !seen.includes(l) && l.length <= LIMITS.shortText);
	const room = Math.max(0, LIMITS.roleLabels - mappedCount - seen.length);
	if (fresh.length > 0 && room > 0) await ctx.kv.set(KV_UNMAPPED, [...seen, ...fresh.slice(0, room)]);
}

export async function forgetUnmappedLabels(ctx: PluginContext, labels: string[]): Promise<void> {
	const seen = await loadUnmappedLabels(ctx);
	await ctx.kv.set(KV_UNMAPPED, seen.filter((l) => !labels.includes(l)));
}

// ── People ───────────────────────────────────────────────────────

export async function getPeople(ctx: PluginContext, groups: string[]): Promise<Map<string, PersonRecord>> {
	const out = new Map<string, PersonRecord>();
	if (groups.length === 0) return out;
	const rows = await ctx.storage.people!.getMany(groups);
	for (const [id, data] of rows) out.set(id, normalizePerson(data, id));
	return out;
}

export async function getPerson(ctx: PluginContext, group: string): Promise<PersonRecord> {
	return normalizePerson(await ctx.storage.people!.get(group), group);
}

export async function savePerson(ctx: PluginContext, record: Omit<PersonRecord, "updatedAt">): Promise<void> {
	await ctx.storage.people!.put(record.group, { ...record, updatedAt: new Date().toISOString() });
}

/**
 * Every group with a stored person record (admin only), for finding data kept
 * for deleted bylines. `complete` is false if it stopped at `max`.
 */
export async function peopleGroups(ctx: PluginContext, max = 5000): Promise<{ groups: string[]; complete: boolean }> {
	const groups: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await ctx.storage.people!.query({ limit: 100, cursor });
		for (const item of page.items) groups.push(item.id);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor && groups.length < max);
	return { groups, complete: !cursor };
}

// ── Credentials ──────────────────────────────────────────────────

/**
 * How many rows per owner a read will fetch: well above LIMITS.credentialsPerOwner,
 * which only stops *adding*. Rows past that limit (two saves racing the count,
 * or data written by hand) are still read and published, not dropped by age;
 * this bound only keeps a runaway collection from stalling the page.
 */
const READ_PER_OWNER = LIMITS.credentialsPerOwner * 4;

/** All credentials for these owners, oldest first, grouped by owner. */
export async function credentialsFor(
	ctx: PluginContext,
	owners: string[],
): Promise<Map<string, CredentialRecord[]>> {
	const out = new Map<string, CredentialRecord[]>(owners.map((o) => [o, []]));
	if (owners.length === 0) return out;
	let cursor: string | undefined;
	let fetched = 0;
	do {
		const page = await ctx.storage.credentials!.query({
			where: { owner: owners.length === 1 ? owners[0]! : { in: owners } },
			orderBy: { createdAt: "asc" },
			limit: 100,
			cursor,
		});
		for (const item of page.items) {
			const rec = normalizeCredential(item.data, item.id);
			out.get(rec.owner)?.push(rec);
		}
		fetched += page.items.length;
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor && fetched < owners.length * READ_PER_OWNER);
	return out;
}

export async function getCredential(ctx: PluginContext, id: string): Promise<CredentialRecord | null> {
	const raw = await ctx.storage.credentials!.get(id);
	return raw ? normalizeCredential(raw, id) : null;
}

export async function countCredentials(ctx: PluginContext, owner: string): Promise<number> {
	return ctx.storage.credentials!.count({ owner });
}

/** Create (id null) or update a credential. Returns its id, or an error message. */
export async function saveCredential(
	ctx: PluginContext,
	owner: string,
	id: string | null,
	row: CredentialRow,
): Promise<{ id: string } | { error: string }> {
	const now = new Date().toISOString();
	if (id) {
		const existing = await getCredential(ctx, id);
		if (!existing || existing.owner !== owner) return { error: "That credential no longer exists." };
		await ctx.storage.credentials!.put(id, { ...row, owner, createdAt: existing.createdAt, updatedAt: now });
		return { id };
	}
	if ((await countCredentials(ctx, owner)) >= LIMITS.credentialsPerOwner) {
		return { error: `There is a limit of ${LIMITS.credentialsPerOwner} credentials each.` };
	}
	const newId = crypto.randomUUID();
	await ctx.storage.credentials!.put(newId, { ...row, owner, createdAt: now, updatedAt: now });
	return { id: newId };
}

export async function deleteCredential(ctx: PluginContext, owner: string, id: string): Promise<boolean> {
	const existing = await getCredential(ctx, id);
	if (!existing || existing.owner !== owner) return false;
	return ctx.storage.credentials!.delete(id);
}

/**
 * Credentials whose expiry (YYYY-MM-DD) is in a range, in date order, from the
 * dateExpires index, keeping only those `keep` accepts. Reads until it has
 * `want` of them plus one (so `more` is known), the range runs out, or it has
 * read `budget` rows; `complete` is false only in that last case. A row with
 * no expiry stores "" and never matches a range above "".
 */
export async function scanByExpiry(
	ctx: PluginContext,
	range: { gt?: string; gte?: string; lt?: string; lte?: string },
	order: "asc" | "desc",
	keep: (c: CredentialRecord) => boolean,
	want: number,
	budget: number,
): Promise<{ rows: CredentialRecord[]; more: boolean; complete: boolean }> {
	const rows: CredentialRecord[] = [];
	let cursor: string | undefined;
	let read = 0;
	do {
		const page = await ctx.storage.credentials!.query({ where: { dateExpires: range }, orderBy: { dateExpires: order }, limit: 100, cursor });
		for (const item of page.items) {
			read++;
			const c = normalizeCredential(item.data, item.id);
			if (!keep(c)) continue;
			if (rows.length === want) return { rows, more: true, complete: true };
			rows.push(c);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor && read < budget);
	return { rows, more: false, complete: !cursor };
}

/**
 * Every byline group that has credentials, through the owner index: each query
 * starts after the last owner it saw, so it reads at most a page of one
 * owner's rows, never every credential. A group whose byline was deleted and
 * that never had a person record is found this way. `complete` is false if it
 * stopped after `maxQueries`.
 */
export async function credentialGroups(ctx: PluginContext, maxQueries = 200): Promise<{ groups: string[]; complete: boolean }> {
	const groups: string[] = [];
	// Owners are "group:<translationGroup>"; ";" sorts right after ":".
	let after = "group:";
	for (let q = 0; q < maxQueries; q++) {
		const page = await ctx.storage.credentials!.query({
			where: { owner: { gt: after, lt: "group;" } },
			orderBy: { owner: "asc" },
			limit: 100,
		});
		for (const item of page.items) {
			const group = groupFromOwner(normalizeCredential(item.data, item.id).owner);
			if (group && groups[groups.length - 1] !== group) groups.push(group);
		}
		if (!page.hasMore || page.items.length === 0) return { groups, complete: true };
		after = normalizeCredential(page.items[page.items.length - 1]!.data, "").owner;
	}
	return { groups, complete: false };
}

/** Remove everything kept for a byline group: its profile and its credentials. */
export async function deleteGroupData(ctx: PluginContext, group: string): Promise<void> {
	const owner = `group:${group}`;
	const ids = [...((await credentialsFor(ctx, [owner])).get(owner) ?? [])].map((c) => c.id);
	if (ids.length > 0) await ctx.storage.credentials!.deleteMany(ids);
	await ctx.storage.people!.delete(group);
}

// ── Schema version ───────────────────────────────────────────────

/**
 * EmDash has no upgrade lifecycle hook, so a
 * future migration runs from here, lazily, before the first admin read.
 * Version 1 is the first shape: nothing to migrate yet.
 */
export async function ensureSchema(ctx: PluginContext): Promise<void> {
	const version = await ctx.kv.get<number>(KV_SCHEMA);
	if (version === SCHEMA_VERSION) return;
	await ctx.kv.set(KV_SCHEMA, SCHEMA_VERSION);
}
