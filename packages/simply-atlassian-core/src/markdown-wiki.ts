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

import type { MarkdownReading } from './markdown-adf.js';
import { parseMarkdown, type MdBlock, type MdInline, type MdList } from './markdown-ast.js';
import { renderMarkdown } from './markdown-render.js';

/**
 * Markdown ↔ Jira wiki markup, which is how Jira Server/Data Center stores rich text: a plain
 * string the instance renders (`h2.`, `*bold*`, `||header||`, `{code}`).
 *
 * Wiki markup has no escaping rules worth the name beyond a backslash before a markup character,
 * so the writer escapes every character that could open formatting. A field that renders with a
 * stray `\` is a cosmetic defect; one that renders a reviewer's sentence as strikethrough because
 * it contained `-a-` is a content defect. See design 0020.
 */

/** Converts Markdown to wiki markup. Refusals are `parseMarkdown`'s. */
export function markdownToWiki(markdown: string): string {
  return wikiBlocks(parseMarkdown(markdown, 'jira'));
}

function wikiBlocks(blocks: readonly MdBlock[]): string {
  return blocks.map((block) => wikiBlock(block)).join('\n\n');
}

function wikiBlock(block: MdBlock): string {
  switch (block.type) {
    case 'heading':
      return `h${block.level}. ${wikiInline(block.children, ' ')}`;
    case 'paragraph':
      // A trailing break has nothing after it to break before, and a trailing newline would
      // read back as an empty line.
      return wikiInline(block.children, '\n', true).trimEnd();
    case 'code':
      return block.language === ''
        ? `{noformat}\n${block.text}\n{noformat}`
        : `{code:${block.language}}\n${block.text}\n{code}`;
    case 'rule':
      return '----';
    case 'quote':
      return `{quote}\n${wikiBlocks(block.children)}\n{quote}`;
    case 'list':
      return wikiList(block, '');
    case 'table':
      return [
        `||${block.header.map((cell) => wikiInline(cell, ' ') || ' ').join('||')}||`,
        ...block.rows.map((row) => `|${row.map((cell) => wikiInline(cell, ' ') || ' ').join('|')}|`),
      ].join('\n');
  }
}

/** Nesting is the marker repeated: `*` then `**`, or `#` then `#*` for a bullet under a number. */
function wikiList(list: MdList, prefix: string): string {
  const marker = prefix + (list.ordered ? '#' : '*');
  return list.items
    .flatMap((item) => [
      // An item with no text of its own is only a holder for a nested list, which the deeper
      // markers already express.
      ...(item.content.length === 0 && item.children.length > 0 ? [] : [`${marker} ${wikiInline(item.content, ' ')}`]),
      ...item.children.map((child) => wikiList(child, marker)),
    ])
    .join('\n');
}

function wikiInline(nodes: readonly MdInline[], lineBreak: string, lineStart = false): string {
  let out = '';
  for (const node of nodes) {
    const atStart = lineStart && (out === '' || out.endsWith('\n'));
    switch (node.type) {
      case 'text':
        out += escapeWiki(node.text, atStart);
        break;
      case 'code':
        out += `{{${node.text.replaceAll('}', '\\}')}}}`;
        break;
      case 'link': {
        const label = wikiInline(node.children, ' ');
        out += label === '' || label === escapeWiki(node.href, false) ? `[${node.href}]` : `[${label}|${node.href}]`;
        break;
      }
      // Wiki formatting cannot span lines, so a break inside it becomes a space.
      case 'strong':
        out += `*${wikiInline(node.children, ' ')}*`;
        break;
      case 'em':
        out += `_${wikiInline(node.children, ' ')}_`;
        break;
      case 'break':
        out += lineBreak;
        break;
    }
  }
  return out;
}

/**
 * Characters that are markup wherever they appear: macros, links, table cells.
 *
 * A backslash is not escaped, because wiki markup has no way to: `\\` is a forced line break.
 * One before an ordinary character renders as written, which covers paths and regexes in prose.
 */
const ALWAYS_SPECIAL = new Set(['{', '}', '[', ']', '|']);

/** Characters that open formatting (`*bold*`, `-strike-`, `!image!`…) when they start a word. */
const OPENERS = new Set(['*', '_', '-', '+', '^', '~', '?', '!']);

/**
 * Escapes text so the wiki renderer shows it as written. A formatting character is only escaped
 * where it could open formatting — at the start of a word, before a non-space — because the
 * renderer needs an opener to format anything, and escaping every hyphen would litter `AC-1`
 * with backslashes for anyone reading the field in Jira's text editor.
 */
function escapeWiki(text: string, lineStart: boolean): string {
  const flat = text.replaceAll(/\s*\n\s*/g, ' ');
  let out = '';
  for (let i = 0; i < flat.length; i += 1) {
    const char = flat[i] ?? '';
    const before = i === 0 ? '' : (flat[i - 1] ?? '');
    const after = flat[i + 1];
    const opens = OPENERS.has(char) && !/[A-Za-z0-9]/.test(before) && after !== undefined && !/\s/.test(after);
    out += ALWAYS_SPECIAL.has(char) || opens ? `\\${char}` : char;
  }
  if (!lineStart) return out;
  // At the start of a line, `* `, `# ` and `- ` begin a list and `h1.` / `bq.` a block.
  if (/^[*#-]+\s/.test(out) || out.startsWith('#')) return `\\${out}`;
  return out.replace(/^(bq|h[1-6])\./, '$1\\.');
}

// --- wiki markup → Markdown ---

/**
 * Reads wiki markup as Markdown. Never throws on content a server chose; macros, mentions,
 * images and the formatting Markdown lacks are rendered as their text and named in `lossy`.
 */
export function wikiToMarkdown(wiki: string): MarkdownReading {
  const lossy = new Set<string>();
  const lines = wiki.replaceAll('\r\n', '\n').split('\n');
  const blocks = new WikiReader(lossy).blocks(lines);
  return { markdown: renderMarkdown(blocks, lossy), lossy: [...lossy].sort() };
}

const WIKI_HEADING = /^\s*h([1-6])\.\s+(.*)$/;
const WIKI_LIST = /^\s*([*#-]+)\s+(.*)$/;
const WIKI_CODE_OPEN = /^\s*\{(code|noformat)(?::([^}]*))?\}(.*)$/;
const WIKI_QUOTE = /^\s*\{quote\}\s*$/;
const WIKI_RULE = /^\s*-{4,}\s*$/;
const WIKI_TABLE = /^\s*\|/;
const WIKI_BLOCK_MACRO = /^\s*\{(panel|info|note|warning|tip|section|column|expand)(?::[^}]*)?\}\s*$/;

class WikiReader {
  public constructor(private readonly lossy: Set<string>) {}

  public blocks(lines: readonly string[]): MdBlock[] {
    const out: MdBlock[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i] ?? '';
      if (line.trim() === '') {
        i += 1;
        continue;
      }
      const consumed = this.block(lines, i);
      out.push(...consumed.blocks);
      i = consumed.next;
    }
    return out;
  }

  private block(lines: readonly string[], i: number): { blocks: MdBlock[]; next: number } {
    const line = lines[i] ?? '';
    const code = WIKI_CODE_OPEN.exec(line);
    if (code) return wikiCode(lines, i, code);
    if (WIKI_QUOTE.test(line))
      return fenced(lines, i, /^\s*\{quote\}\s*$/, (inner) => [{ type: 'quote', children: this.blocks(inner) }]);
    const macro = WIKI_BLOCK_MACRO.exec(line);
    if (macro) {
      this.lossy.add(`a {${macro[1] ?? 'macro'}} macro`);
      const name = macro[1] ?? '';
      return fenced(lines, i, new RegExp(String.raw`^\s*\{${name}\}\s*$`), (inner) => this.blocks(inner));
    }
    const heading = WIKI_HEADING.exec(line);
    if (heading) {
      return {
        blocks: [{ type: 'heading', level: Number(heading[1]), children: this.inline(heading[2] ?? '') }],
        next: i + 1,
      };
    }
    if (WIKI_RULE.test(line)) return { blocks: [{ type: 'rule' }], next: i + 1 };
    const quoteLine = /^\s*bq\.\s+(.*)$/.exec(line);
    if (quoteLine) {
      return {
        blocks: [{ type: 'quote', children: [{ type: 'paragraph', children: this.inline(quoteLine[1] ?? '') }] }],
        next: i + 1,
      };
    }
    if (WIKI_TABLE.test(line)) return this.table(lines, i);
    if (WIKI_LIST.test(line)) return this.list(lines, i);
    return this.paragraph(lines, i);
  }

  private table(lines: readonly string[], i: number): { blocks: MdBlock[]; next: number } {
    const rows: Array<{ header: boolean; cells: MdInline[][] }> = [];
    let j = i;
    while (j < lines.length && WIKI_TABLE.test(lines[j] ?? '')) {
      const raw = (lines[j] ?? '').trim();
      const header = raw.startsWith('||');
      const cells = splitCells(raw).map((cell) => this.inline(cell));
      rows.push({ header, cells });
      j += 1;
    }
    const [first, ...rest] = rows;
    if (first === undefined) return { blocks: [], next: j };
    if (!first.header) this.lossy.add('a table without a header row');
    const header = first.header ? first.cells : first.cells.map(() => []);
    const body = (first.header ? rest : rows).map((row) => row.cells);
    return { blocks: [{ type: 'table', header, rows: body }], next: j };
  }

  private list(lines: readonly string[], i: number): { blocks: MdBlock[]; next: number } {
    const entries: Array<{ markers: string; content: MdInline[] }> = [];
    let j = i;
    while (j < lines.length) {
      const match = WIKI_LIST.exec(lines[j] ?? '');
      if (match === null) break;
      entries.push({ markers: (match[1] ?? '*').replaceAll('-', '*'), content: this.inline(match[2] ?? '') });
      j += 1;
    }
    return { blocks: [buildList(entries, 0, entries.length, 1)], next: j };
  }

  private paragraph(lines: readonly string[], i: number): { blocks: MdBlock[]; next: number } {
    const children: MdInline[] = [];
    let j = i;
    while (j < lines.length) {
      const line = lines[j] ?? '';
      if (line.trim() === '') break;
      if (j > i && startsWikiBlock(line)) break;
      if (j > i) children.push({ type: 'break' });
      children.push(...this.inline(line));
      j += 1;
    }
    return { blocks: [{ type: 'paragraph', children }], next: j };
  }

  /** Scans inline markup. Formatting opens only at a word boundary, as Jira's renderer requires. */
  private inline(text: string): MdInline[] {
    const out: MdInline[] = [];
    let pending = '';
    const flush = (): void => {
      if (pending !== '') out.push({ type: 'text', text: pending });
      pending = '';
    };
    let i = 0;
    while (i < text.length) {
      const rest = text.slice(i);
      const before = i === 0 ? ' ' : (text[i - 1] ?? ' ');
      const boundary = !/[A-Za-z0-9]/.test(before);

      if (rest.startsWith('\\\\')) {
        flush();
        out.push({ type: 'break' });
        i += 2;
        continue;
      }
      // An escape only applies to a markup character; before anything else the backslash is text.
      if (rest.startsWith('\\') && rest.length > 1 && ESCAPABLE.test(rest[1] ?? '')) {
        pending += rest[1] ?? '';
        i += 2;
        continue;
      }
      const consumed = this.inlineToken(rest, boundary);
      if (consumed !== undefined) {
        flush();
        out.push(...consumed.nodes);
        i += consumed.length;
        continue;
      }
      pending += text[i] ?? '';
      i += 1;
    }
    flush();
    return out;
  }

  private inlineToken(rest: string, boundary: boolean): { nodes: MdInline[]; length: number } | undefined {
    const code = /^\{\{(.+?)\}\}/.exec(rest);
    if (code)
      return { nodes: [{ type: 'code', text: (code[1] ?? '').replaceAll('\\}', '}') }], length: code[0].length };

    const mention = /^\[~([^\]]+)\]/.exec(rest);
    if (mention) {
      this.lossy.add('a mention');
      return { nodes: [{ type: 'text', text: `@${mention[1] ?? ''}` }], length: mention[0].length };
    }

    const link = /^\[([^\]|]*)(?:\|([^\]]*))?\]/.exec(rest);
    if (link) {
      const target = (link[2] ?? link[1] ?? '').trim();
      const label = link[2] === undefined ? target : (link[1] ?? '');
      if (/^(https?:|mailto:|\/|#)/.test(target)) {
        return { nodes: [{ type: 'link', href: target, children: this.inline(label) }], length: link[0].length };
      }
      // `[PROJ-1]` and `[Page title]` link to Jira or Confluence objects Markdown has no form for.
      this.lossy.add('a link to a Jira or Confluence object');
      return { nodes: this.inline(label), length: link[0].length };
    }

    const image = /^!([^!\s][^!]*)!/.exec(rest);
    if (image && boundary) {
      this.lossy.add('an attachment or image');
      return { nodes: [{ type: 'text', text: '[attachment]' }], length: image[0].length };
    }

    const macro = /^\{(color|anchor|status|jira)(?::[^}]*)?\}/.exec(rest);
    if (macro) {
      this.lossy.add(`a {${macro[1] ?? 'macro'}} macro`);
      return { nodes: [], length: macro[0].length };
    }

    if (!boundary) return undefined;
    for (const [marker, kind] of FORMATTING) {
      const match = formatted(rest, marker);
      if (match === undefined) continue;
      const children = this.inline(match.inner);
      if (kind === 'strong' || kind === 'em') return { nodes: [{ type: kind, children }], length: match.length };
      this.lossy.add('text formatting other than bold, italic, code and links');
      return { nodes: children, length: match.length };
    }
    return undefined;
  }
}

function wikiCode(lines: readonly string[], i: number, open: RegExpExecArray): { blocks: MdBlock[]; next: number } {
  const kind = open[1] ?? 'code';
  const params = open[2] ?? '';
  // `{code:java}`, or `{code:title=x|language=java}`.
  const language = /(?:^|\|)language=([\w+-]+)/.exec(params)?.[1] ?? (/^[\w+-]+$/.test(params) ? params : '');
  const close = new RegExp(String.raw`\{${kind}\}`);
  const body: string[] = [];
  const sameLine = open[3] ?? '';
  const closedOnLine = close.exec(sameLine);
  if (closedOnLine) {
    return { blocks: [{ type: 'code', language, text: sameLine.slice(0, closedOnLine.index) }], next: i + 1 };
  }
  if (sameLine.trim() !== '') body.push(sameLine);
  let j = i + 1;
  while (j < lines.length) {
    const candidate = lines[j] ?? '';
    const end = close.exec(candidate);
    if (end) {
      const before = candidate.slice(0, end.index);
      if (before.trim() !== '') body.push(before);
      return { blocks: [{ type: 'code', language, text: body.join('\n') }], next: j + 1 };
    }
    body.push(candidate);
    j += 1;
  }
  // An unclosed block runs to the end of the field, which is how Jira renders it too.
  return { blocks: [{ type: 'code', language, text: body.join('\n') }], next: j };
}

function fenced(
  lines: readonly string[],
  i: number,
  close: RegExp,
  build: (inner: string[]) => MdBlock[],
): { blocks: MdBlock[]; next: number } {
  const inner: string[] = [];
  let j = i + 1;
  while (j < lines.length && !close.test(lines[j] ?? '')) {
    inner.push(lines[j] ?? '');
    j += 1;
  }
  return { blocks: build(inner), next: Math.min(j + 1, lines.length) };
}

const ESCAPABLE = /[{}[\]|*_\-+^~?!#.]/;

const FORMATTING: ReadonlyArray<readonly [string, 'strong' | 'em' | 'other']> = [
  ['*', 'strong'],
  ['_', 'em'],
  ['??', 'other'],
  ['-', 'other'],
  ['+', 'other'],
  ['^', 'other'],
  ['~', 'other'],
];

/** `*x*`: the opener is followed by a non-space, and the closer preceded by one and not by a word. */
function formatted(rest: string, marker: string): { inner: string; length: number } | undefined {
  if (!rest.startsWith(marker)) return undefined;
  const after = rest.slice(marker.length);
  if (after === '' || /^\s/.test(after)) return undefined;
  let search = 0;
  while (search < after.length) {
    const end = after.indexOf(marker, search);
    if (end <= 0) return undefined;
    const closing = after[end - 1] ?? '';
    const next = after[end + marker.length] ?? '';
    if (!/\s/.test(closing) && closing !== '\\' && !/[A-Za-z0-9]/.test(next)) {
      return { inner: after.slice(0, end), length: marker.length * 2 + end };
    }
    search = end + 1;
  }
  return undefined;
}

/** Cells split on `|` and `||`, except inside a link or a `{{code}}` span. */
function splitCells(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i] ?? '';
    if (char === '\\' && i + 1 < row.length) {
      current += char + (row[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    if ((char === ']' || char === '}') && depth > 0) depth -= 1;
    if (char === '|' && depth === 0) {
      cells.push(current);
      current = '';
      if (row[i + 1] === '|') i += 1;
      continue;
    }
    current += char;
  }
  cells.push(current);
  // The row's leading and trailing pipes produce empty first and last entries.
  return cells.slice(1, current.trim() === '' ? -1 : undefined).map((cell) => cell.trim());
}

function startsWikiBlock(line: string): boolean {
  return (
    WIKI_HEADING.test(line) ||
    WIKI_LIST.test(line) ||
    WIKI_CODE_OPEN.test(line) ||
    WIKI_QUOTE.test(line) ||
    WIKI_RULE.test(line) ||
    WIKI_TABLE.test(line) ||
    WIKI_BLOCK_MACRO.test(line) ||
    /^\s*bq\.\s/.test(line)
  );
}

/** Builds nested lists from flat `*`/`#` marker runs, the way the wiki renderer nests them. */
function buildList(
  entries: ReadonlyArray<{ markers: string; content: MdInline[] }>,
  start: number,
  end: number,
  depth: number,
): MdList {
  const ordered = (entries[start]?.markers[depth - 1] ?? '*') === '#';
  const items: Array<{ content: MdInline[]; children: MdList[] }> = [];
  let i = start;
  while (i < end) {
    const entry = entries[i];
    if (entry === undefined) break;
    if (entry.markers.length <= depth) {
      items.push({ content: entry.content, children: [] });
      i += 1;
      continue;
    }
    // A deeper run hangs under the item above it, or under an empty one when it comes first.
    let childEnd = i;
    while (childEnd < end && (entries[childEnd]?.markers.length ?? 0) > depth) childEnd += 1;
    if (items.length === 0) items.push({ content: [], children: [] });
    items.at(-1)?.children.push(buildList(entries, i, childEnd, depth + 1));
    i = childEnd;
  }
  return { type: 'list', ordered, items };
}
