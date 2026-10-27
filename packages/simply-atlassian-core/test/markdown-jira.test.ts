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
import { adfToMarkdown, markdownToAdf } from '../src/markdown-adf.js';
import { parseMarkdown } from '../src/markdown-ast.js';
import { renderMarkdown } from '../src/markdown-render.js';
import { markdownToStorage } from '../src/markdown-storage.js';
import { storageLoss, storageToMarkdownReading } from '../src/storage-reading.js';
import { markdownToWiki, wikiToMarkdown } from '../src/markdown-wiki.js';

/** Documents an agent plausibly writes into a story or a design page. */
const CORPUS = [
  '# Title\n\nPlain paragraph.',
  'Line one\nline two\nline three',
  'Ends with a break  ',
  '**bold**, *italic*, ***both***, `code` and [a link](https://example.com/a?b=c).',
  '1. **AC-1** Given a technician\n2. **AC-2** When they sync\n   - nested bullet\n   - another\n3. Then it works',
  '- one\n- two\n  1. two-a\n  2. two-b\n- three',
  '| Field | Rule |\n| --- | --- |\n| Priority | *High* only if blocked |\n| Labels | `agent-drafted` |',
  '```ts\nconst x = 1;\n// # not a heading\n```',
  '```\nplain code\n```',
  '> A quote\n> over two lines',
  '---',
  'snake_case_name stays literal, and so does a_b_c.',
  'Escapes: \\*not bold\\*, a \\` backtick, a back\\\\slash.',
  'Brackets [draft] and a [real](https://x.test) link.',
  '## Out of scope\n\n- Offline mode\n- Reporting',
  'Hyphens in AC-1, e.g. ready? yes! 50% + tax ^ ~approx.',
];

describe('the Markdown writer', () => {
  it.each(CORPUS)('writes a tree that parses back to itself: %j', (markdown) => {
    const tree = parseMarkdown(markdown);
    const written = renderMarkdown(tree);
    expect(parseMarkdown(written)).toEqual(tree);
  });

  it('escapes text that would otherwise start a block', () => {
    const tree = [
      {
        type: 'paragraph' as const,
        children: [
          { type: 'text' as const, text: '# not a heading' },
          { type: 'break' as const },
          { type: 'text' as const, text: '- not a list' },
          { type: 'break' as const },
          { type: 'text' as const, text: '1. not numbered' },
          { type: 'break' as const },
          { type: 'text' as const, text: '<div> not html' },
        ],
      },
    ];
    expect(parseMarkdown(renderMarkdown(tree))).toEqual(tree);
  });

  it('records what it cannot express instead of changing structure silently', () => {
    const lossy = new Set<string>();
    renderMarkdown(
      [
        {
          type: 'table',
          header: [[{ type: 'text', text: 'a|b' }]],
          rows: [],
        },
      ],
      lossy,
    );
    expect([...lossy]).toEqual(['a | character inside a table cell']);
  });
});

describe('markdownToAdf', () => {
  it('builds headings, marks and hard breaks the way Cloud validates them', () => {
    expect(markdownToAdf('# Hi\n\n**a** *b* `c` [d](https://x.test)\nnext')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hi' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'b', marks: [{ type: 'em' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'c', marks: [{ type: 'code' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'd', marks: [{ type: 'link', attrs: { href: 'https://x.test' } }] },
            { type: 'hardBreak' },
            { type: 'text', text: 'next' },
          ],
        },
      ],
    });
  });

  it('nests lists inside the item above them, after its paragraph', () => {
    expect(markdownToAdf('1. one\n   - inner').content).toEqual([
      {
        type: 'orderedList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
              {
                type: 'bulletList',
                content: [
                  { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }] },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('builds tables with a header row, and code blocks with their language', () => {
    const doc = markdownToAdf('| A | B |\n| - | - |\n| 1 | 2 |\n\n```sql\nselect 1\n```');
    expect(doc.content[0]).toMatchObject({
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader' }, { type: 'tableHeader' }] },
        { type: 'tableRow', content: [{ type: 'tableCell' }, { type: 'tableCell' }] },
      ],
    });
    expect(doc.content[1]).toEqual({
      type: 'codeBlock',
      attrs: { language: 'sql' },
      content: [{ type: 'text', text: 'select 1' }],
    });
  });

  it('never emits an empty text node, which Cloud rejects', () => {
    const doc = JSON.stringify(markdownToAdf('```\n```\n\n**a**'));
    expect(doc).not.toContain('"text":""');
  });

  it('refuses what Markdown input cannot carry, with Jira wording', () => {
    expect(() => markdownToAdf('<div>x</div>')).toThrow(ConfigError);
    expect(() => markdownToAdf('<div>x</div>')).toThrow(/Jira fields take no HTML/);
    expect(() => markdownToAdf('[x](javascript:alert(1))')).toThrow(/not allowed/);
  });
});

describe('adfToMarkdown', () => {
  it.each(CORPUS)('reads back what markdownToAdf wrote, with nothing lost: %j', (markdown) => {
    const adf = markdownToAdf(markdown);
    const reading = adfToMarkdown(adf);
    expect(reading.lossy).toEqual([]);
    expect(markdownToAdf(reading.markdown)).toEqual(adf);
  });

  it('names the content Markdown cannot carry, and keeps its visible text', () => {
    const reading = adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ask ' },
            { type: 'mention', attrs: { id: 'abc', text: '@Sam' } },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'strike', marks: [{ type: 'strike' }] },
          ],
        },
        {
          type: 'panel',
          attrs: { panelType: 'info' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Note' }] }],
        },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
      ],
    });
    expect(reading.markdown).toBe('Ask @Sam and strike\n\nNote\n\n\\[attachment]');
    expect(reading.lossy).toEqual([
      'a mention',
      'a panel',
      'an attachment or image',
      'text formatting other than bold, italic, code and links',
    ]);
  });

  it('treats anything that is not a document as empty rather than throwing', () => {
    expect(adfToMarkdown(null)).toEqual({ markdown: '', lossy: [] });
    expect(adfToMarkdown('plain')).toEqual({ markdown: '', lossy: [] });
  });
});

describe('markdownToWiki', () => {
  it('writes headings, formatting, links and code as Jira wiki markup', () => {
    expect(markdownToWiki('## Scope\n\n**AC-1** *now* `x` [docs](https://x.test)')).toBe(
      'h2. Scope\n\n*AC-1* _now_ {{x}} [docs|https://x.test]',
    );
    expect(markdownToWiki('```java\nint x;\n```')).toBe('{code:java}\nint x;\n{code}');
    expect(markdownToWiki('```\nraw\n```')).toBe('{noformat}\nraw\n{noformat}');
  });

  it('nests lists by repeating markers', () => {
    expect(markdownToWiki('1. one\n   - inner\n2. two')).toBe('# one\n#* inner\n# two');
  });

  it('writes tables with a header row', () => {
    expect(markdownToWiki('| A | B |\n| - | - |\n| 1 | |')).toBe('||A||B||\n|1| |');
  });

  it('escapes only the characters that could open formatting', () => {
    expect(markdownToWiki('AC-1 is -not- struck, [brackets] and a|b')).toBe(
      'AC-1 is \\-not- struck, \\[brackets\\] and a\\|b',
    );
    expect(markdownToWiki('\\# not a list')).toBe('\\# not a list');
  });
});

describe('wikiToMarkdown', () => {
  it.each(CORPUS)('reads back what markdownToWiki wrote, with nothing lost: %j', (markdown) => {
    const wiki = markdownToWiki(markdown);
    const reading = wikiToMarkdown(wiki);
    expect(reading.lossy).toEqual([]);
    expect(markdownToWiki(reading.markdown)).toBe(wiki);
  });

  it('reads wiki markup written by people, not just by this library', () => {
    const reading = wikiToMarkdown(
      [
        'h1. Story',
        'As a *technician* I want _offline_ sync.',
        '',
        '* first',
        '** nested',
        '# numbered',
        '',
        '||Col||Other||',
        '|a|[link|https://x.test]|',
        '',
        '{code:language=python}',
        'print(1)',
        '{code}',
        'bq. quoted',
      ].join('\n'),
    );
    expect(reading.markdown).toBe(
      [
        '# Story',
        '',
        'As a **technician** I want *offline* sync.',
        '',
        '- first',
        '  - nested',
        '- numbered',
        '',
        '| Col | Other |',
        '| --- | --- |',
        '| a | [link](https://x.test) |',
        '',
        '```python',
        'print(1)',
        '```',
        '',
        '> quoted',
      ].join('\n'),
    );
    expect(reading.lossy).toEqual([]);
  });

  it('names macros, mentions and Jira links it cannot carry', () => {
    const reading = wikiToMarkdown('{panel}\nInside\n{panel}\nPing [~jsmith] about [PROJ-1] {color:red}now{color}');
    expect(reading.markdown).toBe('Inside\n\nPing @jsmith about PROJ-1 now');
    expect(reading.lossy).toEqual([
      'a link to a Jira or Confluence object',
      'a mention',
      'a {color} macro',
      'a {panel} macro',
    ]);
  });
});

describe('Confluence storage round trip', () => {
  it.each(CORPUS)('reads back what markdownToStorage wrote, and reports it lossless: %j', (markdown) => {
    const storage = markdownToStorage(markdown);
    const reading = storageToMarkdownReading(storage);
    expect(reading.lossy).toEqual([]);
    expect(markdownToStorage(reading.markdown)).toBe(storage);
  });

  it('names macros, page links and layouts the Markdown reading cannot carry', () => {
    expect(
      storageLoss(
        '<ac:layout><ac:layout-section><ac:layout-cell><p>a</p></ac:layout-cell></ac:layout-section></ac:layout>' +
          '<ac:structured-macro ac:name="toc" /><p><ac:link><ri:page ri:content-title="X" /></ac:link></p>' +
          '<table><tbody><tr><td colspan="2"><p>x</p></td></tr></tbody></table>',
      ),
    ).toEqual([
      'a "toc" macro',
      'a column layout',
      'a link to a Confluence page, attachment or user',
      'a merged table cell',
    ]);
  });
});
