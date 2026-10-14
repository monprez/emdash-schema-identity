// Regenerates tests/fixtures/schemaorg-vocab.json from the current schema.org
// release, trimmed to what the vocabulary test needs: each class's direct
// superclasses, each property's domains and ranges, and enumeration members.
//
//   node scripts/update-schema-vocab.mjs            (downloads the latest release)
//   node scripts/update-schema-vocab.mjs file.jsonld (uses a local copy)
//
// Development only; not part of the plugin bundle.
import { readFile, writeFile } from "node:fs/promises";

const SOURCE = "https://schema.org/version/latest/schemaorg-current-https.jsonld";
const out = new URL("../tests/fixtures/schemaorg-vocab.json", import.meta.url);

const raw = process.argv[2] ? await readFile(process.argv[2], "utf8") : await (await fetch(SOURCE)).text();
const graph = JSON.parse(raw)["@graph"];
const name = (ref) => String(ref["@id"] ?? ref).replace(/^schema:/, "");
const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map(name);
const types = (n) => list(n["@type"]);

const classes = {};
const properties = {};
const members = {};
for (const node of graph) {
	const id = name(node);
	if (types(node).includes("rdfs:Class")) {
		classes[id] = list(node["rdfs:subClassOf"]).filter((c) => !c.includes(":"));
	} else if (types(node).includes("rdf:Property")) {
		properties[id] = { domains: list(node["schema:domainIncludes"]), ranges: list(node["schema:rangeIncludes"]) };
	}
}
for (const node of graph) {
	for (const t of types(node)) if (classes[t] !== undefined && !types(node).includes("rdfs:Class")) members[name(node)] = t;
}
// DataType members (Text, URL, Date…) are declared as classes of schema:DataType.
const version = graph.find((n) => n["@id"] === "schema:Thing")?.["schema:isPartOf"] ?? "latest";
await writeFile(out, JSON.stringify({ source: SOURCE, generated: new Date().toISOString().slice(0, 10), classes, properties, members }) + "\n");
console.log(`classes ${Object.keys(classes).length}, properties ${Object.keys(properties).length}, members ${Object.keys(members).length}`, version);
