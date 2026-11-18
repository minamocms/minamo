import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { CURRENT_SCHEMA_VERSION } from '../migrations/index.ts';
import { NO_AUTH_ROUTE_RATE_LIMIT } from '../services/rate-limit-config.ts';
import { DRIVER_NAME } from '../search/drivers/node-sqlite-driver.ts';
import { ALLOWED_UPLOAD_EXTENSIONS } from '../media/filename.ts';

interface PackageJson {
  version?: string;
}

// The agent's own bundled package.json, not site data - the same
// import.meta.dirname-relative pattern already established in
// validation.ts/startup-checks.ts for the agent's own files.
export function readAgentVersion(): string {
  const packageJsonPath = join(import.meta.dirname, '..', '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJson;
  return packageJson.version ?? '0.0.0';
}

// Kept beside the route that reports it; test/server.test.ts checks it
// against page.schema.json, so the two can't drift.
export const OPTIONAL_PAGE_FIELDS = ['description', 'author', 'publishDate', 'tags'] as const;

export interface CapabilitiesRouteOptions {
  maxUploadBytes: number;
  maxDocumentUploadBytes: number;
}

export const capabilitiesRoutes: FastifyPluginAsync<CapabilitiesRouteOptions> = async (
  fastify: FastifyInstance,
  opts: CapabilitiesRouteOptions,
) => {
  fastify.get('/capabilities', { config: NO_AUTH_ROUTE_RATE_LIMIT }, async () => ({
    agentVersion: readAgentVersion(),
    contentSchemaVersion: CURRENT_SCHEMA_VERSION,
    sqliteDriver: DRIVER_NAME,
    // Named distinctly from site.config.json's own "media.maxUploadBytes"
    // key so this response reads unambiguously next to its siblings -
    // lets the admin's own client-side upload check validate against
    // the same limit the server will actually enforce (@fastify/multipart's
    // limits.fileSize in media.ts), rather than a separately hardcoded
    // guess that could drift.
    maxMediaUploadBytes: opts.maxUploadBytes,
    // Since 0.11.0. Their absence tells the admin a site predates PDF
    // uploads, so it offers images and videos only there.
    maxDocumentUploadBytes: opts.maxDocumentUploadBytes,
    mediaUploadExtensions: [...ALLOWED_UPLOAD_EXTENSIONS],
    // Since 0.18.0. The optional fields a page may carry beside its
    // required ones (page.schema.json). A page with a field this site
    // doesn't know is refused, so the admin offers only the ones
    // listed; with no list at all (an older site), only the three
    // that every version has had: author, publishDate and tags.
    pageFields: [...OPTIONAL_PAGE_FIELDS],
  }));
};
