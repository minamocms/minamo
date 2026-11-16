import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseBySchema, sanitiseRichText } from '../../src/services/rich-text.ts';
import { isSafeLink, isSafeSource } from '../../src/services/safe-link.ts';

// Security audit, November 2026 (AM11 to AM14).

test('sanitiseRichText leaves what the editor produces exactly as it is', () => {
  for (const html of [
    '<p>Hello <strong>bold</strong> and <em>italic</em></p>',
    '<h2>Heading</h2><p>Text with a <a href="https://example.com/a?b=1&amp;c=2">link</a>.</p>',
    '<ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol>',
    '<blockquote>Quoted</blockquote><p>Line<br>break</p>',
    '<p>Fish &amp; chips, 3 &lt; 4, a&nbsp;space, it&#8217;s</p>',
    '<p><a href="/about">site path</a> <a href="#top">anchor</a> <a href="mailto:hello@example.com">mail</a> <a href="tel:+61400000000">phone</a></p>',
    '',
    'Plain words with no tags at all',
  ]) {
    assert.equal(sanitiseRichText(html), html, html);
  }
});

test('sanitiseRichText keeps the safe extras a developer might write by hand', () => {
  for (const html of [
    '<figure><img src="/media/photo.jpg" alt="A photo" width="800" height="600"><figcaption>Caption</figcaption></figure>',
    '<table class="prices"><thead><tr><th colspan="2">Item</th></tr></thead><tbody><tr><td>A</td><td rowspan="2">B</td></tr></tbody></table>',
    '<pre><code class="language-js">const a = 1 &lt; 2;</code></pre><hr>',
    '<div class="note"><span title="Why">x</span><sup>1</sup><sub>2</sub><mark>m</mark></div>',
    '<ol start="3"><li>Three</li></ol>',
  ]) {
    assert.equal(sanitiseRichText(html), html, html);
  }
});

test('sanitiseRichText removes everything that could run, in every form tried', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<SCRIPT SRC=https://evil.example/x.js></SCRIPT>',
    '<p onclick="alert(1)">x</p>',
    '<img src=x onerror=alert(1)>',
    '<img src="x" onerror="alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href=" javascript:alert(1)">x</a>',
    '<a href="java\tscript:alert(1)">x</a>',
    '<a href="jav&#97;script:alert(1)">x</a>',
    '<a href="jav&#x61;script:alert(1)">x</a>',
    '<a href="javascript&colon;alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<a href="vbscript:msgbox(1)">x</a>',
    '<img src="javascript:alert(1)">',
    '<img src="data:image/svg+xml,<svg onload=alert(1)>">',
    '<iframe src="https://evil.example"></iframe>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<svg onload="alert(1)"><script>alert(1)</script></svg>',
    '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
    '<math><mtext><script>alert(1)</script></mtext></math>',
    '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">',
    '<style>body{background:url("javascript:alert(1)")}</style>',
    '<p style="background:url(javascript:alert(1))">x</p>',
    '<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">x</button><input onfocus=alert(1) autofocus></form>',
    '<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=javascript:alert(1)"><link rel="stylesheet" href="https://evil.example/x.css">',
    '<details open ontoggle="alert(1)">x</details>',
    '<body onload="alert(1)">',
    '<p "><script>alert(1)</script>',
    '<a title="x" href=javascript:alert(1)>x</a>',
    '<a href="x" href="javascript:alert(1)">x</a>',
    '<<script>alert(1)//<</script>',
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
    '<!--<script>--><script>alert(1)</script>',
    '<!-- --!><script>alert(1)</script>',
    '<script>alert(1)',
    '<textarea><script>alert(1)</script></textarea>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
    '<template><script>alert(1)</script></template>',
    '<img src="x" class="a" onerror=alert(1) id=x name=cookie>',
    '<a href="https://example.com" target="_top">x</a>',
    '<p class="a\\" onclick=\\"alert(1)">x</p>',
    '<p title=\'x" onmouseover="alert(1)\'>x</p>',
    '<p\x00 onclick=alert(1)>x</p>',
    '<p/onclick=alert(1)>x</p>',
  ];
  // Nothing the output holds may be a way to run something: no tag
  // off the list, no event handler, no address that is script.
  const TAG = /<\/?([a-z0-9]+)((?:\s+[a-z]+="[^"<>]*")*)>/g;
  const LISTED = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'div', 'span', 'br', 'hr', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'mark', 'del', 'ins', 'abbr', 'sup', 'sub', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'img', 'figure', 'figcaption']);
  const ATTRIBUTES = new Set(['class', 'title', 'href', 'target', 'rel', 'src', 'alt', 'width', 'height', 'colspan', 'rowspan', 'start']);
  for (const attack of attacks) {
    const output = sanitiseRichText(attack);
    // Every "<" left in the output starts a tag written by the cleaner.
    const withoutTags = output.replace(TAG, (whole, name: string, attributes: string) => {
      assert.ok(LISTED.has(name), `${JSON.stringify(attack)} left <${name}> in ${JSON.stringify(output)}`);
      for (const attribute of attributes.matchAll(/\s+([a-z]+)="([^"<>]*)"/g)) {
        assert.ok(ATTRIBUTES.has(attribute[1] as string), `${JSON.stringify(attack)} left attribute ${attribute[1]} in ${JSON.stringify(output)}`);
        if (attribute[1] === 'href' || attribute[1] === 'src') {
          assert.doesNotMatch(attribute[2] as string, /^\s*(javascript|data|vbscript)/i, `${JSON.stringify(attack)} left ${whole}`);
          assert.doesNotMatch(attribute[2] as string, /&#|&[a-z]+;(?<!&amp;)/i, `${JSON.stringify(attack)} left a character reference in ${whole}`);
        }
      }
      return '';
    });
    assert.equal(withoutTags.includes('<'), false, `${JSON.stringify(attack)} left a raw "<" in ${JSON.stringify(output)}`);
    assert.equal(withoutTags.includes('>'), false, `${JSON.stringify(attack)} left a raw ">" in ${JSON.stringify(output)}`);
    // And cleaning what was cleaned changes nothing.
    assert.equal(sanitiseRichText(output), output, `not stable for ${JSON.stringify(attack)}`);
  }
});

test('sanitiseRichText shows the words of a removed tag, and removes a script with what it holds', () => {
  assert.equal(sanitiseRichText('<font color="red">Red <b>bold</b></font>'), 'Red <b>bold</b>');
  assert.equal(sanitiseRichText('<p>Before<script>alert("gone")</script>After</p>'), '<p>BeforeAfter</p>');
  assert.equal(sanitiseRichText('<p>Before<style>p{color:red}</style>After</p>'), '<p>BeforeAfter</p>');
  assert.equal(sanitiseRichText('a < b and c > d'), 'a &lt; b and c &gt; d');
  assert.equal(sanitiseRichText('<p onclick="alert(1)" class="lead">x</p>'), '<p class="lead">x</p>');
  assert.equal(sanitiseRichText('<a href="javascript:alert(1)" title="t">x</a>'), '<a title="t">x</a>');
});

test('sanitiseRichText closes what was left open and drops a close with no open', () => {
  assert.equal(sanitiseRichText('<p><strong>bold'), '<p><strong>bold</strong></p>');
  assert.equal(sanitiseRichText('text</div></p>more'), 'textmore');
  assert.equal(sanitiseRichText('<ul><li>One<li>Two</ul>'), '<ul><li>One<li>Two</li></li></ul>');
  assert.equal(sanitiseRichText('<p><em>a</p>b</em>'), '<p><em>a</em></p>b');
});

test('a link that opens a new tab is told not to hand that page a way back', () => {
  assert.equal(
    sanitiseRichText('<a href="https://example.com" target="_blank">x</a>'),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>',
  );
  assert.equal(sanitiseRichText('<a href="https://example.com" rel="opener" target="_blank">x</a>'), '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>');
});

test('isSafeLink allows site paths and the schemes a link has a use for, and nothing that runs', () => {
  for (const allowed of ['/about', '/', '#top', '?page=2', 'about', '../up', '//cdn.example.com/x', 'https://example.com', 'HTTP://EXAMPLE.COM', 'mailto:hello@example.com', 'tel:+61400000000', 'sms:+61400000000', '', '/a:b', '/path?next=javascript:x']) {
    assert.equal(isSafeLink(allowed), true, JSON.stringify(allowed));
  }
  for (const refused of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', '\u0001javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', 'blob:https://example.com/x', 'ftp://example.com']) {
    assert.equal(isSafeLink(refused), false, JSON.stringify(refused));
  }
  assert.equal(isSafeSource('/media/a.png'), true);
  assert.equal(isSafeSource('https://example.com/a.png'), true);
  assert.equal(isSafeSource('mailto:a@example.com'), false);
  assert.equal(isSafeSource('data:image/png;base64,AAAA'), false);
});

test('sanitiseBySchema cleans only the fields the schema marks as rich text, at any depth, and changes nothing else', () => {
  const schema = {
    type: 'object',
    properties: {
      heading: { type: 'string' },
      body: { type: 'string', format: 'richtext' },
      columns: { type: 'array', items: { type: 'object', properties: { text: { type: 'string', format: 'richtext' }, label: { type: 'string' } } } },
    },
  };
  const dirty = '<p>ok</p><script>alert(1)</script>';
  const value = { heading: dirty, body: dirty, columns: [{ text: dirty, label: dirty }], extra: dirty, count: 3 };
  const before = JSON.stringify(value);

  const cleaned = sanitiseBySchema(value, schema);

  assert.deepEqual(cleaned, { heading: dirty, body: '<p>ok</p>', columns: [{ text: '<p>ok</p>', label: dirty }], extra: dirty, count: 3 });
  assert.equal(JSON.stringify(value), before, 'the value given is not changed');
});

test('sanitiseBySchema treats a key named __proto__ or constructor as an ordinary key', () => {
  const value = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "<b>x</b>", "body": "<script>x</script>y"}') as Record<string, unknown>;
  const cleaned = sanitiseBySchema(value, { properties: { body: { format: 'richtext' } } }) as Record<string, unknown>;

  assert.equal(JSON.stringify(cleaned), '{"__proto__":{"polluted":true},"constructor":"<b>x</b>","body":"y"}');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(cleaned), Object.prototype);
});
