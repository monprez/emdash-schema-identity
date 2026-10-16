Schema Identity replaces EmDash's built-in JSON-LD with one connected schema.org graph on every page, with the most care spent on **who** is behind your content: the people and organisation, their credentials and expertise, and who wrote which article.

**What it publishes**

- The site as a Person, an Organization or both, with job title, profiles elsewhere (`sameAs`) and areas of expertise (`knowsAbout`). `worksFor` and `founder` are separate claims, because an employee is not a founder.
- Credentials (`hasCredential`) with issuing body, dates and a verification link, and organisation certifications (`hasCertification`). An expired credential drops out on its own the day after it expires (cached pages can take longer to catch up).
- Every credited byline as its own Person node. Role labels such as "Reviewed by" are mapped explicitly, never guessed.
- `WebSite`, `WebPage`, `BlogPosting`, the primary image, and breadcrumbs when your theme supplies them.

**Rules it follows:** relationships only where something confirms them, no invented data, and impossible dates refused rather than repaired.

Made by [Monprez](https://monprez.se/en/home/). Also available for WordPress as [Monprez Schema Identity](https://wordpress.org/plugins/monprez-schema-identity/).
