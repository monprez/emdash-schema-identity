/**
 * Dashboard widget: credentials that expire soon, then ones that have
 * expired. Status is computed on view with the same function the graph uses;
 * nothing scheduled. Only credentials that could be published are listed:
 * not those kept for a deleted byline, a linked owner byline, or a site
 * entity the identity mode leaves out.
 */

import type { Block, BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";

import { credentialStatus, todayIn } from "../credentials.js";
import { OWNER_ORGANIZATION, OWNER_SITE_PERSON, groupFromOwner, mergedOwnerGroup, type CredentialRecord } from "../model.js";
import { loadConfig, loadUnmappedLabels, scanByExpiry } from "../store.js";
import { daysUntil, listBylineGroups } from "./ui.js";

const WINDOW_DAYS = 60;
const MAX_ROWS = 20;
/**
 * Rows read per date range before the widget stops and says the check was
 * incomplete. Only rows that cannot be listed (hidden, or for a deleted
 * byline or a site entity not in use) can use it up; listed rows stop the read at 20.
 */
const READ_BUDGET = 2000;

/** `ymd` plus `days`, as YYYY-MM-DD. */
function addDays(ymd: string, days: number): string {
	const t = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)) + days);
	return new Date(t).toISOString().slice(0, 10);
}

export async function renderWidget(ctx: PluginContext): Promise<BlockResponse> {
	const { identity } = await loadConfig(ctx);
	const today = todayIn(identity.timeZone);
	const names = new Map((await listBylineGroups(ctx)).map((b) => [b.group, b.name]));
	const merged = mergedOwnerGroup(identity);
	const ownerName = (owner: string): string | null => {
		if (owner === OWNER_SITE_PERSON) {
			return identity.mode !== "organization" && identity.person.name.trim() ? identity.person.name : null;
		}
		if (owner === OWNER_ORGANIZATION) {
			return identity.mode !== "person" && identity.organization.name.trim() ? identity.organization.name : null;
		}
		const group = groupFromOwner(owner);
		return group && group !== merged ? (names.get(group) ?? null) : null;
	};

	// Two indexed date ranges, not a scan of every credential: renewals still
	// to do (soonest first), then the most recent expiries in the rows left.
	const listable = (c: CredentialRecord, expired: boolean) => {
		if (c.published === false || ownerName(c.owner) === null) return false;
		const status = credentialStatus(c, today);
		return expired ? status === "expired" : status !== "expired" && status !== "invalid";
	};
	const soon = await scanByExpiry(ctx, { gte: today, lte: addDays(today, WINDOW_DAYS) }, "asc", (c) => listable(c, false), MAX_ROWS, READ_BUDGET);
	const past = await scanByExpiry(ctx, { gt: "", lt: today }, "desc", (c) => listable(c, true), MAX_ROWS - soon.rows.length, READ_BUDGET);
	const more = soon.more || past.more;
	const complete = soon.complete && past.complete;
	const rows = [...soon.rows, ...past.rows].map((c) => {
		const days = daysUntil(c.dateExpires!, today);
		return {
			name: c.name,
			who: ownerName(c.owner),
			expires: c.dateExpires,
			status: credentialStatus(c, today) === "expired" ? "Expired: no longer published" : days === 0 ? "Last day today" : `${days} days left`,
		};
	});

	const unmapped = await loadUnmappedLabels(ctx);
	const blocks: Block[] = [];
	if (unmapped.length > 0) {
		blocks.push({
			type: "section",
			text: `${unmapped.length} byline role label${unmapped.length === 1 ? " is" : "s are"} not mapped, so those people are left out.`,
			accessory: { type: "link", label: "Map roles", target: { kind: "plugin-page", path: "/roles" } },
		});
	}
	blocks.push(
		rows.length > 0
			? {
					type: "table",
					page_action_id: "noop",
					columns: [
						{ key: "name", label: "Credential" },
						{ key: "who", label: "Belongs to" },
						{ key: "expires", label: "Expires" },
						{ key: "status", label: "Status", format: "badge" },
					],
					rows,
				}
			: complete
				? { type: "empty", title: "Nothing expiring", description: `No credentials expire in the next ${WINDOW_DAYS} days.`, size: "sm" }
				: { type: "empty", title: "Not every credential was checked", description: `More than ${READ_BUDGET} hidden or unused credentials share these dates. Check Credentials and People.`, size: "sm" },
	);
	if (more) {
		blocks.push({
			type: "context",
			text: "More not shown. Expired ones are listed last; edit or delete them under Credentials and People.",
		});
	}
	if (rows.length > 0 && !complete) {
		blocks.push({
			type: "context",
			text: `Not every credential was checked: more than ${READ_BUDGET} hidden or unused credentials share these dates.`,
		});
	}
	return { blocks };
}
