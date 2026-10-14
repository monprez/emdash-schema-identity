# Changelog

## 1.0.0

First public release. Schema Identity replaces EmDash's built-in JSON-LD with
one connected schema.org graph:

- Site identity as a Person, an Organization or both, with `worksFor` and
  `founder` as separate claims.
- Person credentials (`hasCredential`) and organisation certifications
  (`hasCertification`), with expiry handled per request and a Published switch.
- A Person node for every credited byline, with its own job title, expertise and
  credentials; role labels are mapped explicitly.
- `WebSite`, `WebPage`, `BlogPosting`, primary image and `BreadcrumbList`.
- Admin pages: Identity (with links for checking your markup), Credentials,
  People, Byline roles; an Expiring credentials dashboard widget.
- A public, read-only `people` route and an example author box for themes.
