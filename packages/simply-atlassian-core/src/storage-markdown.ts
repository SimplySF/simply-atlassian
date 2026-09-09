/*
 * Copyright (c) 2026, Clay Chipps.
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

/**
 * Converts Confluence storage format to Markdown.
 *
 * Storage format is XHTML plus Atlassian's own `ac:`/`ri:` macro elements. It is a constrained,
 * documented subset rather than arbitrary HTML, which is why a purpose-built renderer is
 * practical here: a general HTML-to-Markdown library would still need bespoke rules for every
 * macro, which is the genuinely Confluence-specific half of the problem.
 *
 * Deliberately lossy, and stated so nobody is surprised: images and attachments become their
 * filename in brackets, layout macros are flattened, an unrecognized macro keeps its name but
 * loses its body, `colspan`/`rowspan` are dropped so a spanning cell shifts the rest of its
 * row, and a nested table collapses into its cell's text. `--json` always carries the
 * untouched original.
 */

interface Node {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly children: Child[];
}

type Child = Node | string;

/**
 * Tags whose content is discarded outright. The `ac:` entries hold Atlassian's own bookkeeping
 * — task states, ADF attribute values such as local-id UUIDs — which would otherwise surface
 * as stray text in the middle of a page. The renderers that need those values read them
 * directly rather than through the generic traversal.
 */
const DROPPED = new Set(['script', 'style', 'ac:task-status', 'ac:task-id', 'ac:adf-attribute', 'ac:adf-mark']);

/** Void elements, which never have a closing tag. */
const VOID = new Set(['br', 'hr', 'img', 'meta', 'link', 'ri:attachment', 'ri:url', 'ri:user', 'ri:page']);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(text: string): string {
  return text.replaceAll(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body.startsWith('#x') || body.startsWith('#X');
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      // Above the Unicode maximum, or in the surrogate range, fromCodePoint throws — and this
      // function is documented never to throw on markup a server chose.
      const usable = Number.isInteger(code) && code > 0 && code <= 0x10_ff_ff && !(code >= 0xd8_00 && code <= 0xdf_ff);
      return usable ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * One pass over every construct the markup can contain. Comments and processing instructions
 * are skipped; a CDATA section's contents are literal text, which matters because Confluence
 * wraps code-macro bodies in CDATA — treating that as markup both printed the delimiters and
 * silently ate anything inside it that looked like a tag.
 */
const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[!?][^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;

/** Attributes may be quoted, unquoted, or valueless (`<td nowrap>`). */
const ATTR = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTR)) {
    const name = match[1];
    // A valueless attribute is present-with-no-value, which is how HTML spells `true`.
    if (name !== undefined) attrs[name.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/**
 * Builds a tree from the markup. Unclosed and mismatched tags are tolerated rather than treated
 * as fatal — a page body is data from a server, and refusing to render an imperfect one would
 * be worse than rendering it approximately.
 */
function parse(markup: string): Child[] {
  const root: Node = { tag: '#root', attrs: {}, children: [] };
  const stack: Node[] = [root];
  let cursor = 0;

  const pushText = (text: string): void => {
    if (text === '') return;
    stack.at(-1)?.children.push(decodeEntities(text));
  };

  for (const match of markup.matchAll(TOKEN)) {
    const [full, cdata, closing, rawTag, rawAttrs, selfClosing] = match;
    pushText(markup.slice(cursor, match.index));
    cursor = match.index + full.length;

    // CDATA content is literal: no entity decoding, no markup, newlines preserved.
    if (cdata !== undefined) {
      if (cdata !== '') stack.at(-1)?.children.push(cdata);
      continue;
    }
    // A comment, doctype, or processing instruction contributes nothing.
    if (rawTag === undefined) continue;

    const tag = rawTag.toLowerCase();

    if (closing === '/') {
      // Close the nearest matching ancestor; ignore a stray closer entirely.
      const depth = stack.findLastIndex((node) => node.tag === tag);
      if (depth > 0) stack.length = depth;
      continue;
    }

    const node: Node = { tag, attrs: parseAttrs(rawAttrs ?? ''), children: [] };
    stack.at(-1)?.children.push(node);
    if (selfClosing !== '/' && !VOID.has(tag)) stack.push(node);
  }

  pushText(markup.slice(cursor));
  return root.children;
}

function isNode(child: Child): child is Node {
  return typeof child !== 'string';
}

function childNodes(children: readonly Child[], tag: string): Node[] {
  return children.filter((child): child is Node => isNode(child) && child.tag === tag);
}

function plainText(children: readonly Child[]): string {
  return children.map((child) => (isNode(child) ? plainText(child.children) : child)).join('');
}

function macroParameter(node: Node, name: string): string | undefined {
  for (const child of childNodes(node.children, 'ac:parameter')) {
    if (child.attrs['ac:name'] === name) return plainText(child.children).trim();
  }
  return undefined;
}

/**
 * A macro body comes in two flavours. `ac:plain-text-body` is verbatim — it holds code, so its
 * newlines and indentation are the content and must survive. `ac:rich-text-body` is markup and
 * renders as blocks.
 */
function macroBody(node: Node): string {
  const parts: string[] = [];
  for (const child of node.children) {
    if (!isNode(child)) continue;
    if (child.tag === 'ac:plain-text-body') parts.push(plainText(child.children));
    else if (child.tag === 'ac:rich-text-body') parts.push(renderBlocks(child.children));
  }
  return parts.filter((part) => part.trim() !== '').join('\n\n');
}

function referenceName(node: Node): string | undefined {
  for (const child of node.children) {
    if (!isNode(child)) continue;
    if (child.tag === 'ri:attachment') return child.attrs['ri:filename'];
    if (child.tag === 'ri:url') return child.attrs['ri:value'];
    if (child.tag === 'ri:page') return child.attrs['ri:content-title'];
  }
  return undefined;
}

/* ------------------------------------------------------------------ inline */

/**
 * Wraps a mark, preserving whitespace that sat *inside* it. Trimming without putting the space
 * back fused words together: `<strong>Note: </strong>see` used to render as `**Note:**see`.
 */
function marked(node: Node, fence: string): string {
  const raw = renderInline(node.children);
  const text = raw.trim();
  if (text === '') return raw === '' ? '' : ' ';

  const lead = /^\s/.test(raw) ? ' ' : '';
  const trail = /\s$/.test(raw) ? ' ' : '';
  // A code span containing a backtick needs a longer fence, or Markdown re-parses it wrongly.
  const guard = fence === '`' && text.includes('`') ? '``' : fence;
  const padding = guard.startsWith('`') && (text.startsWith('`') || text.endsWith('`')) ? ' ' : '';
  return `${lead}${guard}${padding}${text}${padding}${guard}${trail}`;
}

/** One renderer per inline tag, so adding a tag never grows a switch statement. */
const INLINE: Record<string, (node: Node) => string> = {
  strong: (node) => marked(node, '**'),
  b: (node) => marked(node, '**'),
  em: (node) => marked(node, '_'),
  i: (node) => marked(node, '_'),
  del: (node) => marked(node, '~~'),
  s: (node) => marked(node, '~~'),
  code: (node) => marked(node, '`'),
  br: () => '\n',
  a: (node) => {
    const text = renderInline(node.children).trim();
    const href = node.attrs.href ?? '';
    if (href === '') return text;
    return `[${text === '' ? href : text}](${href})`;
  },
  img: (node) => `[image: ${node.attrs.src ?? node.attrs.alt ?? 'image'}]`,
  'ac:image': (node) => `[image: ${referenceName(node) ?? 'attached'}]`,
  'ac:link': (node) => {
    const label = childNodes(node.children, 'ac:link-body')
      .map((body) => renderInline(body.children).trim())
      .join('');
    return `[${label === '' ? (referenceName(node) ?? 'link') : label}]`;
  },
  // An inline macro (a status lozenge, a date) reads better as its name than as a block.
  'ac:structured-macro': (node) => `[${node.attrs['ac:name'] ?? 'macro'}]`,
  'ac:emoticon': (node) => node.attrs['ac:emoji-fallback'] ?? '',
  'ac:placeholder': (node) => renderInline(node.children),
};

/** Inline rendering: marks and links, with anything unrecognized rendered through. */
function renderInline(children: readonly Child[]): string {
  return children
    .map((child) => {
      if (!isNode(child)) return child;
      if (DROPPED.has(child.tag)) return '';
      const render = INLINE[child.tag] ?? ((node: Node): string => renderInline(node.children));
      return render(child);
    })
    .join('')
    .replaceAll(/[ \t\r\n]+/g, ' ');
}

/* ------------------------------------------------------------------- block */

/** A pipe inside a cell would add a column, so it is escaped rather than passed through. */
function cellText(cell: Node): string {
  const text = renderInline(cell.children).replaceAll('\n', ' ').trim().replaceAll('|', '\\|');
  return text === '' ? ' ' : text;
}

function renderTable(node: Node): string {
  const rows: string[][] = [];
  let firstRowIsHeader = false;
  const collect = (children: readonly Child[]): void => {
    for (const child of children) {
      if (!isNode(child)) continue;
      if (child.tag === 'tr') {
        const cells = child.children.filter(
          (cell): cell is Node => isNode(cell) && (cell.tag === 'td' || cell.tag === 'th'),
        );
        // Markdown needs a header row, but plenty of Confluence tables have none. Whether the
        // first row is one decides between using it as the header and adding a blank header —
        // the alternative, assuming it always is, silently promotes real data into column names.
        if (rows.length === 0) firstRowIsHeader = cells.some((cell) => cell.tag === 'th');
        rows.push(cells.map((cell) => cellText(cell)));
      } else {
        collect(child.children);
      }
    }
  };
  collect(node.children);
  if (rows.length === 0) return '';

  // Reduce rather than spread: a very large table would exceed the argument limit.
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  const repeat = (count: number, value: string): string[] => Array.from({ length: count }, () => value);
  const pad = (row: readonly string[]): string => `| ${[...row, ...repeat(width - row.length, ' ')].join(' | ')} |`;
  const rule = `| ${repeat(width, '---').join(' | ')} |`;

  const [first, ...rest] = rows;
  if (firstRowIsHeader && first !== undefined) return [pad(first), rule, ...rest.map((row) => pad(row))].join('\n');
  return [pad(repeat(width, ' ')), rule, ...rows.map((row) => pad(row))].join('\n');
}

function renderList(node: Node, depth: number): string {
  const ordered = node.tag === 'ol';
  const indent = '  '.repeat(depth);

  return childNodes(node.children, 'li')
    .map((item, index): string => {
      const marker = ordered ? `${index + 1}.` : '-';
      const nested = item.children.filter(
        (child): child is Node => isNode(child) && (child.tag === 'ul' || child.tag === 'ol'),
      );
      const own = renderInline(item.children.filter((child) => !nested.includes(child as Node))).trim();
      return [`${indent}${marker} ${own}`, ...nested.map((list) => renderList(list, depth + 1))].join('\n');
    })
    .join('\n');
}

/** `<ac:task-list>` is a checklist; the tick state sits in a sibling element, not an attribute. */
function renderTaskList(node: Node): string {
  return childNodes(node.children, 'ac:task')
    .map((task): string => {
      const status = childNodes(task.children, 'ac:task-status')
        .map((child) => plainText(child.children).trim())
        .join('');
      const body = childNodes(task.children, 'ac:task-body')
        .map((child) => renderInline(child.children).trim())
        .join(' ')
        .trim();
      return `- [${status === 'complete' ? 'x' : ' '}] ${body}`.trimEnd();
    })
    .join('\n');
}

/**
 * An ADF extension (a decision list, an inline task, a panel authored in the new editor) is a
 * tree of typed nodes plus attributes. Its readable content, when there is any, lives in a
 * fallback element; the attributes are identifiers and state flags. Naming the extension is
 * more useful than either dropping it silently or spilling its UUIDs into the page.
 */
function renderAdfExtension(node: Node): string {
  const fallback = childNodes(node.children, 'ac:adf-fallback')
    .map((child) => renderBlocks(child.children).trim())
    .filter((text) => text !== '')
    .join('\n\n');
  if (fallback !== '') return fallback;

  const type = childNodes(node.children, 'ac:adf-node')[0]?.attrs.type;
  return `> [${type ?? 'extension'}]`;
}

/**
 * Wraps verbatim text in a fence that its own content cannot break out of: the info string is
 * reduced to a plausible language token, and the fence is always longer than the longest run of
 * backticks inside. Without both, a page author could close the fence early and have the rest
 * of their text read as narrative prose rather than inert code.
 */
function fenced(body: string, info = ''): string {
  const language = info.replaceAll(/[^A-Za-z0-9_+-]/g, '').slice(0, 24);
  const longestRun = [...body.matchAll(/`+/g)].reduce((longest, run) => Math.max(longest, run[0].length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${body}\n${fence}`;
}

const PANEL_MACROS = new Set(['info', 'note', 'warning', 'tip', 'panel']);

function quote(text: string): string {
  return text === '' ? '' : text.replaceAll(/^/gm, '> ');
}

/** A structured macro: code blocks get a fence, panels a labelled quote, the rest a placeholder. */
function renderMacro(node: Node): string {
  const name = node.attrs['ac:name'] ?? 'macro';

  if (name === 'code') {
    return fenced(macroBody(node).replace(/^\n+|\n+$/g, ''), macroParameter(node, 'language') ?? '');
  }

  const body = macroBody(node).trim();
  if (PANEL_MACROS.has(name)) return `> **${name}**\n${quote(body)}`;
  return body === '' ? `> [macro: ${name}]` : `> [macro: ${name}]\n${quote(body)}`;
}

const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** Containers that carry no meaning in Markdown, so their children render through them. */
const TRANSPARENT = new Set([
  'ac:layout',
  'ac:layout-section',
  'ac:layout-cell',
  'ac:rich-text-body',
  'div',
  'section',
]);

/** One renderer per block tag. Returning undefined means "not a block; treat as inline". */
const BLOCK: Record<string, (node: Node) => string> = {
  p: (node) => renderInline(node.children).trim(),
  ul: (node) => renderList(node, 0).trim(),
  ol: (node) => renderList(node, 0).trim(),
  table: (node) => renderTable(node).trim(),
  blockquote: (node) => quote(renderBlocks(node.children).trim()),
  pre: (node) => fenced(plainText(node.children).replace(/^\n+|\n+$/g, '')),
  hr: () => '---',
  'ac:structured-macro': (node) => renderMacro(node).trim(),
  'ac:task-list': (node) => renderTaskList(node).trim(),
  'ac:adf-extension': (node) => renderAdfExtension(node).trim(),
};

function blockFor(node: Node): ((node: Node) => string) | undefined {
  const level = HEADINGS[node.tag];
  if (level !== undefined) {
    return (heading) => {
      const text = renderInline(heading.children).trim();
      return text === '' ? '' : `${'#'.repeat(level)} ${text}`;
    };
  }
  if (TRANSPARENT.has(node.tag)) return (container) => renderBlocks(container.children).trim();
  return BLOCK[node.tag];
}

/** Block rendering: each block becomes its own paragraph, separated by a blank line. */
function renderBlocks(children: readonly Child[]): string {
  const blocks: string[] = [];
  let pending: Child[] = [];

  const flush = (): void => {
    const text = renderInline(pending).trim();
    if (text !== '') blocks.push(text);
    pending = [];
  };

  for (const child of children) {
    if (!isNode(child)) {
      pending.push(child);
      continue;
    }
    if (DROPPED.has(child.tag)) continue;

    const render = blockFor(child);
    if (render === undefined) {
      pending.push(child);
      continue;
    }

    flush();
    const rendered = render(child);
    if (rendered !== '') blocks.push(rendered);
  }

  flush();
  return blocks.join('\n\n');
}

/** Converts a storage-format body to Markdown. Never throws on malformed markup. */
export function storageToMarkdown(storage: string): string {
  if (storage.trim() === '') return '';
  return renderBlocks(parse(storage))
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}
