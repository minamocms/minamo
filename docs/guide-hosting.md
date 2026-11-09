# Hosting a site

This document is for a developer who has run `create-site` and now wants to run that site somewhere real. It covers what the runtime actually requires, installing dependencies, and three genuinely different hosting shapes.

## Requirements

- **Node >=22.16.0.** Enforced at boot (`services/startup-checks.ts` reads the floor from the agent's own `package.json`) - a site simply refuses to start on anything older. This is higher than Node 22's own LTS baseline: `node:sqlite`'s FTS5 support (the search index's own full-text engine) isn't compiled in before 22.16.0, confirmed empirically by bisecting real Node builds - 22.6.0 through 22.15.x load `node:sqlite` fine but fail with `no such module: fts5` the moment a search rebuild runs.
- **The `git` binary, on `PATH`, and the site root must already be a real git repository.** This is not a convenience feature - content, drafts and every publish are real git operations (`services/git.ts`), never a database. There is no fallback. Hosts without shell-exec and a `git` binary cannot run this at all.
- **Persistent storage for the whole site root** (`content/`, `theme/`, `media/`, `vhost/data/`), not just `media/`. Drafts and publishes are commits made by the running server itself - if that disk isn't persistent, every commit since the last deploy is lost on restart.
- No database, no required environment variables, no external service dependencies beyond the above.

## Installing `@minamocms/framework`

`@minamocms/framework` is published to the public npm registry (it was `@o-a/cms-agent` up to 0.9.x; see the deploying guide's "Upgrading the CMS" to move a site over). A freshly scaffolded site's `vhost/package.json` already pins a real, exact-version dependency on it (never a `^` range - even a minor bump can be breaking pre-1.0), so a normal install just resolves it like any other dependency:

```
cd vhost
npm install
```

`e2e/create-site-packaging.check.ts` (test J4) proves this end to end against a real `npm pack` + `npm install` + `node server.js` cycle, not just a unit test of the scaffolding logic.

## `site.config.json` reference

All fields are optional. A missing file, or a missing field within it, falls back to the default shown - this is the safe, default-secure state (a zero-token site fails closed on every write route), not an error. A malformed file, on the other hand, is a hard startup failure.

| Field | Default | Notes |
|---|---|---|
| `port` | `3000` | Must match the `EXPOSE`d port if you're building the scaffolded `vhost/Dockerfile` unmodified. Overridden by the `PORT` environment variable if set (e.g. `PORT=3001 node server.js`) - no file edit needed for a quick local port change, and several hosting platforms already inject `PORT` this way. |
| `tokens` | `[]` | Array of `{ hash, scopes }`. `hash` is a sha256 hex digest of the real token, never the raw token itself. `scopes` is any of `content`, `theme`, `media`. Rotating a token requires a restart - it's loaded once at boot. |
| `rateLimit` | `{ max: 60, windowMs: 60000 }` | Per-IP. |
| `trustProxy` | `false` | Set `true` when a reverse proxy or platform edge sits in front of this process, so client IPs (used by `ipAllowlist` and rate limiting) are read correctly rather than seeing the proxy's own address. |
| `ipAllowlist` | `[]` | Empty means no restriction, not "nothing allowed". |
| `checkpointIntervalMs` | `1800000` (30 min) | How often open drafts are auto-committed as a safety checkpoint. |
| `media.maxUploadBytes` | `10485760` (10MB) | The cap for images and videos. |
| `media.maxDocumentUploadBytes` | `26214400` (25MB) | The cap for PDFs, the one document type. Larger by default because a print-ready brochure or a long price list routinely runs past 10MB. |
| `adminBaseUrl` | `https://cms.minamo.app` | Where `GET /admin` sends a visitor: the admin that manages this site, with `?site=<host>` appended so the admin opens this site's editor directly. Set another absolute `http(s)` URL for a different admin, or `false` to turn the redirect off. A real page, a redirect or a `theme/root/` file at `/admin` always wins, so a site can still have its own page there. See "Linking to the admin" below. |

## Access tokens

The site keeps only a sha256 hash of each token (`tokens` in `vhost/site.config.json`), so a lost token can't be recovered, only replaced. `mint-token <site-directory> [--scopes content,theme,media]` adds a new token (all three scopes by default), commits the changed config, and prints the raw token once. It never changes or removes existing tokens. Tokens are read only at boot, so **restart the site** before using the new one.

- **Before the site is live:** from the site's root, run `npx -p @minamocms/framework mint-token .`, then restart. The config is git-tracked and baked into the image, so a first deploy starts with that token.
- **On a live site:** a redeploy never replaces the volume's `vhost/site.config.json` (see Docker below), so a token minted locally is refused by the live site. Mint it where the site runs instead. For the scaffolded Docker image, open a shell in the container (`railway ssh`, `fly ssh console`, `docker exec`), run `cd /site/vhost && npx -p @minamocms/framework mint-token /site`, then restart the service and paste the token into the admin's **Change access token**.
- **Removing a token** (one that may have leaked, not merely been lost): delete its entry from `tokens` where the site runs and restart. Entries are hashes and can't be told apart, so when unsure, clear the list and mint fresh tokens for every client.

Always name the package with `-p @minamocms/framework`: a bare `npx mint-token` run anywhere the framework isn't installed fetches an unrelated npm package of the same name.

## Linking to the admin

Every site answers `yoursite.com/admin` by sending the visitor to its admin, the hosted Minamo admin at `https://cms.minamo.app` unless `adminBaseUrl` says otherwise. The address carries `?site=<host>`, so a signed-in editor lands straight in that site's editor; anyone not signed in signs in first and is then taken there. Someone without access to the site lands on the admin's usual first screen. It is a plain 302 redirect: the site itself contacts nothing, and the only thing passed along is its own address, in `?site=`.

It only happens when `/admin` would otherwise be a 404. A published page at `/admin`, a `redirects.json` entry from `/admin`, or a `theme/root/admin` file is served instead. Only `/admin` itself redirects; `/admin/anything` is an ordinary missing page.

To use a different admin, set `"adminBaseUrl": "https://admin.example.com"`. To turn it off, set `"adminBaseUrl": false`. On a live site this file lives on the server (see "Access tokens" above), and a change applies after a restart.

## Backing up media

`media/` is deliberately not git-tracked (it's binary, user-uploaded content, not source). Only one storage driver exists today - local filesystem. There is no object-storage (S3-compatible) driver yet, so backing up `media/` is entirely the operator's own responsibility on any host, container-based or not.

To seed starter media into a site directly - before deploying, without a server running - use `seed-media <site-directory> <path> [<path> ...]` (one of this package's own installed bin commands, alongside `create-site` and `mint-token`). It computes the same content-addressed filename a real `POST /v1/media` upload would, so the result is indistinguishable from one. It enforces the same allowlist as the real upload route (images, short videos and PDFs; no SVGs, no Office files), including the check that a `.pdf` really is a PDF; a disallowed file is skipped, not a reason to abort the rest of the batch.

## Three supported hosting shapes

Every shape below satisfies the same requirements above - a VPS just has a persistent disk by default where a container needs an explicit volume.

### 1. VPS / bare metal

Clone or copy the scaffolded site onto the machine, install Node 22.16+ and `git`, then `cd vhost && npm install && npm start`. `npm start` is also what several PaaS platforms run by default for a Node app with no other deploy config, so the same scaffold works unmodified there too. Run it under a process supervisor (systemd unit, `pm2`, etc.) so it restarts on crash or reboot, and put a reverse proxy (nginx, Caddy) in front for TLS - set `trustProxy: true` in `site.config.json` once you do. The disk is persistent by default; nothing extra needed for that.

### 2. Docker / any container platform

`create-site` scaffolds a working `Dockerfile` and `docker-entrypoint.sh` automatically - nothing to write by hand. They live in `vhost/`, alongside the rest of the site's own serving config, keeping the top level down to just `content/`, `theme/`, `media/`, `vhost/`. The image is generic: it bakes the site (content, theme, an already-`npm install`ed `vhost/`) into `/seed` at build time, then at container start seeds an empty `/site` from that copy on first boot, and runs the server against `/site` from then on.

Every later boot refreshes only the installed CMS from the image (`vhost/package.json`, `vhost/package-lock.json`, `vhost/node_modules` and `vhost/server.js`, which imports it by name), so redeploying with a newer `@minamocms/framework` upgrades a running site without touching its content. Everything else on the volume belongs to the live site and is left alone: content, drafts, media, `vhost/site.config.json` (its tokens), and the theme. A theme changed locally therefore does not reach an existing deployment by redeploying. After an upgrade, the volume's git working tree shows `vhost/package.json` as modified; that is expected, as nothing but a publish creates a commit.

```
docker build -f vhost/Dockerfile -t my-site .
docker run -d -p 3000:3000 -v my-site-data:/site my-site
```

The build context is still the site root (the trailing `.`) - only the Dockerfile's own location moved, not what it needs access to.

The `-v my-site-data:/site` volume is what makes drafts and publishes survive a restart or redeploy - without it, the container's writable layer is thrown away every time it's recreated, and every commit made since the image was built is lost. A second `docker run` against the same named volume reuses the already-seeded content and skips straight to starting the server.

This same image runs unmodified on Fly, ECS, or any platform that runs a container against a persistent volume - see shape 3.

### 3. PaaS with a persistent volume

The Docker image above works as-is on any platform that (a) builds from a `Dockerfile` and (b) lets you mount a persistent volume at a fixed path (here, `/site`). Health-check against `GET /v1/capabilities` - it's a real, always-available endpoint that doubles as a liveness check, not a special route added for this purpose. Any platform-specific config (build settings, health check path, restart policy) is a thin layer on top of the same portable image - it never needs to change the image itself.

What this explicitly does **not** cover: "any shared hosting." A host that can't run a persistent process, exec `git`, or mount a real disk (typical of classic shared PHP-style hosting) cannot run this today.

## Dev-mode theme watching

`npm run dev` (`node --watch-path=../theme server.js`) restarts the server automatically whenever a file under `theme/` changes - edit a section's markup or a layout, save, refresh the browser, no manual restart. This is Node's own `--watch-path` flag, not custom code: the server already handles `SIGTERM` gracefully (draft checkpoint flush, tunnel cleanup), which is exactly the signal Node's watch mode sends on a restart.

`npm run stop` (`stop-site`) stops a running site from any terminal, not only the one it was started in. On start the server records which process to stop in `vhost/data/server.pid` (disposable, never committed): the server itself, or under `npm run dev` the watcher running it, so stopping ends both rather than leaving the watcher waiting to restart it. `stop-site` sends that process `SIGTERM` - the same graceful shutdown as Ctrl+C - and waits for it to exit. It only ever signals a process that is still alive and answering as a site on the recorded port, so a leftover file from a crash is cleaned up rather than getting an unrelated process killed. Starting a site that is already running now says so, and points at `npm run stop`, instead of reporting a bare port conflict. On Windows the signal ends the process immediately rather than gracefully, so the final draft checkpoint is skipped.

`npm run pull` (`pull-site`) copies a running site's content and media into a local one, so it can be run locally with everything working, images included (`media/` is never in git, so cloning the repository alone leaves every image broken). From the local site's `vhost/`:

```
npm run pull
```

It asks for the live site's address (`my-site.example` is taken as `https://`, and `localhost:3600` or `127.0.0.1:3600` as `http://`), checks it really is a site, then asks for its access token without showing what you type or paste, so the token never lands in shell history. The address can be given instead as `npm run pull -- https://my-site.example`. For scripts, set `CMS_TOKEN`, or pipe the answers in (the address on the first line, the token on the second).

It uses the site's `/v1/` API, so it works the same wherever the site is hosted, with no SSH access. Pages, menus, drafts and redirects are mirrored - local files the live site doesn't have are removed - and any media file missing locally is downloaded (existing ones are kept; names are content-addressed, so a matching name is the same file). It first asks what to pull: **Content**, **Theme**, or both (`--content` and `--theme` choose without asking). Pulling the theme mirrors `theme/` the same way, and needs a token with the `theme` scope. Nothing is committed; review the result with `git diff`. It refuses while `content/` or `theme/` (whichever is being pulled) has uncommitted changes, since those would be overwritten (`--force` pulls anyway), and refuses a live site on a newer content schema than the local agent. The token needs the `content` and `media` scopes, and `theme` for the theme. Everything is fetched before anything is written, so a failure part way leaves the local site as it was. The live site's git history does not come across, only its current files.

`npm run push` (`push-site`) sends content changed locally since the last `npm run pull` back to that live site. It compares three versions of every page and menu - as last pulled (recorded in `vhost/data/sync-record.json`), local, and live now - and only pushes local changes:

- A page changed on the live site since the pull is never overwritten. If it was also changed locally, that is a conflict: nothing at all is pushed, and the conflicting pages are listed. To keep both, commit local work, pull, reapply it, and push again.
- A live page is only deleted if it existed at the pull and was deleted locally since; one an editor created live after the pull is left alone.
- A page with unpublished draft changes on the live site is a conflict too, since writing it would replace that draft.
- Images used by the pushed pages and missing on the live site are uploaded, under exactly the same content-addressed names.

It lists every page, redirect and image it will change, warns that this overwrites the live site immediately, and asks for the site's address to be typed before doing anything (`--dry-run` shows the list and stops). All page and menu changes go as one batch: the site publishes them in a single commit, credited to the local git `user.name` and `user.email`, or rolls the whole batch back - including if an editor saves one of those pages in the moment between checking and pushing. Redirect changes follow, one commit each. Push only ever goes back to the site the copy was pulled from. A copy that has never pulled can still push: the live site as it is now stands in for the pull, so everything that differs is listed as a create or update for the developer to check, and nothing is deleted (a live page missing locally may be an editor's). Afterwards only what the copy and the live site agree on is recorded, so live pages the copy never had are left alone by later pushes too. A CMS upgrade on its own needs no pull at all. Local drafts are not pushed.

Push also asks what to push, **Content** and/or **Theme**, showing how many changes each has. The theme is protected the same way as pages: a theme file changed on the live site since the pull stops the push, and a file is only deleted if it was deleted locally. It goes to the site as one request (`POST /v1/theme/push`): the site checks every file is still what was pulled, refuses any Liquid template that can't be parsed, writes and commits it all at once, and switches to the new theme immediately, with no restart. The theme is pushed before content, so pages using a new section type arrive after the theme that defines it. A live site on a CMS older than 0.6.0 can't sync its theme; push then offers content only.

Deliberately scoped to `theme/` only - `content/`/`drafts/` are already read fresh on every request (pages, menus, and the render cache are all re-checked per request or keyed on file mtime), so a content edit already shows up on the next request with no restart needed. Watching `content/` too would only cause a pointless restart on every draft autosave.

Combine with `--tunnel` if needed: `node --watch-path=../theme server.js --tunnel`.

## Site health checks

`npm run check` (`check-site`, one of this package's own installed bin commands) renders every published page for real and reports three classes of problem in one pass: any theme component excluded at boot (the same warnings a normal boot already prints to the console); any `<img src>`/`srcset`/`<a href>` in the rendered output pointing at a `/media/`, `/assets/`, or root-static file that doesn't exist on disk; and any internal link that doesn't resolve to a real, published page. Exits non-zero on any finding, so it's usable in CI, not just interactively.

This is a full render crawl, not a static content scan - it exists specifically to catch problems that only exist in rendered output, like a `srcset` width nothing was actually generated for. A theme/content combination can be individually well-formed and still produce a broken image at one breakpoint; nothing about validating either side alone would ever surface that.

## Local dev tunnel

`npm run tunnel` (or `node server.js --tunnel` directly) exposes a locally-running site through a public HTTPS URL, printed to stdout on boot. This is for pointing a hosted admin at a site you're actively developing locally - fast iteration on theme/content, without deploying anywhere - not a hosting mechanism in its own right.

The tunnel goes through one of two services:

- **Cloudflare**, when the `cloudflared` program is installed. On a Mac: `brew install cloudflared`. On Windows: `winget install --id Cloudflare.cloudflared`. On Linux, see Cloudflare's downloads page. No Cloudflare account is needed. This is much faster: in testing, a page took about 0.1s through it against about 1.3s through localtunnel, and a full page with its images about 0.3s against 11s.
- **localtunnel**, otherwise (or if `cloudflared` won't start). It works with nothing extra installed, but is slow and often drops images partway through loading. The startup output says which one is in use.

The address (`https://<random words>.trycloudflare.com` or `https://<random words>.loca.lt`) is new each time the site starts.

Alongside it, the terminal prints an **Edit in Minamo** link. Opening it (signed in to the Minamo admin) edits this local site straight away, without adding it to your websites. The link holds a key made when the site started: it works as an access token for this site until the site stops, and is never saved anywhere. Anyone with the link and a Minamo account can edit the site while it runs, so share it only with someone you mean to. The link goes to `adminBaseUrl` (`https://cms.minamo.app` unless set otherwise), and isn't printed when that's `false`.

If the tunnel drops while the site is running, it's reported in the terminal and reopened automatically. localtunnel asks for the same address back. A reopened Cloudflare tunnel has a new address, and the terminal prints a new Edit in Minamo link for it.

Without `--tunnel`, a normal boot just prints a one-line reminder that the option exists. With it, the tunnel closes automatically on graceful shutdown (`Ctrl+C`), same as everything else in the shutdown sequence; if the tunnel itself fails to start (network issue, etc.), the site keeps running locally regardless - a failed tunnel is never a reason the whole server fails to boot.

**This exposes the site publicly for as long as the process runs.** Anyone with the URL and a valid access token can reach it. Don't leave it running unattended, and don't use it as a substitute for real hosting.
