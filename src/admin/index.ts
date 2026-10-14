/**
 * The private `admin` route: every page, widget, button and form submission
 * of the Block Kit UI arrives here. Input is untrusted (anything can call a
 * private route), so it is parsed before use and unknown interactions render
 * nothing rather than throw.
 */

import type { BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext } from "emdash/plugin";

import { groupFromOwner } from "../model.js";
import { deleteGroupData, ensureSchema } from "../store.js";
import {
	backFor,
	credentialPage,
	isOwner,
	parseCredentialBlock,
	removeCredential,
	renderCredentialForm,
	renderSiteCredentials,
	submitCredential,
	type Back,
} from "./credentials.js";
import { renderIdentity, submitIdentity } from "./identity.js";
import { parsePersonBlock, peopleOffset, renderPeople, renderPerson, submitPerson } from "./people.js";
import { renderRoles, submitRoles } from "./roles.js";
import { parseInteraction, toast } from "./ui.js";
import { renderWidget } from "./widget.js";

const EMPTY: BlockResponse = { blocks: [] };

async function renderPage(ctx: PluginContext, page: string): Promise<BlockResponse> {
	switch (page) {
		case "/identity":
			return renderIdentity(ctx);
		case "/credentials":
			return renderSiteCredentials(ctx);
		case "/people":
			return renderPeople(ctx);
		case "/roles":
			return renderRoles(ctx);
		case "widget:expiring":
			return renderWidget(ctx);
		default:
			return EMPTY;
	}
}

async function renderBack(ctx: PluginContext, back: Back, message?: string): Promise<BlockResponse> {
	const response = "person" in back ? await renderPerson(ctx, back.person) : await renderPage(ctx, back.page);
	return message ? toast(response, message) : response;
}

function asBack(value: unknown): Back | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (v.page === "/credentials") return { page: "/credentials" };
	if (typeof v.person === "string" && /^[\w-]{1,128}$/.test(v.person)) return { person: v.person };
	return null;
}

function asOwnerRef(value: unknown): { owner: string; id?: string } | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (typeof v.owner !== "string" || !isOwner(v.owner)) return null;
	if (v.id !== undefined && (typeof v.id !== "string" || !/^[\w-]{1,128}$/.test(v.id))) return null;
	return { owner: v.owner, id: v.id as string | undefined };
}

const isGroup = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,128}$/.test(v);

export async function handleAdmin(input: unknown, ctx: PluginContext): Promise<BlockResponse> {
	const interaction = parseInteraction(input);
	if (!interaction) return EMPTY;
	await ensureSchema(ctx);

	if (interaction.type === "page_load") return renderPage(ctx, interaction.page);

	if (interaction.type === "block_action") {
		const { action_id, value } = interaction;
		switch (action_id) {
			case "open_person":
				return isGroup(value) ? renderPerson(ctx, value) : EMPTY;
			case "credentials_page": {
				const target = credentialPage(value);
				if (!target) return EMPTY;
				const group = groupFromOwner(target.owner);
				return group ? renderPerson(ctx, group, undefined, [], target.offset) : renderSiteCredentials(ctx, target);
			}
			case "people_page": {
				const offset = peopleOffset(value);
				return offset === null ? EMPTY : renderPeople(ctx, offset);
			}
			case "orphans_page": {
				const offset = peopleOffset(value);
				return offset === null ? EMPTY : renderPeople(ctx, 0, offset);
			}
			case "add_credential": {
				const ref = asOwnerRef(value);
				return ref ? renderCredentialForm(ctx, ref.owner, null) : EMPTY;
			}
			case "edit_credential": {
				const ref = asOwnerRef(value);
				return ref?.id ? renderCredentialForm(ctx, ref.owner, ref.id) : EMPTY;
			}
			case "delete_credential": {
				const ref = asOwnerRef(value);
				if (!ref?.id) return EMPTY;
				return removeCredential(ctx, ref.owner, ref.id, (m) => renderBack(ctx, backFor(ref.owner), m));
			}
			case "delete_orphan":
				if (!isGroup(value)) return EMPTY;
				await deleteGroupData(ctx, value);
				return toast(await renderPeople(ctx), "Deleted");
			case "back": {
				const back = asBack(value);
				return back ? renderBack(ctx, back) : EMPTY;
			}
			default:
				return EMPTY;
		}
	}

	// form_submit
	switch (interaction.action_id) {
		case "save_identity":
			return submitIdentity(ctx, interaction.values);
		case "save_roles":
			return submitRoles(ctx, interaction.values);
		case "save_person": {
			const group = parsePersonBlock(interaction.block_id);
			return group ? submitPerson(ctx, group, interaction.values) : EMPTY;
		}
		case "save_credential": {
			const target = parseCredentialBlock(interaction.block_id);
			if (!target) return EMPTY;
			return submitCredential(ctx, target.owner, target.id, interaction.values, (m) =>
				renderBack(ctx, backFor(target.owner), m),
			);
		}
		default:
			return EMPTY;
	}
}
