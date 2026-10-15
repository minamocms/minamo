# Minamo framework

**Own your content, forever.**

The Minamo framework is a self-hosted web framework for content sites,
built on Liquid templates. Every page is a plain JSON file. Every publish
is a real git commit. There is no database standing between you and your
own content, and there never will be. Editors manage a site through the
Minamo CMS, or any tool that speaks its versioned API.

If you've ever had a headless CMS raise its prices, change its export
format, or go down and take your site's editing with it - this is built to
make that structurally impossible. Your site and its content stay yours:
moving away is `git clone`. That's the whole migration story.

## Why this is different

Most self-hosted, code-first CMS options give you an API and a database.
Most git-based CMS tools give you markdown files and a static-site rebuild.
The Minamo framework is the combination neither of those is:

- **Git-native content.** Pages, posts, menus, and redirects are JSON files
  in your own git repository. No database is ever the source of truth.
  History, diffs, and rollback are real git operations, not a bolted-on
  revisions table.
- **A real page builder, not just files.** Themes define reusable, schema
  validated **sections** and **blocks** - a Shopify-style content model - so
  a non-technical editor arranges and fills in components a developer
  already built, instead of hand-editing markdown or JSON.
- **A real versioned HTTP API.** `/v1/...` is the only thing a site exposes.
  Drafts, publishing, optimistic concurrency (ETags + `If-Match`), batch
  writes, and git history are all first-class API operations - what the
  Minamo admin (or your own tooling) talks to, never the filesystem
  directly.

## Two audiences, one framework

- **Developers** build the theme: Liquid layouts, sections, and blocks,
  each with an embedded JSON Schema for its settings. Start with
  [`docs/guide-theme-authoring.md`](docs/guide-theme-authoring.md).
- **Content editors / marketing managers** never touch this repository at
  all - they work entirely through the Minamo admin (see
  [Editing with Minamo](#editing-with-minamo) below), browsing pages,
  editing sections, and publishing through the API this package exposes.
  The content model itself is documented in
  [`docs/guide-content-authoring.md`](docs/guide-content-authoring.md).

## Quick start

```
npx -p @minamocms/framework create-site my-site
cd my-site/vhost
npm install
npm start
```

Visit `http://localhost:3000`. `create-site` prints a real API token to
your terminal when it scaffolds the site - that's what the Minamo admin
(or a plain `curl`) uses to authenticate against the site's
`/v1/` API. Lost it, or need a second one? See the `mint-token` command in
the same docs page.

## Project layout

A scaffolded site is a thin, four-folder scaffold - everything a content
editor touches lives under `content/`, everything a developer touches lives
under `theme/`, uploaded media lives under `media/` (never git-tracked),
and the site's own serving configuration lives under `vhost/`:

```
my-site/
  content/   pages, menus, redirects, drafts
  theme/     layouts, sections, blocks, snippets, assets, root, templates
  media/     uploaded files - gitignored, backed up separately
  vhost/     site.config.json, package.json, server.js
```

This repository (the framework itself, the `@minamocms/framework` package) is developed
separately and installed as a versioned dependency - see [`docs/cms-build-plan.md`](docs/cms-build-plan.md)
for the full architecture and the reasoning behind it.

## Tech stack

Node.js 22+ and TypeScript, compiled to plain JavaScript for distribution.
Fastify, LiquidJS (sandboxed - no dynamically registered tags or filters,
ever), SQLite via `node:sqlite` for a fully disposable, rebuildable search
index, and the real `git` binary for every content mutation. Dependencies
are kept deliberately minimal - this ships as a package other people
install.

## Documentation

- [`docs/guide-theme-authoring.md`](docs/guide-theme-authoring.md) - building a theme
- [`docs/guide-content-authoring.md`](docs/guide-content-authoring.md) - the content model
- [`docs/guide-hosting.md`](docs/guide-hosting.md) - running a site somewhere real
- [`docs/cms-build-plan.md`](docs/cms-build-plan.md) - full architecture and design rationale

Friendlier, browsable documentation, covering both this framework and the
Minamo admin, is at [docs.minamocms.com](https://docs.minamocms.com).

## Editing with Minamo

The framework has no user interface of its own by design - it's an API.
Day-to-day editing happens in the Minamo admin, a hosted service that
manages any number of independently hosted sites. Your sites stay yours:
they run wherever you host them, their content is in your own git
repository, and the admin reaches them only through the versioned `/v1/`
API above, with the site's own token. Anything else that speaks that API
works too.

## Upgrading from `@o-a/cms-agent`

Up to 0.9.x this package was published as `@o-a/cms-agent` (and the
project was called Granite CMS). From `vhost/`, run `npm run upgrade`: on
0.9.3 it moves the site over to `@minamocms/framework`, and on 0.6.0 to 0.9.2 it first
reaches 0.9.3, so run it a second time. On 0.5.x, run
`npm install @o-a/cms-agent@0.9.3 --save-exact` and
`npx upgrade-site --finish` first.

## Project status

This is young, real software - it runs a genuine production site today,
not just a demo, but it has one tenant so far, not thousands. Expect rough
edges, expect things to improve in the open rather than arrive finished,
and please open an issue if something doesn't work the way this README
says it should.

## License

[Functional Source License, Version 1.1, Apache 2.0 Future Grant](LICENSE)
(FSL-1.1-ALv2). In short: free to use, modify, and self-host for anything
except offering it as a competing hosted service. Every version converts
automatically to the fully permissive Apache License 2.0 two years after
its own release - this is a head start, not a permanent restriction.
