import { afterEach, describe, expect, it } from "vitest";

import { createPluginTestHost, type PluginTestHost } from "@emdash-cms/plugin-test";

let host: PluginTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

describe("page:metadata through the production sandbox", () => {
	it("replaces core's primary JSON-LD with a connected graph", async () => {
		host = await createPluginTestHost();
		const result = (await host.invokeHook("page:metadata", {
			page: {
				url: "https://example.com/about",
				path: "/about",
				locale: null,
				kind: "custom",
				pageType: "website",
				title: "About — Site",
				pageTitle: "About",
				description: null,
				canonical: "https://example.com/about",
				image: null,
				siteName: "Site",
			},
		})) as { kind: string; id: string; graph: { "@graph": Array<Record<string, unknown>> } };

		expect(result.kind).toBe("jsonld");
		expect(result.id).toBe("primary");
		const types = result.graph["@graph"].map((n) => n["@type"]);
		expect(types).toEqual(expect.arrayContaining(["WebSite", "WebPage"]));
		expect(types).not.toContain("BlogPosting");
	});
});
