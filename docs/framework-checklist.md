# Framework checklist

The acceptance checklist for work on the framework (the `@minamocms/minamo` package) from Group AG on. Phases 1 and 2 are in `phase-1-checklist.md` and `phase-2-checklist.md`. Phase 3, the admin application, now lives with the admin, which is a private hosted service in its own repository; the agent-side groups it covered are in this repository's git history (`docs/phase-3-checklist.md` before the move). Group letters carry on from Phase 3's.

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

Decided by the owner (2026-10-15): the product is Minamo, and the framework is published to npm as `@minamocms/minamo` from 0.10.1. (The unscoped `minamo`, tried for 0.10.0, was refused by npm as too like `minami` and `minio`; 0.10.0 was never published, and 0.9.2's lookup of `minamo` never finds anything.) A last `@o-a/cms-agent` release, 0.9.3, hands existing sites over through `npm run upgrade`; the `minamocms` npm organisation exists before it is published, so the name it looks up is already ours.

| # | Criterion | Proof |
|---|---|---|
| AH1 | `npm run upgrade` on `@o-a/cms-agent` 0.9.3 moves to `@minamocms/minamo` once it has a newer version (swapping the dependency, keeping the site's own, handing over to its finish step), and upgrades as before until then | 0.9.3's own unit tests (tag v0.9.3, branch `release/0.9.x`); `e2e/upgrade.check.ts :: a site on @o-a/cms-agent 0.9.3 upgrades onto @minamocms/minamo` (the real tagged build, packed and installed) |
| AH2 | The package is `@minamocms/minamo` (licence `FSL-1.1-ALv2`): new sites depend on it and import it; finishing an upgrade leaves only `@minamocms/minamo` in `vhost/package.json` and puts back a `server.js` importing it; push's version check reads either name | `test/upgrade/upgrade.test.ts :: a site still on @o-a/cms-agent finishes its upgrade on @minamocms/minamo ...`, `:: upgradedDependencies names the CMS once ...`; `test/create-site/generate-site.test.ts :: scaffoldSite pins @minamocms/minamo ...`; `test/site-sync/deploy.test.ts :: deployedVersionProblem ...` |
| AH3 | A redeploy refreshes `vhost/server.js` on the live volume along with the installed CMS, so a live site moved to `@minamocms/minamo` still starts | `test/create-site/generate-site.test.ts` (docker-entrypoint.sh refresh test: server.js follows the image) |

## Future considerations (not scoped, for later discussion)

Ideas raised in conversation that aren't part of any planned group - not decided, not estimated, just worth not losing.

- **Static export (`npm run export`).** Raised 2026-10-02: for a developer who likes the framework and wants to put a finished site on simple hosting (an FTP-only PHP host, cPanel, Netlify, GitHub Pages, S3), with no editing on the host itself. A command run locally that renders every published page with the existing renderer into a plain folder to upload: `about/team/index.html`-style pages, theme assets, media and root files copied as-is, `404.html`, redirects as `.htaccess` rules (plus a `_redirects` file for Netlify-style hosts), and `sitemap.xml`. Read-only against the site and writes only to its own output folder, so none of the content, git or publish rules are touched. Search is the one feature that doesn't carry over (`/search.json` answers live queries): the leading idea is a static search file always, filtered in the browser, plus an optional small `search.php` that answers the same queries for PHP hosts so existing themes keep working. Not a PHP port of the runtime: that was considered and rejected (two runtimes to keep identical, LiquidJS vs PHP Liquid differences, no git on shared hosts). Limits to document: no admin, Assistant, drafts or history on the host; every change is edit locally, export, upload again; forms need a third-party service.
