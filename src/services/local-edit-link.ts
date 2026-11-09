import { createHash, randomBytes } from 'node:crypto';
import type { TokenEntry } from '../server-config.ts';

// "Edit in Minamo" for a site running locally behind `npm run tunnel`:
// a link that opens it in the admin without registering it there.
//
// The key is an access token made fresh each time the site starts. It's
// held in memory only (added to the running server's tokens, never
// written to site.config.json), so it stops working the moment the site
// stops. It goes in the link's fragment (after #), which browsers never
// send to any server, so it doesn't end up in a log on the way.
export interface LocalEditKey {
  key: string;
  token: TokenEntry;
}

export function createLocalEditKey(): LocalEditKey {
  const key = randomBytes(32).toString('base64url');
  return {
    key,
    token: { hash: createHash('sha256').update(key).digest('hex'), scopes: ['content', 'theme', 'media'] },
  };
}

export function localEditLink(adminBaseUrl: string, siteUrl: string, key: string): string {
  const base = adminBaseUrl.replace(/\/+$/, '');
  return `${base}/local#site=${encodeURIComponent(siteUrl)}&key=${encodeURIComponent(key)}`;
}
