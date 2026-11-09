import rateLimitPlugin from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { BootedSite } from './boot.ts';
import { bootSite } from './boot.ts';
import type { ServerConfig } from './server-config.ts';
import { loadServerConfig } from './server-config.ts';
import { assetsRoutes } from './routes/assets.ts';
import { v1Routes } from './routes/index.ts';
import { mediaPublicRoutes } from './routes/media-public.ts';
import { publicRoutes } from './routes/public.ts';
import { searchPublicRoutes } from './routes/search-public.ts';
import { sitemapRoutes } from './routes/sitemap.ts';
import { CHECKPOINT_AUTHOR, runCheckpoint } from './services/checkpoint.ts';
import { createSiteConsole, type SiteConsoleStreams } from './terminal/site-console.ts';
import { readAgentVersion } from './routes/capabilities.ts';
import { DEV_CHILD_ENV, LOCAL_EDIT_KEY_ENV, localEditToken } from './services/local-edit-link.ts';
import { openInBrowser } from './terminal/shortcuts.ts';
import { startIntervalJob } from './services/interval-job.ts';
import { reindexOnBootIfMissing } from './services/reindex-on-write.ts';
import { isProcessAlive, readPidFile, removeOwnPidFile, writePidFile } from './services/pid-file.ts';

export interface BuildServerOptions {
  logger?: boolean;
}

export interface StartServerOptions extends BuildServerOptions {
  // Where the environment comes from: tests set what npm run dev
  // (dev/dev-site.ts) would. Defaults to process.env.
  env?: NodeJS.ProcessEnv;
  // Where the terminal output goes (terminal/site-console.ts): tests
  // capture it here. Defaults to the process's own.
  output?: SiteConsoleStreams;
}

// Never wrap v1Routes (or any route-group plugin it registers) with
// fastify-plugin (fp()): plain app.register() gives each file its own
// encapsulation scope by default, which Group B's auth preHandler
// hooks depend on. Wrapping would silently hoist decorators/hooks to
// the parent scope and break that later.
export function buildServer(
  booted: BootedSite,
  serverConfig: ServerConfig,
  options: BuildServerOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: serverConfig.trustProxy });

  // global: false - only routes that explicitly opt in via a
  // config: { rateLimit: {...} } marker on their own route options
  // (see src/services/rate-limit-config.ts) are ever limited. The
  // max/timeWindow set here are the configured (or defaulted)
  // site.config.json values - an opting-in route's own empty
  // { rateLimit: {} } marker inherits these, verified empirically.
  // Registered once here, on the root app (an ancestor of v1Routes and
  // everything it nests), so no individual route file needs to import
  // this plugin itself. Its own 429 response body shape
  // ({statusCode, error, message}) already matches this project's own
  // error-JSON convention exactly - verified empirically before relying
  // on it, no errorResponseBuilder override needed.
  app.register(rateLimitPlugin, {
    global: false,
    max: serverConfig.rateLimit.max,
    timeWindow: serverConfig.rateLimit.windowMs,
  });

  // Fastify's own default 500 body leaks the raw thrown Error.message
  // to the client verbatim - confirmed empirically before this was
  // written. Anything below 500 (e.g. a future route's schema-
  // validation failure) already carries a safe, specific message and
  // is passed through unchanged; only 500-and-above gets sanitised.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error(error);
      reply.code(statusCode).send({
        statusCode,
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      });
      return;
    }
    reply.code(statusCode).send({ statusCode, error: error.name || 'Bad Request', message: error.message });
  });

  app.register(v1Routes, {
    prefix: '/v1',
    config: booted.config,
    theme: booted.theme,
    tokens: serverConfig.tokens,
    ipAllowlist: serverConfig.ipAllowlist,
    maxUploadBytes: serverConfig.media.maxUploadBytes,
    maxDocumentUploadBytes: serverConfig.media.maxDocumentUploadBytes,
  });

  // Registered without a /v1 prefix, alongside v1Routes: this is the
  // site's own public website, not part of the site agent API. Order
  // relative to v1Routes is not load-bearing - Fastify's router
  // prefers exact/prefixed matches over this route's wildcard
  // regardless of registration order (verified empirically). What
  // actually protects unmatched /v1/* paths from being swallowed as
  // page lookups is the explicit guard inside publicRoutes itself.
  app.register(publicRoutes, {
    config: booted.config,
    theme: booted.theme,
    renderCache: booted.renderCache,
    // GET /admin, when nothing else is there (routes/admin-redirect.ts).
    adminBaseUrl: serverConfig.adminBaseUrl,
  });

  // A more specific static-prefixed route than the public catch-all's
  // own /* wildcard - Fastify prefers it regardless of registration
  // order (verified empirically), so no guard is needed here the way
  // publicRoutes needs one against /v1/*.
  app.register(assetsRoutes, { config: booted.config });

  // Same "more specific than the public catch-all" reasoning as
  // assetsRoutes above. Deliberately not registered inside v1Routes
  // (media.ts's own authenticated /v1/media CRUD routes are what live
  // there) - this is the public, unauthenticated read side, matching
  // assetsRoutes/publicRoutes' own placement.
  //
  // @fastify/multipart itself is NOT registered here, only inside
  // media.ts's own plugin scope - see that file's comment for why
  // (confining it to media routes only, leaving every other route
  // file's default JSON body parsing untouched).
  app.register(mediaPublicRoutes, { config: booted.config });

  // Same "more specific than the public catch-all" reasoning again -
  // this exact path always wins over publicRoutes' /* wildcard, and
  // also always wins over a same-named static file under
  // theme/root/sitemap.xml (see routes/public.ts's root-mirror check).
  app.register(sitemapRoutes, { config: booted.config });

  // Same "more specific than the public catch-all" reasoning again - a
  // stable, public, front-end-facing contract (a theme's own JS calls
  // it directly), not part of the versioned /v1 admin/integration
  // surface, so it lives alongside these other unprefixed routes
  // rather than inside v1Routes (search.ts's /v1/search/rebuild is the
  // authenticated write side that does). GET /search.json, not
  // GET /search: a single reserved path, not a whole prefix, so a
  // site's own content page can still live at the bare /search URL
  // (granite-starter's search-demo section does exactly that).
  app.register(searchPublicRoutes, { config: booted.config });

  return app;
}

// Neither a recurring timer nor process signal handling exists
// anywhere else in this codebase - this is genuinely new machinery for
// the low-frequency draft-checkpoint background job (checklist H4).
// Wired only here, never in buildServer: every existing route test
// uses buildServer + .inject() directly and must stay completely
// unaffected by any of this.
export async function startServer(
  siteRoot: string,
  options: StartServerOptions = {},
): Promise<FastifyInstance> {
  const booted = bootSite(siteRoot);
  const serverConfig = loadServerConfig(siteRoot);
  // Started by npm run dev (dev/dev-site.ts), which runs the tunnel,
  // restarts this process when the theme changes, and prints what
  // matters itself: so here, quiet, and the key for its Edit in Minamo
  // link accepted as an access token. The key lives only in this
  // process's environment and memory, never in site.config.json.
  const env = options.env ?? process.env;
  const devChild = env[DEV_CHILD_ENV] === '1';
  const localEditKey = devChild ? env[LOCAL_EDIT_KEY_ENV] : undefined;
  if (localEditKey) {
    serverConfig.tokens = [...serverConfig.tokens, localEditToken(localEditKey)];
  }
  const app = buildServer(booted, serverConfig, options);
  const terminal = createSiteConsole(options.output, { quiet: devChild });
  terminal.starting(siteRoot, readAgentVersion());

  // Previously these three failure cases (missing/invalid {% schema %}
  // block, or a required property with no valid default) were
  // completely silent - a broken component just stopped being
  // selectable, with nothing distinguishing "deliberately excluded"
  // from "you have a typo". Never a boot failure (loadThemeSchemas's
  // own contract), just no longer silent about it either.
  for (const warning of booted.themeSchemas.warnings ?? []) {
    terminal.themeWarning(warning);
  }

  const doCheckpoint = () => runCheckpoint(booted.config, CHECKPOINT_AUTHOR);
  const scheduler = startIntervalJob(doCheckpoint, serverConfig.checkpointIntervalMs, (error) => {
    app.log.error(error, 'background draft checkpoint failed');
  });


  // Node's default action for an unhandled SIGTERM/SIGINT is immediate
  // process termination, bypassing all JS-level cleanup - without
  // this, a real kill/Ctrl-C would never run the final checkpoint
  // (build plan: "and on graceful shutdown"). process.once (not .on)
  // self-removes after firing, and is explicitly removed again inside
  // onClose below, so a test calling app.close() leaves zero global
  // process-level listeners behind across the many startServer/
  // buildServer calls the suite makes.
  const shutdown = (): void => {
    app.close().catch((error: unknown) => app.log.error(error, 'error during shutdown'));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  app.addHook('onClose', async () => {
    terminal.stopping();
    scheduler.stop();
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    removeOwnPidFile(booted.config);
    try {
      await doCheckpoint();
    } catch (error) {
      app.log.error(error, 'final draft checkpoint on shutdown failed');
    }
  });

  // host: '0.0.0.0' - Fastify's own default binds 127.0.0.1 only,
  // which is unreachable from outside any container or remote host.
  try {
    await app.listen({ port: serverConfig.port, host: '0.0.0.0' });
  } catch (error) {
    // A raw EADDRINUSE crash is a wall of Node internals with no
    // indication of what to actually do about it. This is the single
    // most likely startup failure a developer hits on their own
    // machine (something else already using the default port) - tell
    // them the two real ways to pick a different one instead of
    // rethrowing Node's own stack trace.
    if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
      // Most often it's this same site, started earlier in another
      // terminal - say so, and how to stop it from this one.
      const running = readPidFile(booted.config);
      if (running && running.port === serverConfig.port && running.pid !== process.pid && isProcessAlive(running.pid)) {
        terminal.portInUse(serverConfig.port, running.pid);
        process.exit(1);
      }
      terminal.portInUse(serverConfig.port);
      process.exit(1);
    }
    throw error;
  }

  // The real bound port, not just serverConfig.port verbatim - the
  // same reasoning tests already rely on (app.server.address()):
  // port 0 means "OS picks a free one", so echoing the configured
  // value back would print a meaningless 0 in that case. 127.0.0.1,
  // not the 0.0.0.0 bind host above - that's what's actually
  // reachable and clickable from the machine running this.
  const address = app.server.address();
  const localUrl = `http://127.0.0.1:${address !== null && typeof address !== 'string' ? address.port : serverConfig.port}`;
  if (address !== null && typeof address !== 'string') {
    terminal.running(localUrl);
    // Recorded only once the port is really bound, so a start that
    // fails never leaves a record of a site that isn't running.
    writePidFile(booted.config, address.port);
  }

  // A search index is never git-tracked (constraint 3), so a fresh
  // clone or first-ever boot has no index file - without this,
  // GET /search.json would stay empty until the first content write.
  // Fire-and-forget, after the port is already bound: never blocks
  // startup, and a slow/failed rebuild is never a reason the server
  // itself fails to come up.
  reindexOnBootIfMissing(booted.config);

  if (devChild) {
    // Tells npm run dev the site is up, and where.
    process.send?.({ type: 'minamo-site-ready', port: address !== null && typeof address !== 'string' ? address.port : serverConfig.port });
  } else {
    terminal.devHint();
    terminal.listen([
      { key: 'o', label: 'open site', run: () => openInBrowser(localUrl) },
      { key: 'q', label: 'stop' },
    ]);
  }

  return app;
}
