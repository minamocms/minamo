// Looks a name that came from content up in a map built from the theme
// (security audit, November 2026).
//
// A page names its layout and each of its sections and blocks names its
// type, and those names are looked up in plain objects keyed by what
// the theme defines. A plain object also answers to names it inherits:
// "constructor", "toString", "hasOwnProperty". A page whose layout was
// "constructor" got Object's own constructor back where a template was
// expected, and failed somewhere far from the cause, with a 500 in
// place of "that layout is missing". This returns only what the map
// itself holds.
export function ownValue<T>(map: Record<string, T>, name: unknown): T | undefined {
  return typeof name === 'string' && Object.hasOwn(map, name) ? map[name] : undefined;
}
