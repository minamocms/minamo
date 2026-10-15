import { compareVersions } from './changelog.ts';

// The CMS was published as @o-a/cms-agent up to 0.9.x, and as minamo
// from 0.10.0. A site still on the old name upgrades to the new one:
// npm run upgrade swaps the dependency over, then hands over to the
// new package as it would to any newer version.
export const PACKAGE_NAME = '@o-a/cms-agent';
export const SUCCESSOR_NAME = 'minamo';

export interface PublishedVersions {
  versions: string[];
  latest: string;
}

export interface UpgradeSource extends PublishedVersions {
  name: string;
}

// Which package to upgrade from: the successor once it has a version
// newer than the one installed, otherwise this package as before. The
// successor is only ever looked up, never assumed, so a site upgrades
// exactly as it did until minamo is published.
export function chooseUpgradeSource(installed: string, own: PublishedVersions, successor: PublishedVersions | null): UpgradeSource {
  if (successor && compareVersions(successor.latest, installed) > 0) {
    return { name: SUCCESSOR_NAME, ...successor };
  }
  return { name: PACKAGE_NAME, ...own };
}

// vhost/package.json's dependencies after the upgrade: the chosen
// package at its new version, and no longer the old name if the site is
// moving to the successor.
export function upgradedDependencies(dependencies: Record<string, string> | undefined, source: string, version: string): Record<string, string> {
  const next = { ...dependencies };
  if (source !== PACKAGE_NAME) {
    delete next[PACKAGE_NAME];
  }
  next[source] = version;
  return next;
}
