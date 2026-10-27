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
import type { MdBlock, MdInline, MdList } from './markdown-ast.js';
import { renderMarkdown } from './markdown-render.js';
import { DROPPED, parseStorage, type StorageChild, type StorageNode } from './storage-markdown.js';

/**
 * Reads a storage body as Markdown that saves back to the same storage.
 *
 * `storageToMarkdown` exists for people and agents *reading* a page, and is deliberately lossy
 * in ways that do not matter there: a `<br />` becomes a space, an asterisk stays unescaped.
 * Both matter when the Markdown is going to be edited and saved over the page, because the save
 * would quietly rejoin lines and turn prose into emphasis. This reader produces the parse tree
 * `markdown-ast.ts` defines and writes it with `renderMarkdown`, so a page `markdownToStorage`
 * wrote reads back exactly — which the tests pin.
 *
 * Content outside that subset is kept as its visible text and named in `lossy` (`storageLoss`).
 * See design 0020.
 */
export function storageToMarkdownReading(storage: string): MarkdownReading {
  const lossy = new Set(storageLoss(storage));
  const markdown = renderMarkdown(blocks(parseStorage(storage)), lossy);
  return { markdown, lossy: [...lossy].sort() };
}

const HEADINGS: Readonly<Record<string, number>> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** Containers with no Markdown meaning; their children are read through them. */
const TRANSPARENT = new Set([
  'ac:layout',
  'ac:layout-section',
  'ac:layout-cell',
  'ac:rich-text-body',
  'ac:adf-fallback',
  'div',
  'section',
  'tbody',
  'thead',
]);

const BLOCK_TAGS = new Set([
  ...Object.keys(HEADINGS),
  'p',
  'ul',
  'ol',
  'table',
  'blockquote',
  'pre',
  'hr',
  'ac:structured-macro',
  'ac:task-list',
  'ac:adf-extension',
  ...TRANSPARENT,
]);

function isNode(child: StorageChild): child is StorageNode {
  return typeof child !== 'string';
}

function textOf(children: readonly StorageChild[]): string {
  return children.map((child) => (isNode(child) ? textOf(child.children) : child)).join('');
}

function blocks(children: readonly StorageChild[]): MdBlock[] {
  const out: MdBlock[] = [];
  let pending: StorageChild[] = [];
  const flush = (): void => {
    const content = trimInline(inline(pending));
    if (content.length > 0) out.push({ type: 'paragraph', children: content });
    pending = [];
  };

  for (const child of children) {
    if (isNode(child) && DROPPED.has(child.tag)) continue;
    if (!isNode(child) || !BLOCK_TAGS.has(child.tag)) {
      pending.push(child);
      continue;
    }
    flush();
    out.push(...block(child));
  }
  flush();
  return out;
}

function block(node: StorageNode): MdBlock[] {
  const level = HEADINGS[node.tag];
  if (level !== undefined) return [{ type: 'heading', level, children: trimInline(inline(node.children)) }];
  if (TRANSPARENT.has(node.tag)) return blocks(node.children);

  switch (node.tag) {
    case 'p': {
      const content = trimInline(inline(node.children));
      return content.length === 0 ? [] : [{ type: 'paragraph', children: content }];
    }
    case 'ul':
    case 'ol':
      return [list(node)];
    case 'table':
      return table(node);
    case 'blockquote':
      return [{ type: 'quote', children: blocks(node.children) }];
    case 'pre':
      return [{ type: 'code', language: '', text: textOf(node.children).replace(/^\n+|\n+$/g, '') }];
    case 'hr':
      return [{ type: 'rule' }];
    case 'ac:structured-macro':
      return macro(node);
    case 'ac:task-list':
      return [
        {
          type: 'list',
          ordered: false,
          items: node.children
            .filter((task): task is StorageNode => isNode(task) && task.tag === 'ac:task')
            .map((task) => ({
              content: trimInline(inline(task.children.filter((part) => isNode(part) && part.tag === 'ac:task-body'))),
              children: [],
            })),
        },
      ];
    default:
      // An ADF extension: its readable content, when it has any, is in the fallback.
      return blocks(node.children.filter((child) => isNode(child) && child.tag === 'ac:adf-fallback'));
  }
}

function macro(node: StorageNode): MdBlock[] {
  const parts = node.children.filter(isNode);
  if (node.attrs['ac:name'] === 'code') {
    const language = parts.find((part) => part.tag === 'ac:parameter' && part.attrs['ac:name'] === 'language');
    const body = parts.find((part) => part.tag === 'ac:plain-text-body');
    const code = textOf(language?.children ?? []).trim();
    return [{ type: 'code', language: /^[\w+-]*$/.test(code) ? code : '', text: textOf(body?.children ?? []) }];
  }
  // Any other macro keeps the content of its rich body, so a panel's words survive as text.
  return parts.filter((part) => part.tag === 'ac:rich-text-body').flatMap((part) => blocks(part.children));
}

function list(node: StorageNode): MdList {
  const items = node.children
    .filter((item): item is StorageNode => isNode(item) && item.tag === 'li')
    .map((item) => {
      const nested = item.children.filter(
        (child): child is StorageNode => isNode(child) && (child.tag === 'ul' || child.tag === 'ol'),
      );
      const own = item.children.filter((child) => !(isNode(child) && nested.includes(child)));
      return { content: cellContent(own), children: nested.map((child) => list(child)) };
    });
  return { type: 'list', ordered: node.tag === 'ol', items };
}

function table(node: StorageNode): MdBlock[] {
  const rows: Array<{ header: boolean; cells: MdInline[][] }> = [];
  const collect = (children: readonly StorageChild[]): void => {
    for (const child of children) {
      if (!isNode(child)) continue;
      if (child.tag === 'tr') {
        const cells = child.children.filter(
          (cell): cell is StorageNode => isNode(cell) && (cell.tag === 'td' || cell.tag === 'th'),
        );
        rows.push({
          header: cells.every((cell) => cell.tag === 'th'),
          cells: cells.map((cell) => cellContent(cell.children)),
        });
      } else if (child.tag !== 'table') {
        collect(child.children);
      }
    }
  };
  collect(node.children);
  const [first, ...rest] = rows;
  if (first === undefined) return [];
  const header = first.header ? first.cells : first.cells.map(() => []);
  return [{ type: 'table', header, rows: (first.header ? rest : rows).map((row) => row.cells) }];
}

/** A list item or cell holds paragraphs in storage and one line in Markdown; they are joined. */
function cellContent(children: readonly StorageChild[]): MdInline[] {
  const out: MdInline[] = [];
  for (const part of blocks(children)) {
    if (out.length > 0) out.push({ type: 'text', text: ' ' });
    if (part.type === 'paragraph' || part.type === 'heading') out.push(...part.children);
    else out.push({ type: 'text', text: textOfBlock(part) });
  }
  return out;
}

function textOfBlock(part: MdBlock): string {
  if (part.type === 'code') return part.text;
  return '';
}

function inline(children: readonly StorageChild[]): MdInline[] {
  const out: MdInline[] = [];
  for (const child of children) {
    if (!isNode(child)) {
      // Storage is XHTML: runs of whitespace between tags are layout, not content.
      const text = child.replaceAll(/\s+/g, ' ');
      if (text !== '') out.push({ type: 'text', text });
      continue;
    }
    if (DROPPED.has(child.tag)) continue;
    out.push(...inlineNode(child));
  }
  return out;
}

function inlineNode(node: StorageNode): MdInline[] {
  switch (node.tag) {
    case 'strong':
    case 'b':
      return [{ type: 'strong', children: inline(node.children) }];
    case 'em':
    case 'i':
      return [{ type: 'em', children: inline(node.children) }];
    case 'code':
      return [{ type: 'code', text: textOf(node.children) }];
    case 'br':
      return [{ type: 'break' }];
    case 'a': {
      const href = node.attrs.href ?? '';
      const children = inline(node.children);
      return /^(https?:|mailto:|\/|#)/.test(href) ? [{ type: 'link', href, children }] : children;
    }
    case 'ac:image':
    case 'img':
      return [{ type: 'text', text: '[attachment]' }];
    case 'ac:link':
      return confluenceLink(node);
    case 'ac:emoticon':
      return [{ type: 'text', text: node.attrs['ac:emoji-fallback'] ?? '' }];
    case 'time':
      return [{ type: 'text', text: node.attrs.datetime ?? '' }];
    case 'ac:structured-macro':
      // An inline macro (a status lozenge, a Jira link) shows its title, when it has one.
      return [
        {
          type: 'text',
          text: textOf(
            node.children.filter(
              (child) => isNode(child) && child.tag === 'ac:parameter' && child.attrs['ac:name'] === 'title',
            ),
          ),
        },
      ];
    default:
      return inline(node.children);
  }
}

/** A link to a page, attachment or user: its own words, or the name of what it points at. */
function confluenceLink(node: StorageNode): MdInline[] {
  const body = node.children.filter(
    (child): child is StorageNode =>
      isNode(child) && (child.tag === 'ac:link-body' || child.tag === 'ac:plain-text-link-body'),
  );
  if (body.length > 0) return body.flatMap((part) => inline(part.children));
  const target = node.children.find((child): child is StorageNode => isNode(child) && child.tag.startsWith('ri:'));
  const attrs = target?.attrs ?? {};
  const name = attrs['ri:content-title'] ?? attrs['ri:filename'] ?? attrs['ri:username'] ?? '';
  return name === '' ? [] : [{ type: 'text', text: name }];
}

/** Whitespace at the edges of a paragraph, or either side of a line break, is layout. */
function trimInline(nodes: readonly MdInline[]): MdInline[] {
  const out = nodes.map((node, index): MdInline => {
    if (node.type !== 'text') return node;
    let text = node.text;
    if (index === 0 || nodes[index - 1]?.type === 'break') text = text.trimStart();
    if (index === nodes.length - 1 || nodes[index + 1]?.type === 'break') text = text.trimEnd();
    return { type: 'text', text };
  });
  return out.filter((node) => node.type !== 'text' || node.text !== '');
}

/** Storage elements `markdownToStorage` writes and this reader reads back unchanged. */
const ROUND_TRIPS = new Set([
  ...Object.keys(HEADINGS),
  'p',
  'strong',
  'b',
  'em',
  'i',
  'code',
  'a',
  'br',
  'hr',
  'ul',
  'ol',
  'li',
  'blockquote',
  'table',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'pre',
  'span',
  'ac:parameter',
  'ac:plain-text-body',
]);

const FORMATTING_LOSS = 'text formatting other than bold, italic, code and links';

/** What each lossy element is called when a caller is told about it. */
const LOSS_NAMES: Readonly<Record<string, string>> = {
  'ac:link': 'a link to a Confluence page, attachment or user',
  'ac:image': 'an attachment or image',
  img: 'an attachment or image',
  'ac:task-list': 'a task list',
  'ac:emoticon': 'an emoticon',
  'ac:adf-extension': 'a macro',
  time: 'a date',
  u: FORMATTING_LOSS,
  s: FORMATTING_LOSS,
  del: FORMATTING_LOSS,
  sub: FORMATTING_LOSS,
  sup: FORMATTING_LOSS,
};

/**
 * Names everything in a storage body that its Markdown reading cannot carry back.
 *
 * Deliberately conservative: an element counts as lossless only when `markdownToStorage` itself
 * writes it. Reporting a loss that is not one costs a caller an explicit `acceptLoss`; missing a
 * real one costs a page its macros the next time an agent saves it.
 */
export function storageLoss(storage: string): string[] {
  const lossy = new Set<string>();
  const visit = (children: readonly StorageChild[]): void => {
    for (const child of children) {
      if (!isNode(child) || DROPPED.has(child.tag)) continue;
      const known = noteLoss(child, lossy);
      // The parts inside an element already reported (an `ac:link`'s `ri:page`) add nothing.
      if (known) visit(child.children);
    }
  };
  visit(parseStorage(storage));
  return [...lossy].sort();
}

/** Records the element's loss, if any; true when its children still need looking at. */
function noteLoss(node: StorageNode, lossy: Set<string>): boolean {
  if (Number(node.attrs.colspan ?? 1) > 1 || Number(node.attrs.rowspan ?? 1) > 1) lossy.add('a merged table cell');
  if (node.tag === 'ac:structured-macro') {
    const name = node.attrs['ac:name'] ?? 'unnamed';
    if (name === 'code') return true;
    lossy.add(`a "${name}" macro`);
    return true;
  }
  if (node.tag.startsWith('ac:layout')) {
    lossy.add('a column layout');
    return true;
  }
  if (node.tag === 'ac:rich-text-body') return true;
  if (ROUND_TRIPS.has(node.tag)) return true;
  lossy.add(LOSS_NAMES[node.tag] ?? `a <${node.tag}> element`);
  return false;
}
