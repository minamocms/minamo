import { createServer } from 'node:net';

// Finding a port nothing else is listening on, for a new site's
// site.config.json (create-site) and for npm run dev when a site's own port
// is taken. Only ever a local convenience: live hosting sets its port
// itself (PORT), and npm start keeps to the configured one.

export const SITE_PORT_RANGE = { min: 3000, max: 3999 } as const;

function canListen(port: number, host: string, ipv6Only: boolean): Promise<boolean | 'unsupported'> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL' ? 'unsupported' : false);
    });
    server.listen({ port, host, ipv6Only, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

// Free where the site itself listens (0.0.0.0), and on localhost itself,
// over IPv4 and IPv6. On macOS a program holding only 127.0.0.1:3000 (or
// [::1]:3000) doesn't stop the site binding 0.0.0.0:3000, but "localhost"
// in a browser then reaches that program, and the site seems to be
// something else entirely.
export async function isPortFree(port: number): Promise<boolean> {
  for (const [host, ipv6Only] of [['0.0.0.0', false], ['127.0.0.1', false], ['::', true], ['::1', true]] as const) {
    const result = await canListen(port, host, ipv6Only);
    // No IPv6 on this machine: the IPv4 answers stand on their own.
    if (result === false || (result === 'unsupported' && !host.includes(':'))) {
      return false;
    }
  }
  return true;
}

export interface PortSearch {
  isFree?: (port: number) => Promise<boolean>;
  random?: () => number;
}

// A random free port in the range, so two sites made one after the other
// don't land on neighbouring ports and clash with whatever the next one
// runs. Falls back to the configured default only if every try is taken.
export async function pickSitePort({ isFree = isPortFree, random = Math.random }: PortSearch = {}, attempts = 40): Promise<number> {
  const { min, max } = SITE_PORT_RANGE;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = min + Math.floor(random() * (max - min + 1));
    if (await isFree(port)) {
      return port;
    }
  }
  return min;
}

// The first free port after `taken`, looking at most `limit` ports on, or
// null if none is.
export async function nextFreePort(taken: number, { isFree = isPortFree }: PortSearch = {}, limit = 100): Promise<number | null> {
  for (let port = taken + 1; port <= Math.min(taken + limit, 65535); port += 1) {
    if (await isFree(port)) {
      return port;
    }
  }
  return null;
}
