# Framework checklist

The acceptance checklist for work on the framework (the `@minamocms/framework` package) from Group AG on. Phases 1 and 2 are in `phase-1-checklist.md` and `phase-2-checklist.md`. Phase 3, the admin application, now lives with the admin, which is a private hosted service in its own repository; the agent-side groups it covered are in this repository's git history (`docs/phase-3-checklist.md` before the move). Group letters carry on from Phase 3's.

Rules for using this file (same as the phase checklists):

- An item is done only when its proving test exists, passes, and is named in the "Proof" column. "It works when I run it" is not proof.
- Work top to bottom within a group; groups are ordered by dependency.
- Do not edit the criteria to match the implementation. If a criterion is wrong, raise it with the lead first.
- Each group gets its own working session: research any new dependency or API empirically before designing, a plan-mode design review for anything with a real architectural decision, then implement in small commits.

## Group AG: Rollback - Recently deleted (step 1 of activity and undo)

Agreed with the owner: a site-wide rollback in three steps - Recently deleted, then a read-only Activity view, then safe Undo - before the in-app AI assistant. Every change is already a git commit, so this is mostly reading git's record.

| # | Criterion | Proof |
|---|---|---|
| AG1 | GET /v1/deleted-pages lists pages deleted in the last 90 days, newest first with name, title, who and when, never moved or re-created ones, and each restores from its listed ref through POST /v1/git/revert | `test/services/deleted-pages.test.ts`, `test/routes/links.test.ts :: GET /v1/deleted-pages ...` |

## Group AH: Rename to Minamo

Decided by the owner (2026-10-15): the product is Minamo, and the framework is published to npm as `@minamocms/framework` from 0.10.1. (The unscoped `minamo`, tried for 0.10.0, was refused by npm as too like `minami` and `minio`; 0.10.0 was never published, and 0.9.2's lookup of `minamo` never finds anything.) A last `@o-a/cms-agent` release, 0.9.3, hands existing sites over through `npm run upgrade`; the `minamocms` npm organisation exists before it is published, so the name it looks up is already ours.

| # | Criterion | Proof |
|---|---|---|
| AH1 | `npm run upgrade` on `@o-a/cms-agent` 0.9.3 moves to `@minamocms/framework` once it has a newer version (swapping the dependency, keeping the site's own, handing over to its finish step), and upgrades as before until then | 0.9.3's own unit tests (tag v0.9.3, branch `release/0.9.x`); `e2e/upgrade.check.ts :: a site on @o-a/cms-agent 0.9.3 upgrades onto @minamocms/framework` (the real tagged build, packed and installed) |
| AH2 | The package is `@minamocms/framework` (licence `FSL-1.1-ALv2`): new sites depend on it and import it; finishing an upgrade leaves only `@minamocms/framework` in `vhost/package.json` and puts back a `server.js` importing it; push's version check reads either name | `test/upgrade/upgrade.test.ts :: a site still on @o-a/cms-agent finishes its upgrade on @minamocms/framework ...`, `:: upgradedDependencies names the CMS once ...`; `test/create-site/generate-site.test.ts :: scaffoldSite pins @minamocms/framework ...`; `test/site-sync/deploy.test.ts :: deployedVersionProblem ...` |
| AH3 | A redeploy refreshes `vhost/server.js` on the live volume along with the installed CMS, so a live site moved to `@minamocms/framework` still starts | `test/create-site/generate-site.test.ts` (docker-entrypoint.sh refresh test: server.js follows the image) |

## Group AI: PDFs in the media library

Agreed with the owner (2026-11-05): editors can upload PDFs (price lists, menus, brochures, forms) and link to them. PDF only; Office files stay out. The admin side (library tiles, a Documents group in link suggestions, image and video pickers that leave documents out) is in the admin's own repository.

| # | Criterion | Proof |
|---|---|---|
| AI1 | `POST /v1/media` accepts a `.pdf` whose bytes carry the `%PDF-` header (within the first 1024 bytes) and serves it as `application/pdf` with `nosniff`; a file merely named `.pdf` is refused with 415 and nothing is stored, and Office files are still refused | `test/routes/media.test.ts` ("accepts a real PDF", "rejects a file named .pdf that is not a PDF", "still rejects Office files"), `test/media/filename.test.ts` ("a .pdf must really be a PDF") |
| AI2 | Documents have their own size cap, `media.maxDocumentUploadBytes` (25MB by default), separate from the image and video cap; an invalid value fails at startup | `test/routes/media.test.ts` ("documents have their own size limit", "a PDF over the document limit"), `test/server-config.test.ts` ("media.maxDocumentUploadBytes sets the PDF limit", "non-positive-integer media.maxDocumentUploadBytes") |
| AI3 | `GET /v1/capabilities` reports `maxDocumentUploadBytes` and `mediaUploadExtensions`, so the admin knows which sites take PDFs | `test/server.test.ts` ("A3: GET /v1/capabilities") |
| AI4 | `seed-media` applies the same rules, PDF content check included | `test/media/seed-media.test.ts` ("seeds a real PDF, and skips a file merely named .pdf") |
| AI5 | `push` uploads media a page links to from rich text (`href`/`src` attributes) as well as whole image, video and link values, while a `/media/` path in prose still isn't counted | `test/site-sync/push-site.test.ts` ("a /media/ path inside longer text is prose... a rich-text link to one is a use") |

## Group AJ: /admin leads to the admin by default

Agreed with the owner (2026-11-06): so that "your site's address with /admin on the end" works for every Minamo site without setup, `adminBaseUrl` defaults to the hosted admin, with a one-line opt-out. The redirect is a fallback, never a reserved path.

| # | Criterion | Proof |
|---|---|---|
| AJ1 | With no `adminBaseUrl` in `site.config.json` (or no file at all), `GET /admin` redirects 302 to `https://cms.minamo.app/?site=<host>` | `test/server-config.test.ts` ("AJ1: ... defaults to the hosted Minamo admin"), `test/routes/admin-redirect.test.ts` ("AJ1: with no adminBaseUrl configured") |
| AJ2 | `"adminBaseUrl": false` turns the redirect off (`/admin` is an ordinary missing page); any other non-URL value, `true` included, fails at startup | `test/server-config.test.ts` ("AJ2: ..."), `test/routes/admin-redirect.test.ts` ("AJ2: with \"adminBaseUrl\": false") |
| AJ3 | A published page, a `redirects.json` entry or a `theme/root/admin` file at `/admin` is served instead of the redirect; an unpublished page there falls back to it | `test/routes/admin-redirect.test.ts` ("AJ3: ...") |

## Group AK: A neutral starter for new sites

Agreed with the owner (2026-11-10): `create-site` makes a genuinely minimal, neutral starting point, not a page about Minamo. Placeholder text says what each place is for; Home, About (with Our team nested), Contact and 404; light, with one accent colour. Fuller example sites (architecture, wellbeing, a restaurant) are planned separately, outside the package.

| # | Criterion | Proof |
|---|---|---|
| AK1 | A new site passes `check-site` with no findings or suggestions | `test/create-site/starter.test.ts` ("a new site passes the site check"); `test/upgrade/upgrade.test.ts` ("finishUpgrade updates content ... and checks the site") |
| AK2 | It has Home, About, About/Our team, Contact and 404, a `main` and a `footer` menu, and one page template | `test/create-site/starter.test.ts` ("a new site has Home, About, Our team ...") |
| AK3 | Every section renders as an editor first adds it, with each block it allows, and shows no drop target or placeholder while no picture is set | `test/create-site/starter.test.ts` ("every section renders as an editor first adds it ...") |
| AK4 | Pictures set in sections and blocks are drop targets naming their field; a video never claims to be an image | `test/create-site/responsive-media.test.ts` |
| AK5 | The site name, accent colour, font, contact details and social links come from site settings; empty ones are hidden and text is escaped before its line breaks are added | `test/create-site/site-settings.test.ts` |
| AK6 | The starter's theme and content never mention Minamo, and nothing in it uses an em or en dash | `test/create-site/starter.test.ts` ("the starter stays neutral ...") |

## Future considerations (not scoped, for later discussion)

Ideas raised in conversation that aren't part of any planned group - not decided, not estimated, just worth not losing.

- **Static export (`npm run export`).** Raised 2026-10-02: for a developer who likes the framework and wants to put a finished site on simple hosting (an FTP-only PHP host, cPanel, Netlify, GitHub Pages, S3), with no editing on the host itself. A command run locally that renders every published page with the existing renderer into a plain folder to upload: `about/team/index.html`-style pages, theme assets, media and root files copied as-is, `404.html`, redirects as `.htaccess` rules (plus a `_redirects` file for Netlify-style hosts), and `sitemap.xml`. Read-only against the site and writes only to its own output folder, so none of the content, git or publish rules are touched. Search is the one feature that doesn't carry over (`/search.json` answers live queries): the leading idea is a static search file always, filtered in the browser, plus an optional small `search.php` that answers the same queries for PHP hosts so existing themes keep working. Not a PHP port of the runtime: that was considered and rejected (two runtimes to keep identical, LiquidJS vs PHP Liquid differences, no git on shared hosts). Limits to document: no admin, Assistant, drafts or history on the host; every change is edit locally, export, upload again; forms need a third-party service.
