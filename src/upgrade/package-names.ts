// The CMS is published as @minamocms/minamo from 0.10.1, and was
// @o-a/cms-agent up to 0.9.x (0.10.0 was never published: npm refused
// the unscoped name "minamo"). From 0.9.3, @o-a/cms-agent's npm run
// upgrade moves a site over; what's here makes sure the old name
// doesn't linger in vhost/package.json once it has.
export const PACKAGE_NAME = '@minamocms/minamo';
export const FORMER_PACKAGE_NAMES = ['@o-a/cms-agent'];

// vhost/package.json's dependencies with the CMS at the given version,
// under its current name only. The site's own dependencies are kept.
export function upgradedDependencies(dependencies: Record<string, string> | undefined, version: string): Record<string, string> {
  const next = { ...dependencies };
  for (const name of FORMER_PACKAGE_NAMES) {
    delete next[name];
  }
  next[PACKAGE_NAME] = version;
  return next;
}

// The exact CMS version vhost/package.json asks for, under either name.
export function requestedVersion(dependencies: Record<string, unknown> | undefined): unknown {
  for (const name of [PACKAGE_NAME, ...FORMER_PACKAGE_NAMES]) {
    if (dependencies?.[name] !== undefined) {
      return dependencies[name];
    }
  }
  return undefined;
}
