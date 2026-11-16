import { isSafeLink, isSafeSource } from './safe-link.ts';

// Cleans the HTML of a rich text field (security audit, November 2026).
//
// A rich text value is HTML, and a theme prints it with `| raw`, so
// whatever is stored runs in every visitor's browser. Only the admin's
// editor used to clean it, in the browser, which a direct call to the
// API skips entirely: anyone holding a content token could store a
// script. So it is cleaned here, when content is saved.
//
// How, and why it is safe without an HTML parser of its own standing:
// nothing of the input is ever passed through. The input is read as a
// run of text and tags, and the output is written fresh from that
// reading: text is escaped, a tag is written only if its name is on the
// list below, with only the attributes listed for it, each value
// checked and escaped again. Whatever this reads differently from a
// browser, the worst outcome is text shown where a tag was meant. The
// output can only ever hold the listed tags and attributes, because
// those are the only ones this file knows how to write.

// Everything the admin's editor produces, plus what a developer might
// reasonably write by hand: pictures, tables, code, and the plain
// inline and grouping tags.
const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'div', 'span', 'br', 'hr',
  'strong', 'em', 'b', 'i', 'u', 's', 'small', 'mark', 'del', 'ins', 'abbr', 'sup', 'sub', 'code', 'pre',
  'a', 'ul', 'ol', 'li',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'img', 'figure', 'figcaption',
]);

// Never have a closing tag or anything inside them.
const VOID_TAGS = new Set(['br', 'hr', 'img']);

// Removed together with everything inside them: what they hold is not
// words to show (a script, a stylesheet), or is read by rules of its
// own that text escaping would not hold up against (svg, math).
const DROPPED_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math',
  'textarea', 'title', 'select', 'xmp', 'noembed', 'noframes', 'plaintext', 'frameset', 'applet', 'head',
]);

type AttributeCheck = (value: string) => string | null;

const NAMES_ONLY = /^[A-Za-z0-9 _-]*$/;
const WHOLE_NUMBER = /^[0-9]{1,4}$/;

const className: AttributeCheck = (value) => (NAMES_ONLY.test(value) ? value : null);
const wholeNumber: AttributeCheck = (value) => (WHOLE_NUMBER.test(value) ? value : null);
const plainText: AttributeCheck = (value) => value;

// An address is refused if it holds a character reference at all, apart
// from "&amp;" between query parameters. A browser decodes references
// in an attribute before using it, so "jav&#97;script:" and
// "javascript&colon;" are both script; decoding every reference HTML
// defines in order to check them is a far larger job than refusing
// them, and no real address needs one.
function decodedAddress(value: string): string | null {
  const withoutAmp = value.replace(/&amp;/gi, '&');
  return /&#|&[A-Za-z][A-Za-z0-9]*;/.test(withoutAmp) ? null : withoutAmp;
}

const link: AttributeCheck = (value) => {
  const address = decodedAddress(value);
  return address !== null && isSafeLink(address) ? address : null;
};
const source: AttributeCheck = (value) => {
  const address = decodedAddress(value);
  return address !== null && isSafeSource(address) ? address : null;
};
// Only ever "_blank" (and then the link is also told not to hand the
// new page a way back to this one, below).
const newTabOnly: AttributeCheck = (value) => (value.toLowerCase() === '_blank' ? '_blank' : null);

const GLOBAL_ATTRIBUTES: Record<string, AttributeCheck> = { class: className, title: plainText };
const TAG_ATTRIBUTES: Record<string, Record<string, AttributeCheck>> = {
  a: { href: link, target: newTabOnly },
  img: { src: source, alt: plainText, width: wholeNumber, height: wholeNumber },
  th: { colspan: wholeNumber, rowspan: wholeNumber },
  td: { colspan: wholeNumber, rowspan: wholeNumber },
  ol: { start: wholeNumber },
};

// A character reference already in the text ("&amp;", "&nbsp;",
// "&#8217;") is kept as it is; a bare "&" becomes "&amp;".
const BARE_AMPERSAND = /&(?!(?:[A-Za-z][A-Za-z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6});)/g;

function escapeText(text: string): string {
  return text.replace(BARE_AMPERSAND, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

// An address was decoded to check it, so every "&" in it is a plain one.
function escapeAddress(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const ADDRESS_ATTRIBUTES = new Set(['href', 'src']);

// Where the tag starting at `start` (a "<") ends: the index of its ">",
// skipping any inside a quoted attribute value. -1 if it never ends.
function tagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < html.length; i += 1) {
    const char = html[i] as string;
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

const TAG_NAME = /^<(\/?)([A-Za-z][A-Za-z0-9]*)/;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function writeOpenTag(name: string, inside: string): string {
  const allowed = { ...GLOBAL_ATTRIBUTES, ...(TAG_ATTRIBUTES[name] ?? {}) };
  const written = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  for (let match = ATTRIBUTE.exec(inside); match !== null; match = ATTRIBUTE.exec(inside)) {
    const attribute = (match[1] as string).toLowerCase();
    // hasOwn: "constructor" and the like are not attributes on the list.
    if (!Object.hasOwn(allowed, attribute) || written.has(attribute)) {
      continue;
    }
    const checked = (allowed[attribute] as AttributeCheck)(match[2] ?? match[3] ?? match[4] ?? '');
    if (checked !== null) {
      written.set(attribute, ADDRESS_ATTRIBUTES.has(attribute) ? escapeAddress(checked) : escapeAttribute(checked));
    }
  }
  if (name === 'a' && written.has('target')) {
    written.set('rel', 'noopener noreferrer');
  }
  const attributes = [...written].map(([attribute, value]) => ` ${attribute}="${value}"`).join('');
  return `<${name}${attributes}>`;
}

export function sanitiseRichText(html: string): string {
  let output = '';
  // The listed, non-void tags currently open, innermost last: closed in
  // the right order whatever the input did, so what is written is
  // always well formed and can't leave a tag open over the rest of a
  // page.
  const open: string[] = [];
  // For finding a closing tag whatever its case, made once.
  const lower = html.toLowerCase();
  let position = 0;

  while (position < html.length) {
    const next = html.indexOf('<', position);
    if (next === -1) {
      output += escapeText(html.slice(position));
      break;
    }
    output += escapeText(html.slice(position, next));

    // A comment, a doctype, a processing instruction: gone, to its end
    // (or to the end of the text if it has none).
    if (html.startsWith('<!--', next)) {
      const end = html.indexOf('-->', next + 4);
      position = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[next + 1] === '!' || html[next + 1] === '?') {
      const end = html.indexOf('>', next);
      position = end === -1 ? html.length : end + 1;
      continue;
    }

    const tag = TAG_NAME.exec(html.slice(next, next + 80));
    const end = tag === null ? -1 : tagEnd(html, next);
    if (tag === null || end === -1) {
      // Not a tag at all: a "<" in the words.
      output += '&lt;';
      position = next + 1;
      continue;
    }

    const closing = tag[1] === '/';
    const name = (tag[2] as string).toLowerCase();
    position = end + 1;

    if (DROPPED_WITH_CONTENT.has(name)) {
      if (!closing) {
        // Everything up to its closing tag goes with it; with no
        // closing tag, everything that is left.
        const closeAt = lower.indexOf(`</${name}`, position);
        const closeEnd = closeAt === -1 ? -1 : html.indexOf('>', closeAt);
        position = closeEnd === -1 ? html.length : closeEnd + 1;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) {
      // The tag goes; what it wrapped stays, as text and listed tags.
      continue;
    }
    if (closing) {
      const depth = open.lastIndexOf(name);
      if (depth !== -1) {
        while (open.length > depth) {
          output += `</${open.pop() as string}>`;
        }
      }
      continue;
    }
    output += writeOpenTag(name, html.slice(next + tag[0].length, end));
    if (!VOID_TAGS.has(name)) {
      open.push(name);
    }
  }

  while (open.length > 0) {
    output += `</${open.pop() as string}>`;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Cleans every rich text value in `value`, found by the schema that
// describes it: a string whose schema says "format": "richtext", at any
// depth of "properties" and "items". Returns a new value; the one given
// is not changed. A value its schema doesn't describe is left as it is.
export function sanitiseBySchema(value: unknown, schema: unknown): unknown {
  if (!isRecord(schema)) {
    return value;
  }
  if (typeof value === 'string') {
    return schema.format === 'richtext' ? sanitiseRichText(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitiseBySchema(entry, schema.items));
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Defined, not assigned: a key named "__proto__" (which parsed
      // JSON can hold as an ordinary key) stays an ordinary key.
      Object.defineProperty(cleaned, key, {
        value: Object.hasOwn(properties, key) ? sanitiseBySchema(entry, properties[key]) : entry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return cleaned;
  }
  return value;
}
