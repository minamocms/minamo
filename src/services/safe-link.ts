// What a link in content may point at (security audit, November 2026).
//
// A link field's value ends up in an href a theme writes, and escaping
// it for HTML does nothing about what it is: "javascript:..." in an
// href runs as script on the public site when a visitor follows it. So
// a link is either no scheme at all (a site path like "/about", an
// anchor, a relative address, "//host/path") or one of the few schemes
// a link on a website has any use for.
const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'sms']);
// What a picture or other embedded file may load from: never mailto and
// the like, and never data:, which can carry a document of its own.
const SOURCE_SCHEMES = new Set(['http', 'https']);

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

// Browsers drop tabs and line breaks from inside a URL and ignore
// leading control characters and spaces, so "java\tscript:" and
// "\u0001javascript:" are both script. Nothing a real address needs is
// lost by refusing every control character outright.
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function hasAllowedScheme(value: string, allowed: Set<string>): boolean {
  if (hasControlCharacter(value)) {
    return false;
  }
  const scheme = SCHEME.exec(value.trim());
  return scheme === null || allowed.has((scheme[1] as string).toLowerCase());
}

// For a link someone follows: an href.
export function isSafeLink(value: string): boolean {
  return hasAllowedScheme(value, LINK_SCHEMES);
}

// For a file the page loads by itself: an image's src.
export function isSafeSource(value: string): boolean {
  return hasAllowedScheme(value, SOURCE_SCHEMES);
}
