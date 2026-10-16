![Schema Identity for EmDash](https://raw.githubusercontent.com/monprez/emdash-schema-identity/main/assets/banner.png)

# Schema Identity for EmDash

Structured data for [EmDash](https://emdashcms.com) sites, with the most care
spent on **who** is behind the content: the people and organisation, their
credentials and expertise, and which people wrote which article.

Schema Identity replaces EmDash's built-in JSON-LD with one connected
schema.org graph on every page. EmDash itself keeps handling meta tags, Open
Graph, canonical URLs, the sitemap and robots.txt.

By [Monprez](https://monprez.se/en/home/). Also available for WordPress as
[Monprez Schema Identity](https://wordpress.org/plugins/monprez-schema-identity/).

## What it publishes

- **The site entity**: a Person, an Organization, or both, with job title,
  description, image, profiles elsewhere (`sameAs`) and areas of expertise
  (`knowsAbout`). `worksFor` and `founder` are separate switches, because an
  employee is not a founder.
- **Credentials**: a person's licences, degrees and qualifications
  (`hasCredential` → `EducationalOccupationalCredential`, with issuing body,
  dates and a verification link), and an organisation's certifications
  (`hasCertification` → `Certification`, with certificate number, `validFrom`
  and `CertificationActive`).
- **Every byline as a Person**: each person credited on a post gets their own
  node, with the job title, expertise and credentials you add for them. The
  article's `author` points at the real bylines, never at a single site-wide
  person.
- **The page**: `WebSite`, `WebPage`, `BlogPosting` on articles, the primary
  image, and `BreadcrumbList` when your theme supplies breadcrumbs.

### Rules it follows

- **Relationships are stated only where something confirms them.** A post is
  credited to the people on its bylines. A byline with a role label ("Reviewed
  by", "Photos") is left out until you say what that label means.
- **Expired credentials disappear on their own.** A credential is published up to
  and including its expiry date, and gone the next day, with no save needed.
  A person's credential with a future issue date appears once it is issued.
  Any credential can be hidden with its Published switch.
- **Bad dates are refused, not repaired.** A form with an impossible date or an
  expiry before the issue date is not saved, and says why.
- **No invented data.** Everything comes from what you enter or from EmDash itself.

## Setup

1. Install the plugin and approve its permissions: reading bylines, and one
   public read-only route (below). It makes no network requests and never
   changes your content.
2. **Identity**: choose whether the site represents a person, an organisation
   or both, and fill in what is true. If you write on the site yourself, choose
   your byline, and your posts will then credit this identity and its credentials.
   Set the **time zone** that decides when a credential expires.
3. **Credentials**: add the site person's credentials and the organisation's
   certifications, one at a time.
4. **People**: for each byline, add a job title, expertise and credentials.
   Name, bio and website stay on the byline itself.
5. **Byline roles**: map any role labels your bylines use. Labels appear there once
   a page using them has been viewed.

The dashboard's **Expiring credentials** widget lists anything that expires in
the next 60 days, then anything that has already expired.

Each person and the organisation can have up to 50 credentials, and the Roles
page holds up to 60 role labels (remove ones you no longer use to make room).
Web addresses can be up to 1,000 characters, and each list (such as profiles or
expertise) up to 16 KB. These keep every admin page within EmDash's size limit
for plugin pages.

Images (photo, logo, badge) are entered as public web addresses. EmDash gives
plugins only login-protected links to the media library, which search engines
could not load.

## Show what you publish

Search engines expect structured data to describe what readers can see. If you
publish credentials, show them on the page too. The plugin has a public,
read-only route that returns, for a person, the job title, expertise and current
credentials the markup uses, by the same rules. It answers for every existing
byline, including people not yet credited on a published page, so only enter
what you are happy to make public:

```
GET /_emdash/api/plugins/schema-identity/people?group=<byline translationGroup>
GET /_emdash/api/plugins/schema-identity/people?site=person
```

In an Astro theme, call it in-process through the EmDash runtime:

```astro
---
const res = await Astro.locals.emdash.handlePublicPluginApiRoute(
	"schema-identity",
	"GET",
	"/people",
	new Request(new URL(`/_emdash/api/plugins/schema-identity/people?group=${credit.byline.translationGroup}`, Astro.url)),
);
const person = res.success ? res.data : null; // { jobTitle?, knowsAbout[], credentials[] }
---
```

A complete, copyable author box is in
[`examples/AuthorCredentials.astro`](https://github.com/monprez/emdash-schema-identity/blob/main/examples/AuthorCredentials.astro).
Use it as `<AuthorCredentials bylines={post.data.bylines ?? []} />`. It shows
each person under their credit, so a reviewer is labelled "Reviewed by", not
as an author.

## Check your markup

Open a published article that has a byline and paste its address into
[Google's Rich Results Test](https://search.google.com/test/rich-results) (what
Google can use) and the [Schema.org validator](https://validator.schema.org/)
(every node). The Identity page links to both. Changes show on the next page
view, unless your pages are cached (below).

## Caching and expiry

The plugin works out what is current on every request, so an expired credential
leaves the markup at midnight in your chosen time zone. **A cached page keeps
showing what it had when it was cached.** EmDash's Node template doesn't cache
pages. If you enable page caching (for example Cloudflare's Workers Cache with
`routeRules`), an expired credential can stay on a cached page for up to that
route's `maxAge`, and a response without a `Cache-Control` header is cached for 2
hours. Plugins cannot purge the page cache, so keep `maxAge` to a length you are
happy with (a day or less). The public route is cached for 5 minutes.

## Compatibility

Schema Identity contributes EmDash's primary JSON-LD block, the same slot core
and other schema plugins use, and only one contribution is shown. **Use one
schema plugin at a time.** It needs EmDash 1.2.0 or later and a theme that renders
`<EmDashHead>` with a page context that includes `content`, as the official
templates do. If bylines can't be read, articles name the theme's author without
credentials.

**Language:** the admin is in English, and this version is built and tested for
single-language sites. Multilingual sites are planned.

## Your data

Everything you enter is kept in the plugin's own storage on your site.

- **Deleting a byline** keeps what you added for that person, unpublished, in
  case the byline is restored. The People page lists it with a **Delete data**
  button.
- **Uninstalling** keeps the plugin's data unless you tick EmDash's "Also delete
  plugin storage data" when you uninstall.

## Development

```sh
pnpm install
pnpm run validate    # manifest
pnpm run typecheck
pnpm run test        # builds, then runs the tests through EmDash's sandbox host
pnpm run build
```

The tests include a schema.org vocabulary check of every node the plugin can
emit (`tests/fixtures/schemaorg-vocab.json`, refreshed with
`node scripts/update-schema-vocab.mjs`), and a parity check against the
WordPress plugin's own builders (regenerate with
`php scripts/wp-parity.php <path to a Monprez Schema Identity checkout>`).

Bump `version` in `package.json` for every release, and always when
`capabilities`, `allowedHosts` or `storage` change in `emdash-plugin.jsonc`:
installed sites consented to the old contract.

## Licence

MIT © Monprez. See [LICENSE](https://github.com/monprez/emdash-schema-identity/blob/main/LICENSE).
