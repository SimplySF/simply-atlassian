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

import { parseMarkdown, type MdBlock, type MdInline, type MdList } from './markdown-ast.js';
import { renderMarkdown } from './markdown-render.js';

/**
 * Markdown ↔ Atlassian Document Format, the JSON document model Jira Cloud stores rich text in.
 *
 * Until this existed, Cloud descriptions were sent as bare paragraphs (`descriptionValue`), so a
 * heading, a numbered list of acceptance criteria or a table arrived as flat text — the shape a
 * business reviewer then had to sign off on. See design 0020.
 *
 * Two ADF rules are not optional and both are enforced by Cloud's validator: a text node may not
 * be empty, and may not contain a newline (a `hardBreak` node is the line break).
 */

/** An ADF node. Deliberately loose: the reader below accepts whatever Cloud sends. */
export interface AdfNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly AdfNode[];
  readonly text?: string;
  readonly marks?: ReadonlyArray<{ readonly type: string; readonly attrs?: Readonly<Record<string, unknown>> }>;
}

export interface AdfDocument extends AdfNode {
  readonly type: 'doc';
  readonly version: 1;
  readonly content: readonly AdfNode[];
}

/** Converts Markdown to an ADF document. Refusals are `parseMarkdown`'s. */
export function markdownToAdf(markdown: string): AdfDocument {
  return { type: 'doc', version: 1, content: parseMarkdown(markdown, 'jira').map((block) => adfBlock(block)) };
}

function adfBlock(block: MdBlock): AdfNode {
  switch (block.type) {
    case 'heading':
      return { type: 'heading', attrs: { level: block.level }, content: adfInline(block.children) };
    case 'paragraph':
      return paragraph(block.children);
    case 'code': {
      const attrs = block.language === '' ? {} : { attrs: { language: block.language } };
      return { type: 'codeBlock', ...attrs, content: block.text === '' ? [] : [{ type: 'text', text: block.text }] };
    }
    case 'rule':
      return { type: 'rule' };
    case 'quote':
      return { type: 'blockquote', content: block.children.map((child) => adfBlock(child)) };
    case 'list':
      return adfList(block);
    case 'table':
      return {
        type: 'table',
        attrs: { isNumberColumnEnabled: false, layout: 'default' },
        content: [
          {
            type: 'tableRow',
            content: block.header.map((cell) => ({ type: 'tableHeader', content: [paragraph(cell)] })),
          },
          ...block.rows.map((row) => ({
            type: 'tableRow',
            content: row.map((cell) => ({ type: 'tableCell', content: [paragraph(cell)] })),
          })),
        ],
      };
  }
}

function paragraph(nodes: readonly MdInline[]): AdfNode {
  return { type: 'paragraph', content: adfInline(nodes) };
}

function adfList(list: MdList): AdfNode {
  return {
    type: list.ordered ? 'orderedList' : 'bulletList',
    content: list.items.map((item) => ({
      type: 'listItem',
      // A list item must start with a paragraph, even an empty one, before any nested list.
      content: [paragraph(item.content), ...item.children.map((child) => adfList(child))],
    })),
  };
}

type Mark = { readonly type: string; readonly attrs?: Readonly<Record<string, unknown>> };

/** Flattens nested inline formatting into text nodes carrying marks, which is ADF's model. */
function adfInline(nodes: readonly MdInline[], marks: readonly Mark[] = []): AdfNode[] {
  const out: AdfNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        if (node.text !== '') out.push(textNode(node.text, marks));
        break;
      case 'code':
        // Cloud only lets `code` combine with `link`; any other mark around a code span is dropped
        // rather than sending a document the validator rejects.
        out.push(textNode(node.text, [...marks.filter((mark) => mark.type === 'link'), { type: 'code' }]));
        break;
      case 'link':
        out.push(...adfInline(node.children, [...marks, { type: 'link', attrs: { href: node.href } }]));
        break;
      case 'strong':
        out.push(...adfInline(node.children, [...marks, { type: 'strong' }]));
        break;
      case 'em':
        out.push(...adfInline(node.children, [...marks, { type: 'em' }]));
        break;
      case 'break':
        out.push({ type: 'hardBreak' });
        break;
    }
  }
  return out;
}

function textNode(text: string, marks: readonly Mark[]): AdfNode {
  return marks.length === 0 ? { type: 'text', text } : { type: 'text', text, marks: [...marks] };
}

// --- ADF → Markdown ---

/** Markdown read from a rich-text value, plus what could not be carried across. */
export interface MarkdownReading {
  readonly markdown: string;
  /** One phrase per kind of content Markdown could not express, such as "a mention". Empty when lossless. */
  readonly lossy: string[];
}

/**
 * Reads an ADF document as Markdown.
 *
 * Never throws on content a server chose. Anything outside the Markdown subset — mentions,
 * panels, media, status lozenges — is rendered as its nearest text and named in `lossy`, so a
 * caller that is about to overwrite the field knows what saving it back would lose.
 */
export function adfToMarkdown(document: unknown): MarkdownReading {
  const lossy = new Set<string>();
  const reader = new AdfReader(lossy);
  const content = isNode(document) ? (document.content ?? []) : [];
  const markdown = renderMarkdown(reader.blocks(content), lossy);
  return { markdown, lossy: [...lossy].sort() };
}

function isNode(value: unknown): value is AdfNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

const KNOWN_MARKS = new Set(['strong', 'em', 'code', 'link']);

/** ADF block types that only wrap other blocks, with what their loss is called. */
const WRAPPERS: Readonly<Record<string, string>> = {
  panel: 'a panel',
  expand: 'an expand section',
  nestedExpand: 'an expand section',
  layoutSection: 'a column layout',
  layoutColumn: 'a column layout',
  bodiedExtension: 'a macro',
};

class AdfReader {
  public constructor(private readonly lossy: Set<string>) {}

  public blocks(nodes: readonly unknown[]): MdBlock[] {
    return nodes.flatMap((node) => (isNode(node) ? this.block(node) : []));
  }

  private block(node: AdfNode): MdBlock[] {
    const children = node.content ?? [];
    switch (node.type) {
      case 'paragraph':
        return [{ type: 'paragraph', children: this.inline(children) }];
      case 'heading': {
        const level = typeof node.attrs?.level === 'number' ? Math.min(Math.max(node.attrs.level, 1), 6) : 1;
        return [{ type: 'heading', level, children: this.inline(children) }];
      }
      case 'codeBlock': {
        const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
        return [{ type: 'code', language: /^[\w+-]*$/.test(language) ? language : '', text: plainText(children) }];
      }
      case 'rule':
        return [{ type: 'rule' }];
      case 'blockquote':
        return [{ type: 'quote', children: this.blocks(children) }];
      case 'bulletList':
      case 'orderedList':
        return [this.list(node)];
      case 'table':
        return this.table(node);
      default:
        return this.unsupportedBlock(node);
    }
  }

  /** Blocks Markdown has no form for: kept as their nearest equivalent, and named. */
  private unsupportedBlock(node: AdfNode): MdBlock[] {
    switch (node.type) {
      case 'taskList':
      case 'decisionList':
        this.lossy.add(node.type === 'taskList' ? 'a task list' : 'a decision list');
        return [this.list(node)];
      case 'mediaSingle':
      case 'mediaGroup':
        this.lossy.add('an attachment or image');
        return [{ type: 'paragraph', children: [{ type: 'text', text: '[attachment]' }] }];
      default:
        this.lossy.add(WRAPPERS[node.type] ?? `a "${node.type}" block`);
        return this.blocks(node.content ?? []);
    }
  }

  private list(node: AdfNode): MdList {
    const items = (node.content ?? []).filter(isNode).map((item) => {
      const inline: MdInline[] = [];
      const children: MdList[] = [];
      for (const part of item.content ?? []) {
        if (!isNode(part)) continue;
        if (['bulletList', 'orderedList', 'taskList', 'decisionList'].includes(part.type)) {
          children.push(...(this.block(part) as MdList[]));
        } else if (part.type === 'paragraph' || part.type === 'text' || isInlineType(part.type)) {
          if (inline.length > 0) {
            this.lossy.add('more than one paragraph in a list item');
            inline.push({ type: 'text', text: ' ' });
          }
          inline.push(...this.inline(part.type === 'paragraph' ? (part.content ?? []) : [part]));
        } else {
          this.lossy.add('a block inside a list item');
          inline.push({ type: 'text', text: plainText(part.content ?? []) });
        }
      }
      return { content: inline, children };
    });
    return { type: 'list', ordered: node.type === 'orderedList', items };
  }

  private table(node: AdfNode): MdBlock[] {
    const rows = (node.content ?? []).filter(isNode).map((row) =>
      (row.content ?? []).filter(isNode).map((cell) => {
        if (typeof cell.attrs?.colspan === 'number' && cell.attrs.colspan > 1) this.lossy.add('a merged table cell');
        if (typeof cell.attrs?.rowspan === 'number' && cell.attrs.rowspan > 1) this.lossy.add('a merged table cell');
        return { header: cell.type === 'tableHeader', content: this.cell(cell.content ?? []) };
      }),
    );
    const [first, ...rest] = rows;
    if (first === undefined) return [];
    // Markdown tables always have a header row. When the document's first row is not one, an
    // empty header keeps every data row a data row.
    const headed = first.every((cell) => cell.header);
    if (!headed) this.lossy.add('a table without a header row');
    const header = headed ? first.map((cell) => cell.content) : first.map(() => []);
    const body = (headed ? rest : rows).map((row) => row.map((cell) => cell.content));
    return [{ type: 'table', header, rows: body }];
  }

  private cell(blocks: readonly AdfNode[]): MdInline[] {
    const out: MdInline[] = [];
    for (const block of blocks.filter(isNode)) {
      if (out.length > 0) {
        this.lossy.add('more than one paragraph in a table cell');
        out.push({ type: 'text', text: ' ' });
      }
      if (block.type === 'paragraph') out.push(...this.inline(block.content ?? []));
      else {
        this.lossy.add('a block inside a table cell');
        out.push({ type: 'text', text: plainText(block.content ?? []) });
      }
    }
    return out;
  }

  private inline(nodes: readonly unknown[]): MdInline[] {
    const out: MdInline[] = [];
    for (const node of nodes) {
      if (!isNode(node)) continue;
      out.push(...this.inlineNode(node));
    }
    return out;
  }

  private inlineNode(node: AdfNode): MdInline[] {
    switch (node.type) {
      case 'text':
        return [this.marked(node.text ?? '', node.marks ?? [])];
      case 'hardBreak':
        return [{ type: 'break' }];
      case 'mention': {
        this.lossy.add('a mention');
        const text = typeof node.attrs?.text === 'string' ? node.attrs.text : '@user';
        return [{ type: 'text', text: text.startsWith('@') ? text : `@${text}` }];
      }
      case 'emoji':
        this.lossy.add('an emoji');
        return [{ type: 'text', text: stringAttr(node, 'text') ?? stringAttr(node, 'shortName') ?? '' }];
      case 'inlineCard':
      case 'blockCard': {
        this.lossy.add('a smart link');
        const url = stringAttr(node, 'url');
        return url === undefined ? [] : [{ type: 'link', href: url, children: [{ type: 'text', text: url }] }];
      }
      case 'date': {
        this.lossy.add('a date');
        const timestamp = Number(stringAttr(node, 'timestamp'));
        return [
          { type: 'text', text: Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : '' },
        ];
      }
      case 'status':
        this.lossy.add('a status lozenge');
        return [{ type: 'text', text: stringAttr(node, 'text') ?? '' }];
      default:
        this.lossy.add(`an inline "${node.type}"`);
        return [{ type: 'text', text: plainText(node.content ?? []) }];
    }
  }

  /** Rebuilds the nesting Markdown needs from ADF's flat list of marks on one text node. */
  private marked(text: string, marks: AdfNode['marks'] & object): MdInline {
    let node: MdInline = { type: 'text', text };
    const known = marks.filter((mark) => KNOWN_MARKS.has(mark.type));
    if (known.length < marks.length) this.lossy.add('text formatting other than bold, italic, code and links');
    if (known.some((mark) => mark.type === 'code')) node = { type: 'code', text };
    for (const mark of known) {
      if (mark.type === 'strong') node = { type: 'strong', children: [node] };
      if (mark.type === 'em') node = { type: 'em', children: [node] };
    }
    const link = known.find((mark) => mark.type === 'link');
    const href = typeof link?.attrs?.href === 'string' ? link.attrs.href : undefined;
    if (href !== undefined) node = { type: 'link', href, children: [node] };
    return node;
  }
}

function isInlineType(type: string): boolean {
  return ['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'date', 'status'].includes(type);
}

function stringAttr(node: AdfNode, name: string): string | undefined {
  const value = node.attrs?.[name];
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : undefined;
}

/** The visible text of a subtree, for content Markdown has no structure for. */
function plainText(nodes: readonly unknown[]): string {
  return nodes
    .map((node) => {
      if (!isNode(node)) return '';
      if (node.type === 'text') return node.text ?? '';
      if (node.type === 'hardBreak') return '\n';
      return plainText(node.content ?? []);
    })
    .join('');
}
