import type { FastifyReply } from 'fastify';

// GET /admin sends a visitor to the site's admin (adminBaseUrl,
// server-config.ts: the hosted Minamo admin unless the site says
// otherwise), with the requesting host appended as ?site= so the admin
// can open this site's editor directly. Never a deep link with a site
// ID baked in: that keeps this package decoupled from any particular
// admin's own URL scheme, so a self-hoster running a different admin
// just points adminBaseUrl at it. request.host (not request.hostname,
// which strips the port - same reasoning sitemap.ts documents) so the
// admin side can match it directly against new URL(registeredSiteUrl).host.
//
// Not a route of its own: routes/public.ts calls this only when /admin
// would otherwise be a 404, so a real page, a redirect or a
// theme/root/ file at /admin always wins, and a site can keep using
// "admin" as an ordinary page path. Unauthenticated like the rest of
// the public site: it reveals nothing but where the admin lives.
export const ADMIN_PATH = '/admin';

export function sendAdminRedirect(reply: FastifyReply, adminBaseUrl: string, host: string): void {
  const target = new URL(adminBaseUrl);
  target.searchParams.set('site', host);
  reply.code(302).header('location', target.toString()).send();
}
