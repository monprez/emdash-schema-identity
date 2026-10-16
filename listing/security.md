Report security issues to plugins@monprez.se.

The plugin asks for one permission, `bylines:read`. It has no network access, no content writes and no media access. Its data stays in its own storage on your site.

One public, read-only route (`GET /_emdash/api/plugins/schema-identity/people`) lets themes show what the markup says about a person: their job title, expertise and current credentials, by the same rules as the markup. It answers for every existing byline, including people not yet credited on a published page, so only enter what you are happy to make public. Hidden, expired and not-yet-issued credentials, and data kept for deleted bylines, are never returned.
