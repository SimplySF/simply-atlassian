/*
 * Copyright (c) 2026, SimplySF.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { markdownToStorage } from '../src/markdown-storage.js';
import { storageToMarkdown } from '../src/storage-markdown.js';

describe('markdownToStorage — blocks', () => {
  it('renders headings at every level', () => {
    expect(markdownToStorage('# One')).toBe('<h1>One</h1>');
    expect(markdownToStorage('###### Six')).toBe('<h6>Six</h6>');
  });

  it('splits blank-line separated text into paragraphs', () => {
    expect(markdownToStorage('First.\n\nSecond.')).toBe('<p>First.</p><p>Second.</p>');
  });

  it('joins wrapped lines within a paragraph as line breaks', () => {
    expect(markdownToStorage('one\ntwo')).toBe('<p>one<br />two</p>');
  });

  it('renders bullet lists', () => {
    expect(markdownToStorage('- a\n- b')).toBe('<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  });

  it('renders numbered lists', () => {
    expect(markdownToStorage('1. a\n2. b')).toBe('<ol><li><p>a</p></li><li><p>b</p></li></ol>');
  });

  it('nests a list inside the item above it, not as a sibling', () => {
    const storage = markdownToStorage('- outer\n  - inner');

    expect(storage).toBe('<ul><li><p>outer</p><ul><li><p>inner</p></li></ul></li></ul>');
  });

  it('renders a blockquote, and blocks inside it', () => {
    expect(markdownToStorage('> quoted\n>\n> - a bullet')).toBe(
      '<blockquote><p>quoted</p><ul><li><p>a bullet</p></li></ul></blockquote>',
    );
  });

  it('renders a horizontal rule', () => {
    expect(markdownToStorage('---')).toBe('<hr />');
  });

  it('renders a pipe table with a header row', () => {
    const storage = markdownToStorage('| A | B |\n| --- | --- |\n| 1 | 2 |');

    expect(storage).toBe(
      '<table><tbody><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>',
    );
  });

  /*
   * A line containing pipes is far more often prose than a table. Without requiring the divider
   * row, "use the | character" becomes a one-cell table.
   */
  it('does not treat pipes without a divider row as a table', () => {
    expect(markdownToStorage('pipe | separated | prose')).toBe('<p>pipe | separated | prose</p>');
  });

  it('renders a fenced code block as a code macro with its language', () => {
    const storage = markdownToStorage('```bash\necho hi\n```');

    expect(storage).toContain('ac:name="code"');
    expect(storage).toContain('<ac:parameter ac:name="language">bash</ac:parameter>');
    expect(storage).toContain('<![CDATA[echo hi]]>');
  });

  it('omits the language parameter when the fence has none', () => {
    expect(markdownToStorage('```\nplain\n```')).not.toContain('ac:parameter');
  });

  /*
   * A fence's contents are literal. Without matching the fence before anything else, a `#` in a
   * shell snippet becomes a heading and the code silently changes meaning.
   */
  it('does not interpret Markdown inside a fence', () => {
    const storage = markdownToStorage('```bash\n# not a heading\n- not a list\n```');

    expect(storage).toContain('# not a heading');
    expect(storage).not.toContain('<h1>');
    expect(storage).not.toContain('<ul>');
  });

  it('refuses an unclosed fence rather than swallowing the rest of the document', () => {
    expect(() => markdownToStorage('```bash\necho hi')).toThrow(/unclosed/);
  });
});

describe('markdownToStorage — inline', () => {
  it('renders bold, italic and code', () => {
    expect(markdownToStorage('**b** _i_ `c`')).toBe('<p><strong>b</strong> <em>i</em> <code>c</code></p>');
  });

  it('accepts both bold and italic spellings', () => {
    expect(markdownToStorage('__b__ *i*')).toBe('<p><strong>b</strong> <em>i</em></p>');
  });

  it('renders a link', () => {
    expect(markdownToStorage('[text](https://example.com)')).toBe('<p><a href="https://example.com">text</a></p>');
  });

  it('renders emphasis inside a link, and a link inside emphasis', () => {
    expect(markdownToStorage('[**bold link**](https://x.test)')).toContain('<strong>bold link</strong>');
    expect(markdownToStorage('**[link](https://x.test)**')).toContain('<strong><a href=');
  });

  it('turns two trailing spaces into a line break', () => {
    expect(markdownToStorage('one  \ntwo')).toBe('<p>one<br />two</p>');
  });

  /*
   * The reason this is a scanning parser rather than regex substitution: a `**` inside a code
   * span must stay literal, and substitution over the whole string cannot tell the difference.
   */
  it('leaves Markdown markers inside a code span alone', () => {
    expect(markdownToStorage('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
  });
});

describe('markdownToStorage — escaping', () => {
  it('escapes the five XML characters', () => {
    expect(markdownToStorage(`a < b & c > d "q" 'r'`)).toBe(
      '<p>a &lt; b &amp; c &gt; d &quot;q&quot; &apos;r&apos;</p>',
    );
  });

  /*
   * The whole reason escaping is not optional: storage is XHTML, so unescaped caller text either
   * breaks the body or becomes markup nobody asked for.
   */
  it('cannot be used to inject a macro, by either of two routes', () => {
    // At the start of a line it is refused outright as raw HTML.
    expect(() => markdownToStorage('<ac:structured-macro ac:name="html" />')).toThrow(/raw HTML/);

    // Mid-paragraph it is escaped, so the characters appear on the page and no macro is created.
    const inlineAttempt = markdownToStorage('text <ac:structured-macro ac:name="html" />');
    expect(inlineAttempt).not.toContain('<ac:structured-macro');
    expect(inlineAttempt).toContain('&lt;ac:structured-macro');
  });

  it('escapes markup inside a code span', () => {
    expect(markdownToStorage('`<b>&</b>`')).toBe('<p><code>&lt;b&gt;&amp;&lt;/b&gt;</code></p>');
  });

  /*
   * A code macro body is CDATA, so it is deliberately NOT escaped — which means a snippet
   * containing the CDATA terminator would close the section early and turn the rest of the code
   * into markup. It has to be split across two sections instead.
   */
  it('splits a CDATA terminator appearing inside a code block', () => {
    const storage = markdownToStorage('```\na]]>b\n```');

    expect(storage).toContain(']]]]><![CDATA[>');
    expect(storage).not.toContain('a]]>b');
  });

  it('strips control characters rather than storing them', () => {
    const storage = markdownToStorage(`before${String.fromCharCode(0x1b)}[2Kafter`);

    expect(storage).not.toContain(String.fromCharCode(0x1b));
    expect(storage).toContain('[2Kafter');
  });
});

describe('markdownToStorage — link safety', () => {
  /*
   * Stored content outlives the command. A javascript: href written to a page is there for
   * everyone who opens it, so the scheme is checked rather than passed through.
   */
  it('refuses a javascript: link', () => {
    expect(() => markdownToStorage('[click](javascript:alert(1))')).toThrow(ConfigError);
    expect(() => markdownToStorage('[click](javascript:alert(1))')).toThrow(/not allowed/);
  });

  it('refuses a data: link', () => {
    expect(() => markdownToStorage('[x](data:text/html;base64,AAAA)')).toThrow(/not allowed/);
  });

  it('names the scheme it refused', () => {
    expect(() => markdownToStorage('[x](ftp://host/file)')).toThrow(/ftp:/);
  });

  it('allows http, https and mailto', () => {
    expect(markdownToStorage('[a](http://x.test)')).toContain('href="http://x.test"');
    expect(markdownToStorage('[b](https://x.test)')).toContain('href="https://x.test"');
    expect(markdownToStorage('[c](mailto:a@b.test)')).toContain('href="mailto:a@b.test"');
  });

  /*
   * Found by the security pass: `//host` was being treated as instance-relative because it starts
   * with a slash. It is protocol-relative — a browser resolves it to an external host — so a link
   * reading as internal, on a page colleagues trust, could point anywhere.
   */
  it('refuses a protocol-relative target, which resolves off-instance', () => {
    expect(() => markdownToStorage('[a](//evil.example.com/x)')).toThrow(/protocol-relative/);
  });

  it('refuses the backslash form of the same trick', () => {
    expect(() => markdownToStorage(String.raw`[a](\\evil.example.com\x)`)).toThrow(/protocol-relative/);
  });

  it('allows relative and anchor targets, which resolve inside the instance', () => {
    expect(markdownToStorage('[a](/wiki/spaces/DS)')).toContain('href="/wiki/spaces/DS"');
    expect(markdownToStorage('[b](#section)')).toContain('href="#section"');
  });

  it('escapes a literal quote in a href so it cannot break out of the attribute', () => {
    const storage = markdownToStorage('[a](https://x.test/?q="onmouseover=x)');

    expect(storage).toContain('&quot;');
    expect(storage).not.toMatch(/href="[^"]*"[^>]*onmouseover/);
  });
});

describe('markdownToStorage — refusals, never silent drops', () => {
  const cases: ReadonlyArray<[string, string, RegExp]> = [
    ['an image', '![alt](https://x.test/i.png)', /image/],
    ['a footnote definition', '[^1]: a note', /footnote/],
    ['a reference link definition', '[ref]: https://x.test', /reference-style/],
    ['raw HTML', '<div>hello</div>', /raw HTML/],
    ['a task list', '- [ ] do the thing', /task list/],
    ['a setext heading', 'Title\n===', /setext/],
  ];

  for (const [what, markdown, pattern] of cases) {
    it(`refuses ${what}`, () => {
      expect(() => markdownToStorage(markdown)).toThrow(ConfigError);
      expect(() => markdownToStorage(markdown)).toThrow(pattern);
    });
  }

  it('names the line number, so a long document is fixable', () => {
    expect(() => markdownToStorage('fine\n\nalso fine\n\n![img](https://x.test/a.png)')).toThrow(/Line 5/);
  });

  it('says nothing was sent, so a caller knows the page is untouched', () => {
    expect(() => markdownToStorage('![img](https://x.test/a.png)')).toThrow(/Nothing was sent/);
  });

  it('refuses pathological nesting rather than recursing', () => {
    const deep = Array.from({ length: 20 }, (_, i) => `${'>'.repeat(i + 1)} deep`).join('\n');

    expect(() => markdownToStorage(deep)).toThrow(/nested more than/);
  });
});

describe('round trip with storage-markdown.ts', () => {
  /*
   * The two directions share a vocabulary, so prose survives a round trip. This is asserted so
   * that a change to either renderer cannot quietly break the pairing.
   */
  it('preserves prose through Markdown -> storage -> Markdown', () => {
    const original = '# Title\n\nSome **bold** text.\n\n- one\n- two';

    const back = storageToMarkdown(markdownToStorage(original));

    expect(back).toContain('# Title');
    expect(back).toContain('**bold**');
    expect(back).toContain('- one');
  });

  /*
   * And this is the loss the design doc warns about, pinned by a test so nobody assumes
   * otherwise: a macro read to Markdown does NOT survive being converted back. Reading an info
   * panel gives a blockquote, and a blockquote is what comes back — the panel is gone.
   *
   * The consequence for callers: `page get --body-format storage` is the exact path for
   * read-modify-write. Markdown is for authoring, not for round-tripping existing pages.
   */
  it('does NOT preserve a macro through storage -> Markdown -> storage', () => {
    const withPanel =
      '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>note</p></ac:rich-text-body></ac:structured-macro>';

    const roundTripped = markdownToStorage(storageToMarkdown(withPanel));

    expect(roundTripped).not.toContain('ac:name="info"');
    expect(roundTripped).toContain('<blockquote>');
  });
});
