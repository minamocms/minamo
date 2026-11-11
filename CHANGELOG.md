# Changelog

All notable changes to this package are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Nothing before `0.2.0` was tracked in this file - see git history for anything earlier.

## [Unreleased]

### Changed

- **Railway no longer reads `railway.json`.** It stopped reading them for every service on 1 December 2026 (services made after 28 August 2026 never could). Sites made with `create-site` don't have one and are unaffected. If you wrote your own and deploy straight from GitHub, set the variable `RAILWAY_DOCKERFILE_PATH=vhost/Dockerfile` on the service, then set **Healthcheck Path** `/v1/capabilities` and **Restart Policy** On failure in its settings, as the hosting guide now says. Docs only: nothing in the package changed.

## [0.16.2] - 2026-11-10

### Added

- **`npm run mint-token`** adds an access token the same way on your computer and on a live server: from `vhost/`, with no site folder to give (`npm run mint-token -- --scopes content,theme` for fewer scopes). It runs the site's own installed copy, so there's no `npx -p @minamocms/framework` to remember, and no risk of a bare `npx mint-token` fetching an unrelated package of that name. `npm run upgrade` adds the script to existing sites.

## [0.16.1] - 2026-11-10

### Fixed

- **A first deploy to Railway works.** New sites get a `.railwayignore`, so `railway up --no-gitignore` no longer uploads `vhost/node_modules` and `vhost/data`, and the hosting guide gives the full steps, including setting `RAILWAY_DOCKERFILE_PATH=vhost/Dockerfile`: a `railway up` upload doesn't read `railway.json`, so without it the build fails with only "Deploy failed". `npm run upgrade` adds the `.railwayignore` to existing sites.
- **`npm run upgrade` keeps a site's own `.dockerignore` lines.** It used to replace the file with the CMS's copy, dropping anything the site had added, such as a file holding an access token, which could then end up in the image. It now puts back the CMS's lines and keeps the site's own patterns after them, and does the same for `.railwayignore`.

## [0.16.0] - 2026-11-10

### Changed

- **A new site starts from a plain, neutral starter.** `create-site` used to make a one-page marketing site for Minamo itself (pricing tiers, a comparison table, a demo docs tree), all of which had to be deleted. A new site now has Home, About (with Our team under it), Contact and a 404 page, a main and a footer menu, and a "Standard page" template, all in placeholder text that says what each place is for. The theme is light and readable with no images to license: nine sections (hero, text, image and text, cards, gallery, quote, questions and answers, call to action, contact details) and three blocks (button, card, question), which between them use every kind of field the admin edits. Site settings hold the site name, logo, accent colour, font, contact details and social links. Existing sites are unaffected: their theme and content are their own.
- **Each new site gets its own port.** `create-site` picks a free port between 3000 and 3999 for `vhost/site.config.json`, instead of 3000 every time, so several sites can run side by side. It prints the address.
- **`npm run dev` steps around a taken port.** When something else already listens on the site's port (a site made before this change, say), it runs the site on the next free port for that session and says so, instead of stopping. The tunnel and Edit in Minamo link follow. If it's this same site already running, it still says so and stops. `npm start` keeps to the configured port, as live hosting needs.
- **The Docker image always listens on 3000.** `vhost/Dockerfile` now sets `PORT=3000`, so a site's local port never applies inside a container; a host that sets `PORT` itself, such as Railway, still wins. `npm run upgrade` brings this to existing sites: if one is deployed with Docker on a host that expects the container on the port in its `site.config.json` rather than 3000 (a `fly.toml` `internal_port`, or a `docker run -p` mapping), change that to 3000 when you deploy the upgrade.

## [0.15.0] - 2026-11-09

### Changed

- **`npm run dev` is the one command for working on a site.** It asks whether to edit the site in Minamo while it runs (Enter for yes): yes opens the Cloudflare tunnel and prints the Edit in Minamo link, no runs it locally. `npm run dev -- --tunnel` or `-- --local` answers in advance; with no terminal to ask, it runs locally. It restarts the site whenever `theme/` changes, as before, but the tunnel, its address and the Edit in Minamo link now last the whole session: only the site underneath restarts, so an editor already open carries on. Shortcuts: `e` opens the editor, `o` the site, `r` restarts, `q` stops. A site that fails to start after a change shows why and starts again on the next change. It's the package's new `dev-site` command; `npm run upgrade` points the `dev` script at it.
- **`npm start` just runs the site**, as live hosting needs: no tunnel, ever. At a terminal it mentions `npm run dev`.
- **`npm run stop` ends `npm run dev` itself** (the site, the tunnel and the watching), not only the site under it.

### Removed

- **`npm run tunnel`, and `server.js`'s `--tunnel` option.** `npm run dev` asks instead. `npm run upgrade` removes the `tunnel` script from a site's `package.json` while it's still exactly as the CMS made it, and puts back a `server.js` without the option.

## [0.14.1] - 2026-11-09

### Security

- **`npm run upgrade` now applies security fixes to the CMS's own dependencies.** After installing the new version it runs `npm audit fix --omit=dev`, which changes only packages with a published advisory, and only within the versions already allowed (never forced, never a major version). Before, a site's `package-lock.json` could keep an older `fastify`, `fast-uri` or `@fastify/busboy` with known problems even after upgrading, since npm keeps a locked version for as long as it still fits.
- **`fastify` 5.12.8 or later is now required**, for fixes to request validation, `X-Forwarded-*` handling behind a proxy, and malformed URLs reaching not-found handlers.

## [0.14.0] - 2026-11-09

### Changed

- **Clearer terminal output for every command.** At a terminal, the site and every command (`create-site`, `mint-token`, `check-site`, `seed-media`, `stop-site`, `pull-site`, `push-site`, `upgrade-site`) now use colour, symbols (✔ done, ! worth knowing, ✖ went wrong), progress spinners in place of silent waits, aligned results, and a box for the one thing to act on: the Edit in Minamo link, a new access token, push's warning before changing the live site. Problems say what went wrong and what to do, with the command to run. Anywhere else (a host's logs, output piped to a file, CI) the same words print as plain lines, with no colour or decoration. `MINAMO_PLAIN=1` gives plain output at a terminal too, and colour follows `NO_COLOR` and `FORCE_COLOR`. No dependency was added: it's built on Node's own `util.styleText`.
- **Keyboard shortcuts while a site runs at a terminal:** `e` opens the Edit in Minamo link in your browser (with `--tunnel`), `o` opens the site, `q` stops it. `Ctrl+C` works as before, including under `npm run dev`.
- **`npm run tunnel` tries Cloudflare three times** before giving up, and gives the tunnel's address out anyway if it's connected but slow to appear in DNS, rather than failing.
- **`npm run upgrade` shows a spinner while npm installs the new version**, and npm's own output only if the install fails.

### Removed

- **The localtunnel fallback for `npm run tunnel`.** It was much slower than Cloudflare, often dropped images, and its "click to continue" page broke the admin's preview, so a tunnel through it looked open but showed a broken page. `npm run tunnel` now needs `cloudflared` (on a Mac, `brew install cloudflared`; no Cloudflare account needed); without it, the site starts as normal and says how to install it. This also removes the `localtunnel` dependency, and with it an old version of axios with known security advisories.

## [0.13.0] - 2026-11-09

### Added

- **An "Edit in Minamo" link from `npm run tunnel`.** Once the tunnel is open, the terminal prints `<adminBaseUrl>/local#site=<tunnel address>&key=<key>`. Opening it, signed in to the Minamo admin, edits the running site straight away without adding it to your websites, so there's no address to update each time the tunnel changes. The key is made fresh each time the site starts and accepted as an access token only while it runs; it's held in memory, never written to `site.config.json`. The address and key sit after the `#`, so browsers never send them to a server. A tunnel reopened at a new address prints a new link with the same key. Anyone with the link and a Minamo account can edit the site while it runs, so share it only with someone you mean to. Not printed when `adminBaseUrl` is `false`.

## [0.12.1] - 2026-11-09

### Changed

- **`npm run tunnel` is much faster when `cloudflared` is installed** (on a Mac, `brew install cloudflared`; no Cloudflare account needed). It then goes through a Cloudflare quick tunnel instead of localtunnel: in testing, about 0.1s a page against 1.3s, and 0.3s for a full page with its images against 11s, with localtunnel failing most of the images. Without `cloudflared` it still uses localtunnel, and says how to get the faster one. The address is printed only once it works, so opening it straight away no longer gets "not found". The startup line says which service is in use.

### Fixed

- **A dropped tunnel is reported and reopened** instead of failing silently (seen in the admin as a 503 or a page that never loads). localtunnel asks for the same address back; a reopened Cloudflare tunnel has a new one, and the terminal says so. A localtunnel error can no longer crash the site.

## [0.12.0] - 2026-11-06

### Changed

- **`yoursite.com/admin` now leads to the Minamo admin on every site.** `adminBaseUrl` in `site.config.json` defaults to `https://cms.minamo.app`, so `GET /admin` redirects there (with `?site=<host>`, which opens that site's editor) without any setup, including on sites already live once they upgrade. Set `"adminBaseUrl": false` to turn it off, or another URL for a different admin. It is a plain redirect: the site contacts nothing itself, and passes on only its own address.
- **A page at `/admin` always wins.** The redirect now happens only when `/admin` would otherwise be a 404, so a published page, a `redirects.json` entry or a `theme/root/admin` file is served instead, even with `adminBaseUrl` set. Before, setting it made `/admin` redirect whatever was there.

## [0.11.0] - 2026-11-05

### Added

- **PDFs in the media library.** `POST /v1/media` (and `seed-media`) now accept `.pdf` files, for the price lists, menus, brochures and forms editors link to. A PDF is checked by its contents, not just its name: a file without the `%PDF-` header is refused, so nothing else can be passed off as a document. PDFs are served as `application/pdf`, so they open in the browser's own viewer. Office files are still refused.
- **`media.maxDocumentUploadBytes`** in `site.config.json`: the size cap for PDFs, 25MB by default. Images and videos keep `media.maxUploadBytes` (10MB by default).
- **`GET /v1/capabilities`** reports `maxDocumentUploadBytes` and `mediaUploadExtensions`, so the admin offers PDF uploads only to sites that take them.

### Fixed

- **`push` uploads media a page links to from rich text.** Since 0.10.3 it counted only whole `/media/` values (image, video and link fields), so a PDF linked inside rich text would have gone live without its file. `href` and `src` attributes now count too; a `/media/` path mentioned in prose still doesn't.

## [0.10.3] - 2026-11-04

### Fixed

- **`push` no longer mistakes a `/media/` path in a page's text for an image the page uses.** It counted every `/media/...` it found anywhere in a page, so a page that mentions one in prose or an example command (a docs or marketing page, say) stopped the push with "These images are used by pages being pushed, but are missing here and on the live site". Now only a value that is wholly a `/media/` path, which is how an image or video field stores its file, counts as a reference.

## [0.10.2] - 2026-11-04

### Fixed

- **A site with no `media/` folder serves and stores media normally.** `media/` is git-ignored, so a site deployed by a host that builds from its repository (Railway, for one) starts without it. Until now every request for a media file there answered 500 instead of 404, and the first upload failed the same way. A missing folder now reads as an empty one, and the first upload creates it.

## [0.10.1] - 2026-10-15

### Changed

- **Published as `@minamocms/framework`**, the first release under the new name, with everything listed under 0.10.0. 0.10.0 was tagged but never published: npm refused the unscoped name `minamo` as too like existing packages' names. Start a new site with `npx -p @minamocms/framework create-site my-site`.
- **Moving a site from `@o-a/cms-agent`:** from `vhost/`, run `npm run upgrade`. On 0.9.3 that moves the site over to `@minamocms/framework`, switching its dependency and `server.js` to the new name; on 0.6.0 to 0.9.2 it first upgrades to 0.9.3, so run it a second time. On 0.5.x, run `npm install @o-a/cms-agent@0.9.3 --save-exact` and `npx upgrade-site --finish` first. Then test and `npm run push --cms` as for any upgrade.

## [0.10.0] - 2026-10-15 (not published)

### Changed

- **Renamed to Minamo.** The CMS is now called Minamo, and this package replaces `@o-a/cms-agent`. New sites depend on it and their `vhost/server.js` imports it. The licence is unchanged (FSL-1.1-ALv2) and now named in `package.json`.
- **A redeploy also refreshes `vhost/server.js`** on the live volume, alongside the installed CMS, since it imports the CMS by name. Nothing else on the volume changes.
- **New sites' starter content is Minamo's**, in place of Granite CMS: its copy, logo, page titles and footer, and the comparison section's `minamo`/`minamoLabel` settings (were `granite`/`graniteLabel`; existing sites' themes are their own and unchanged). Its sample commands are real ones, and its GitHub link is the framework's repository. A live site that isn't a CMS site is now reported as "not a Minamo site".
- Commits the CMS makes itself (checkpoints, and a recovered `.git` on first boot) are authored as `Minamo` in place of `CMS Agent`.

## [0.9.3] - 2026-10-15

### Changed

- **`npm run upgrade` looks for the CMS as `@minamocms/framework`.** npm refused the unscoped name `minamo`, so 0.9.2's handover never finds anything to move to. From 0.9.3, once `@minamocms/framework` has a newer version, the upgrade moves the site over to it.

## [0.9.2] - 2026-10-15

### Changed

- **The CMS is now called Minamo, and from 0.10.0 it is published as `minamo`** in place of `@o-a/cms-agent`. `npm run upgrade` looks for it under the new name: once `minamo` has a newer version, the upgrade moves the site over, swapping the dependency in `vhost/package.json`, then finishes as any upgrade does. Until then it upgrades exactly as before.

## [0.9.1] - 2026-10-01

### Added

- **`GET /v1/deleted-pages`** now also returns each page's `name` (as the admin's page tree shows it), alongside its `title`.

## [0.9.0] - 2026-10-01

### Added

- **`GET /v1/deleted-pages`** lists pages deleted in the last 90 days that aren't back, newest first, with who deleted them and when, and the version to restore each from with `POST /v1/git/revert`. Read from git's own record of deletions; a moved page isn't a deletion, and a page that exists again (live or as a draft) isn't listed.

## [0.8.0] - 2026-09-29

### Added

- **Moving a page keeps links to it working.** Every internal link to the page, or to a page under it, is rewritten to the new address in live pages, drafts, menus and the site settings, in the same commit as the move (whole-value paths such as link fields and menu items, and `href`s in rich text; `?query`, `#fragment` and a trailing slash are kept). The 301 redirect is still added for links from elsewhere. `GET /v1/links?to=/a-page` lists what links to a page, for the admin to show before a delete.
- **Link fields suggest the site's pages.** `"format": "url"` is the documented name for a link field (Shopify's word); in the admin it suggests the site's pages by title or path, stores the page's path, still takes any external, `mailto:`, `tel:` or `#anchor` address, and says which page a path reaches or that none is there. The menu item editor and the rich-text link dialog use the same field. `"format": "uri"`, the name before, still works, and `npm run check` now lists it under Suggestions, which never fail the check. Neither is enforced as a strict URI, so a site path such as `/about` is always accepted, and neither prints an "unknown format" warning.
- **Field groups.** A `"group"` on a field in a section, block or site settings schema puts it under a collapsible heading in the admin, with others sharing that group. A plain annotation like `"title"`: names and templates are unchanged. New sites group their settings into Social links and Typography.

### Changed

- **AGENTS.md and the guides catch up.** New sites' AGENTS.md documents the `url` link field, field groups (with advice on grouping well), `theme/config/`, the rule that internal links are paths, `npm run check`'s Suggestions, and the current pull/push model (the old text said push never touches the theme). Favicons are now documented as belonging in `theme/assets/`, linked from the layout; `theme/root/` is optional and only for files that must sit at an exact root path. The content guide's `schemaVersion` is corrected to 7.

### Fixed

- **Moving a page takes its draft with it.** The draft used to stay at the old address, where it became a draft-only page. A move is also refused when a draft-only page already sits at the destination.
- **A site with no `content/drafts` folder can preview and save drafts.** Git keeps no empty folders, so a site cloned or deployed from git with no drafts has none, and every preview and draft save failed with a 500. The folder is now made at start-up.
- **`npm run push` no longer waits in vain on a CMS upgrade the host can't build.** A deploy builds the version `vhost/package.json` names, so if that disagrees with the version installed here (seen on a real site: package.json put back to the old version after an upgrade), the live site stays on the old version and push used to wait ten minutes for it. Push now stops before deploying and says how to fix `package.json`.
- **Site settings move to `theme/config/site_settings.json`.** Shopify's VS Code extension checks any `config/settings_schema.json` against Shopify's own format and marks Granite's as wrong (on one real site, the file was then rewritten into Shopify's form and stopped working). The form is unchanged: JSON Schema, like a section's `{% schema %}`. A `settings_schema.json` in that form is still read, with a warning to rename it; one in Shopify's form is left alone.

## [0.7.1] - 2026-09-29

### Added

- **Preview unsaved site settings.** `GET /v1/preview/*` takes `?settings=<JSON>`: site settings changed in the admin but not saved, rendered in place of the saved ones and written nowhere. Values the theme's schema rejects are ignored and the saved settings shown. The admin's Settings screen uses it to preview changes as they are made.

## [0.7.0] - 2026-09-28

### Added

- **Site settings.** A theme defines site-wide settings in `theme/config/settings_schema.json` - social links, a font choice, anything a whole site shares - in the same JSON Schema form as a section's `{% schema %}`. Every layout, section, block and snippet reads them as `{{ settings.<name> }}`, with the theme's defaults filling anything not yet saved. The values are content, in `content/settings.json`: `GET /v1/settings` returns the schema, the saved values and what templates see; `PUT /v1/settings` (If-Match) validates, commits and puts them live at once, like a menu. Saving refreshes every cached page. New sites' footer links and body font are site settings. `npm run pull` and `npm run push` carry site settings with content, protected the same way (settings changed on the live site since the pull stop a push; a copy with no `settings.json` never clears the live ones). The admin has a matching Settings screen.

## [0.6.1] - 2026-09-28

### Changed

- **`npm run push` works on a copy that has never pulled** - a site built locally and deployed, for example. The live site as it is now stands in for the pull: everything that differs locally is listed as a new or updated page, theme file or redirect, with a warning to check it, and nothing is deleted from the live site (a live page missing locally may be one an editor made). Afterwards only what the copy and the live site agree on is recorded, so live pages the copy never had are left alone by later pushes too. A CMS upgrade on its own no longer needs a pull. With no record, push asks for the site's address.

## [0.6.0] - 2026-09-28

### Added

- **`npm run pull` and `npm run push` handle the theme too.** Both now ask what to include, with checkboxes for **Content** and **Theme** (`--content` and `--theme` choose without asking); push shows how many changes each has. Theme sync uses three new routes, all needing the `theme` token scope: `GET /v1/theme/files`, `GET /v1/theme/files/*` and `POST /v1/theme/push`. A theme push is protected like content (a file changed on the live site since the pull stops it), is refused if a Liquid template can't be parsed, commits once, and takes effect immediately with no restart. The theme is pushed before content, so pages using a new section type arrive after the theme that defines it.

- **`npm run upgrade` upgrades the CMS on your computer** (`upgrade-site`, a new bin), for testing before `npm run push` puts it live. It shows the new version's changelog entries, asks, installs it, and then hands over to the new version, which puts back its own files in `vhost/` (`Dockerfile`, `docker-entrypoint.sh`, `server.js`, `.dockerignore`, and its scripts in `package.json`, keeping the developer's own), updates content to the new format, and runs the site check. Nothing is committed. `CHANGELOG.md` now ships in the package so the upgrade can show it. Sites on 0.5.x run their first upgrade as `npm install @o-a/cms-agent@0.6.0 --save-exact` then `npx upgrade-site --finish`.

- **`npm run push` can upgrade the live site's CMS.** When the CMS here is newer than the live site's, push offers a third choice, **CMS upgrade** (`--cms` for scripts). It deploys, after the site's address is typed, using the command in `vhost/deploy.json` if there is one (`{ "command": "git push" }`, or any command that deploys the site), otherwise Railway (`railway up`) or Fly.io (`fly deploy`) when the site is set up for them, otherwise it pauses while you deploy by hand. It then waits for the live site to report the new version and for its home page to load, and only then plans and sends content and theme, with their own list and confirmation. A live site on an older content format only accepts content and theme together with the upgrade.

### Fixed

- **A pull rewrote `redirects.json` even when the live redirects were the same,** which showed as a change (only the file's formatting differed). It's now left alone unless the redirects differ.
- **Nine of the scaffold's starter pages had no `name`,** which the page format has required since content schema 5. They rendered, because the display falls back to the title, but updating their content format validates them, so every new site's first upgrade would have failed on its own starter pages.

### Changed

- **A running site reloads its theme without a restart** after a theme push. Routes now read the theme from one shared `ThemeState` rather than a copy taken at start-up, and cached pages are keyed on the theme too.
- **The content-format update can leave its changes uncommitted** (`runMigrations(..., { commit: false })`), which `npm run upgrade` uses.
- **The pull record is kept per part** (content, theme), so either can be pulled alone. Records written by 0.5.5 are still read, as the content part.

## [0.5.5] - 2026-09-28

### Added

- **`npm run push` sends local content changes back to the live site** (`push-site`, a new bin). It compares each page and menu as last pulled, as it is locally, and as it is live now, and pushes only local changes: a page changed on the live site since the pull is never overwritten (it stops the push and is listed as a conflict), and a live page is only deleted if it was deleted locally. Missing images the pushed pages use are uploaded under the same names. It lists every change, warns that it overwrites the live site, and asks for the site's address to be typed; `--dry-run` only lists. Page and menu changes go as one batch, one commit, or not at all. `npm run pull` now records what it pulled, which push needs. Existing sites add `"push": "push-site"` to `vhost/package.json`'s scripts.

### Changed

- **`npm run pull` asks for what it needs**: the live site's address when none is given, then the token when neither `CMS_TOKEN` nor `--token` is, without showing what is typed or pasted, so the token never lands in shell history. An address can be typed as `my-site.example` (taken as `https://`) or `localhost:3600` (`http://`), and is checked before the token is asked for. Piped input still works (address, then token, one per line), so scripts are unaffected.

## [0.5.4] - 2026-09-28

### Added

- **`npm run pull` copies a running site's content and media into a local one** (`pull-site`, a new bin): `CMS_TOKEN=<token> npm run pull -- <url>` from `vhost/`. Pages, menus, drafts and redirects are mirrored and missing media downloaded, through the `/v1/` API, so it works wherever the site is hosted. The theme is never touched and nothing is committed. It refuses while `content/` has uncommitted changes (`--force` overrides), refuses a live site on a newer content schema, and checks every server-supplied path before it becomes a local file. Existing sites add `"pull": "pull-site"` to `vhost/package.json`'s scripts.

## [0.5.3] - 2026-09-24

### Added

- **`npm run stop` stops a site from any terminal**, not only the one it was started in (`stop-site`, a new bin). The server records the process to stop in `vhost/data/server.pid`; under `npm run dev` that is the watcher, so both it and the server end. It sends `SIGTERM` (the same graceful shutdown as Ctrl+C) and only to a process still answering as a site on the recorded port. Starting a site that is already running now says so instead of reporting a bare port conflict. Existing sites add `"stop": "stop-site"` to `vhost/package.json`'s scripts.

## [0.5.2] - 2026-09-24

### Added

- **A menu can have a display name**, separate from its handle: an optional, non-empty `"name"` in `content/menus/<handle>.json` (content schema 7, with an identity migration - no existing menu needs a value). Layouts can print it as `{{ menus.<handle>.name }}`, for example as a footer column heading. Renaming a menu this way never affects a layout.
- **A menu's handle can be changed** with `POST /v1/menus/rename` (`{ from, to, message, author }`, If-Match): one commit through the write queue, refusing a handle that is taken, a stale ETag, a missing menu, and anything but letters, numbers, hyphens and underscores. It returns the theme files still using the old handle, since every one of them now renders an empty menu until updated.
- **`GET /v1/menus/references?handle=<handle>`** lists the theme files that use a handle (`menus.<handle>` or `menus['<handle>']`, as a whole name only), so a client can warn before a rename or delete.

### Fixed

- **Redeploying never upgraded the agent on an existing volume.** The scaffolded `docker-entrypoint.sh` copied the image onto `/site` on first boot only, so the installed `@o-a/cms-agent` on a persistent volume was never replaced, and the only way to upgrade was destroying the volume and every live edit with it. Every later boot now refreshes `vhost/package.json`, `package-lock.json` and `node_modules` from the image and touches nothing else. Existing sites need this script copied into their own `vhost/` once.
- **A renamed or deleted menu left cached pages showing their old navigation.** The render cache's menu freshness check used the newest menu file's modification time; a rename keeps that time and a delete removes a file, so when the changed menu was not the most recently edited one, nothing moved. The menus directory's own modification time now counts too.

## [0.5.1] - 2026-09-19

### Fixed

- **`seed-media` could not be run the way every document said to run it.** `npx seed-media . <file>` from the site directory never worked: there is no `package.json` or `node_modules` at the site root - the CMS is installed under `vhost/` - so npx resolves nothing locally, asks the public registry for a package called "seed-media" and fails with a 404, *while still exiting 0*. A generated site consequently put all 28 of its images in `theme/root/images/`, because the one documented route into `media/` was a dead end that reported no error. The generated `vhost/package.json` now exposes a `seed-media` script, exactly as it already did for `check`, and both documents give the working form: `npm run seed-media -- .. <file>` from `vhost/`.
- **`npm run check` now reports a content image or video served from `theme/root/` or `theme/assets/`** as a `misplaced-media` finding. This had no other way of being noticed: the file exists, so the page renders perfectly, and the only symptom is that the media library never shows the image and an editor can never replace it. The rule keys off the same extension list the upload route accepts, so the two cannot drift, and only examines `src`/`srcset`/`poster` - an `href` is a link or a favicon, and `.svg` is absent from that list, so a site's own icon and an inline logo are not mistaken for misplaced photographs.
- **A `mailto:` link was reported as a missing file**, because the text after the "@" contains a dot and so looked like a filename. One real site produced 39 such findings and not a single true one - output that noisy trains whoever reads it to ignore the check entirely. Any non-http scheme (`mailto:`, `tel:`, and anything future) is now skipped.
- **A video's `poster` was never checked at all.** It is a real content image reference and is now scanned alongside `src` and `srcset`.
- **A site with no `media/`, `theme/assets/` or `theme/root/` directory crashed the check** with a raw `ENOENT` instead of reporting the missing file, because path sanitisation resolves its root argument unconditionally. The guard fell over on exactly the sites most likely to hold a broken reference. A root directory that does not exist now means the file does not exist, which is an ordinary finding.

## [0.5.0] - 2026-09-18

### Added

- **Every scaffolded site now ships `theme/snippets/responsive-media.liquid`**, and the scaffold uses it: `hero` gains an image setting and `cta-banner` a short silent background loop. It renders a `format: "image"` or `format: "video"` setting and marks the result as a drag-and-drop target, so an editor can drag a file from the admin's media library straight onto the picture in the live preview. Until now the scaffold shipped no image snippet at all, and not one of its sections or blocks even had an image setting, so a theme author had nothing to copy.
  - It deliberately builds no `srcset`. Uploaded files are named by a hash of their own bytes, so a resized variant's name is not derivable from the original's URL - hand-built variant URLs point at files that do not exist, producing a page that looks perfect except at one breakpoint, which is precisely the failure `npm run check` exists to catch.
  - An unset image renders nothing at all rather than a placeholder. A theme cannot tell whether it is rendering for the admin preview or for the public site, so an editor-only affordance would show to real visitors.
  - A video slot emits `data-cms-media`/`data-cms-media-kind` but never `data-cms-image`. An admin predating video support understands only the older attribute and would write an image-shaped value (`{ url, focalX, focalY }`) straight over the field's own `{ url, poster }` - better it ignores the slot than corrupts it.

### Fixed

- **The attribute that makes an image editable was documented nowhere.** Drag-and-drop finds a drop target purely by looking for `data-cms-image` in the previewed page, and no document in this project mentioned it. A real generated site consequently shipped with every image un-editable: the theme rendered perfectly, images simply were not droppable, and nothing about the page looked wrong. `AGENTS.md` and `guide-theme-authoring.md` now both spell out the contract, and do so at each point an image actually comes up rather than in one section near the end.
- **`AGENTS.md` said an image "is just a plain string setting"**, treating `format: "image"` as the exception for when a focal point is wanted. That is backwards: a drop writes an object, so a string-declared field fails validation outright. The object form is now the documented default, and the `seed-media` example that still produced a plain string has been corrected to match.
- **Both guides told authors to hand-write the markup** - `{{ section.settings.<field>.url }}` for an image, a bare `<video>` for a loop. Both now point at the snippet, including the format table rows, the worked example a section is copied from, and the snippets section itself.

## [0.4.0] - 2026-09-17

### Added

- **The media library now accepts and serves video** (`.mp4` and `.webm`), for the short silent loops that stand in for a hero image rather than long-form video. Same 10MB cap as any other upload - anything longer belongs on YouTube or Vimeo, embedded. `.svg` stays rejected (it is never sanitised, so it is a stored-XSS path when loaded as a top-level navigation), and `.mov` with it, since QuickTime frequently will not play in Chrome or Firefox at all.
- **Real HTTP Range support on `/media/*`**: `Accept-Ranges: bytes` on every response, a `206` with `Content-Range` for a satisfiable range, and a `416` for one starting past the end. This is not a bandwidth optimisation. Safari and iOS open a `<video>` with `Range: bytes=0-1` and refuse to play at all without a `206` in reply, so hosted video simply did not work before this. A suffix range (`bytes=-500`) correctly means the *last* 500 bytes rather than the first, an end past the last byte is clamped rather than rejected (browsers routinely overshoot), and a multi-range request falls back to sending the whole file rather than answering with an incorrect multipart body.
- **`format: "video"`** is now a recognised UI hint on an `"type": "object"` setting, storing `{ url, poster }`. The admin renders a video picker with a poster picker for it, in place of the raw-JSON fallback an unrecognised object shape otherwise gets.

### Documentation

- **The scaffold's `AGENTS.md` now says where images actually go.** An agent building a real site from it put every image in the site root, twice running. `assets/` is now described as design assets only, the workflow names the `seed-media` step and `npm run check` explicitly, and the Images section leads with where images live. It also states plainly that one image is one file and one URL, and that the CMS does not generate resized variants - previously left to inference.
- **`format: "video"` is documented in both `AGENTS.md` and `guide-theme-authoring.md`.** Both present their format table as an exhaustive, closed set ("never invent a new setting field shape"), so leaving the new value out did not merely omit it - it actively told theme authors the field did not exist.

## [0.3.1] - 2026-09-17

### Fixed

- **The scaffold's own `AGENTS.md` now explains what a page's `type` does.** It was described only as "free-form", with nothing saying that a template's `type` is inherited by every page created from it, or that the value is what `GET /search.json?pageType=...` filters on. An Article template left at `"type": "page"` therefore produces articles no blog index can find - and because it still validates and previews perfectly, nothing signals the mistake. Documentation only; no code change.

## [0.3.0] - 2026-09-17

### Added

- **`POST /v1/publish-page/:path`**: sets `published: true` on a live page in place and commits - the exact twin of the existing `POST /v1/unpublish/:path`. Deliberately separate from `POST /v1/publish`, which promotes drafts: a page that is live but unpublished has no draft to promote, so publish could not reach it at all, and promoting a draft would push every pending edit live alongside the flag. Like unpublish, it never touches a draft, so a page with unpublished edits keeps them.

## [0.2.2] - 2026-09-09

Three gaps found by having a different AI agent build a real demo site from `AGENTS.md` and report back what it wished were different.

### Fixed

- **The search index now keeps itself current automatically.** Previously `GET /search.json` stayed empty forever on a fresh site and stale forever after a real edit - nothing ever rebuilt it except a caller manually hitting `POST /v1/search/rebuild`. It now rebuilds in the background after every publish/unpublish/delete/move/batch write, and once at boot if no index exists yet (the index is never git-tracked, so a fresh clone starts with none). Fire-and-forget in both cases - a slow or failed reindex never blocks or fails the write that triggered it.

### Added

- **Sections and blocks can now render `page.author`, `page.publishDate`, and `page.tags`** - the same built-in envelope a layout already got (previously just `page.title`), widened and made available to section/block templates too, not just layouts. Closes a real gap: these fields were already indexed for search but had no way to actually appear on the rendered page without duplicating the value into a settings field.
- **A broken theme component now prints a boot warning instead of vanishing silently.** A section/block with no `{% schema %}` block, invalid JSON in it, or a required property with no valid default was already excluded from the theme (unchanged, still never a boot failure) - it just did so with zero output anywhere. `loadThemeSchemas` now names each excluded type and the specific reason.

## [0.2.1] - 2026-09-09

### Added

- **A new `AGENTS.md` in every scaffolded site**, onboarding an AI coding agent to this specific CMS's conventions: theme folder structure, the section/block `{% schema %}` pattern with worked examples, the `format` field-hint table, the current content JSON model, image handling, `GET /search.json`, and the hard constraints. Self-contained - no external link, since generated content shouldn't depend on a live docs site being reachable.

## [0.2.0] - 2026-09-09

### Breaking changes

- **The distinct "post" content type is gone.** `author`, `publishDate`, and `tags` are now optional fields any page may carry - there is no separate schema, and `/blog` is no longer a reserved URL namespace (a page can live at `/blog/<slug>` the same way it can live anywhere else, by nesting it under a `blog` page). A new `schemaVersion` 6 migration relocates any existing `content/posts/<slug>.json` file to `content/pages/blog/<slug>.json`, preserving its old URL, and backfills a `name` field if it doesn't already have one.
  - **Known gap**: there's no automatic migration trigger at boot, and no CLI command runs one either (`runMigrations` exists in `src/services/migration-runner.ts` but nothing currently calls it outside tests). No adopter currently has content under `content/posts/`, so this doesn't affect anyone today - but the migration path itself needs a real trigger mechanism before it would.
- **`GET /v1/search` has moved to `GET /search.json`, unprefixed.** The old path is removed outright, not kept as an alias. Update any theme code calling it directly. The endpoint's behaviour (full-text search, structured filters, sort, pagination) is unchanged - only the path moved, out from under the versioned `/v1/` admin/integration surface to reflect that it's a stable, public, front-end-facing contract instead.
- **Uploaded media filenames changed shape**: `<slug>-<hash>.<ext>` instead of `<hash>-<slug>.<ext>` for new uploads. Still the same content-addressed name (a sha256 hash of the file's own bytes); only the order changed, so the readable part sorts first in a directory listing or URL. Existing uploaded files are untouched - this only affects new uploads going forward.

### Added

- **`GET /search.json`**: one unified, genuinely public query endpoint - no bearer token required, full-text search (`q`), structured filters (`filter=field:op:value`, repeatable, AND'd together), sort, and pagination in a single response. Replaces an earlier, narrower `GET /v1/search/fields` that queried one field at a time.
- **A new `"api": true` JSON Schema keyword** for section/block settings, exposing that field's value through the search index for structured filtering (e.g. `filter=price:lt:50`) - independent of full-text search.
- **`GET /admin`**: a configurable, opt-in redirect to your admin instance. Set `adminBaseUrl` in `site.config.json` and visiting `yoursite.com/admin` redirects there with `?site=<host>` appended, so the admin can resolve straight to this site's own dashboard. Leave it unset and the route doesn't exist at all - a site can still use "admin" as an ordinary page path.
- **An in-process render cache for public pages.** Previously every request re-read and re-rendered a page from scratch; rendered HTML is now cached and validated against real file mtimes (the page's own file, plus every menu file, since menus render into every page's nav), so a repeat request for an unchanged page skips rendering entirely.
- **`Cache-Control: public, max-age=31536000, immutable`** on every media response - safe unconditionally, since filenames are content-addressed and a given URL's bytes can never change.

### Fixed

- **`engines.node` was wrong and is now `>=22.16.0`, not `>=22.6.0`.** The old floor was never actually verified against real Node builds: `node:sqlite` needs `--experimental-sqlite` below Node 22.13.0 (never passed anywhere in this package), and FTS5 support itself - the search index's own full-text engine - isn't compiled in at all until Node 22.16.0. Every version from the old floor up to 22.15.x would hard-crash the moment a search index rebuild ran. Confirmed by downloading and testing real Node builds directly, not assumed from release notes.
- **A search index rebuild no longer blocks the entire server.** `rebuildIndexJob` was `async` but had no real `await` in its body, so on a busy site a rebuild froze every other request (not just search) for its whole duration. It now yields to the event loop periodically during a rebuild.
- **A search index rebuild is now atomic.** Previously the index file was deleted then recreated in place, a real window where a concurrent read could see a missing file or one with no tables yet. It's now built into a temp file and swapped in via an atomic rename.

### Documentation

- Caught up `guide-theme-authoring.md` (then named `theme-authoring-guide.md`) on several already-shipped theme field conventions that were undocumented or stale: `format: "richtext"`, `format: "image"` (with focal-point support), `format: "color"`'s `swatches` keyword, the range field format, the consolidated toggle/select field formats.
