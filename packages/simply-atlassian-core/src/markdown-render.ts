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

import type { MdBlock, MdInline, MdList } from './markdown-ast.js';

/**
 * Writes a Markdown tree back out as Markdown that `parseMarkdown` reads to the same tree.
 *
 * This is the other half of every reverse conversion — ADF and wiki markup are read into the tree
 * and written out here — so an agent that reads a field and saves it unchanged sends exactly what
 * was there. That property is what makes "read, edit, save" safe, and the tests pin it.
 *
 * Where the tree holds something this Markdown subset cannot say (a pipe inside a table cell, a
 * line break inside a heading), the nearest faithful form is written and the loss is recorded in
 * `lossy`, so the caller can say so rather than quietly change the document.
 */
export function renderMarkdown(blocks: readonly MdBlock[], lossy: Set<string> = new Set()): string {
  return new Writer(lossy).blocks(blocks);
}

class Writer {
  public constructor(private readonly lossy: Set<string>) {}

  public blocks(blocks: readonly MdBlock[]): string {
    return blocks
      .map((block) => this.block(block))
      .filter((text) => text !== '')
      .join('\n\n');
  }

  private block(block: MdBlock): string {
    switch (block.type) {
      case 'heading':
        return `${'#'.repeat(block.level)} ${this.oneLine(block.children, 'a line break inside a heading')}`;
      case 'paragraph':
        return this.paragraph(block.children);
      case 'code':
        return this.code(block.language, block.text);
      case 'rule':
        return '---';
      case 'quote':
        return this.blocks(block.children)
          .split('\n')
          .map((line) => (line === '' ? '>' : `> ${line}`))
          .join('\n');
      case 'list':
        return this.list(block, 0);
      case 'table':
        return this.table(block.header, block.rows);
    }
  }

  /** A paragraph's breaks become line ends, which is how the parser reads them back. */
  private paragraph(nodes: readonly MdInline[]): string {
    const lines: string[] = [];
    let current: MdInline[] = [];
    for (const node of nodes) {
      if (node.type === 'break') {
        lines.push(this.inline(current, true).trimEnd());
        current = [];
      } else {
        current.push(node);
      }
    }
    // Trailing spaces are trimmed because the parser reads two of them as a break.
    lines.push(this.inline(current, true).trimEnd());
    // A trailing break has no line after it to end; the parser's form for it is two spaces.
    const trailing = nodes.at(-1)?.type === 'break';
    const kept = lines.filter((line, index) => line !== '' || index === lines.length - 1);
    if (trailing) kept.pop();
    const text = kept.join('\n');
    return trailing ? `${text}  ` : text;
  }

  private code(language: string, text: string): string {
    if (/^```\s*$/m.test(text)) this.lossy.add('a code block containing a ``` line');
    // The fence is the parser's only code-block form, so a body line that is itself a fence would
    // end the block early; indenting it by one space keeps every other line exact.
    const body = text.replaceAll(/^```(\s*)$/gm, ' ```$1');
    return `\`\`\`${language}\n${body}\n\`\`\``;
  }

  private list(list: MdList, indent: number): string {
    const pad = ' '.repeat(indent);
    const lines: string[] = [];
    for (const [index, item] of list.items.entries()) {
      const marker = list.ordered ? `${index + 1}.` : '-';
      const text = this.inline(item.content, true, 'a line break inside a list item');
      lines.push(`${pad}${marker} ${text}`.trimEnd() + (text === '' ? ' ' : ''));
      for (const child of item.children) lines.push(this.list(child, indent + marker.length + 1));
    }
    return lines.join('\n');
  }

  private table(
    header: ReadonlyArray<readonly MdInline[]>,
    rows: ReadonlyArray<ReadonlyArray<readonly MdInline[]>>,
  ): string {
    const width = Math.max(header.length, ...rows.map((row) => row.length), 1);
    const cell = (nodes: readonly MdInline[] | undefined): string => {
      const text = this.oneLine(nodes ?? [], 'a line break inside a table cell');
      if (text.includes('|')) this.lossy.add('a | character inside a table cell');
      // The parser splits cells on every pipe, escaped or not, so a pipe in a cell cannot be
      // written at all. A visually similar character keeps the content legible.
      return text.replaceAll('|', '¦');
    };
    const row = (cells: ReadonlyArray<readonly MdInline[]>): string =>
      `| ${Array.from({ length: width }, (_, i) => cell(cells[i])).join(' | ')} |`;
    return [row(header), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.map(row)].join('\n');
  }

  /** Inline content that must stay on one line; a break becomes a space and is recorded. */
  private oneLine(nodes: readonly MdInline[], what: string): string {
    return this.inline(nodes, false, what);
  }

  /**
   * Writes inline nodes. `lineStart` says the text begins a line, where characters that would
   * start a block (`#`, `>`, `- `, `1. `) have to be escaped to stay text.
   */
  private inline(nodes: readonly MdInline[], lineStart: boolean, breakLoss?: string): string {
    let out = '';
    for (const node of nodes) out += this.node(node, lineStart && out === '', breakLoss);
    return out;
  }

  private node(node: MdInline, lineStart: boolean, breakLoss?: string): string {
    switch (node.type) {
      case 'text':
        return escapeText(node.text, lineStart);
      case 'code':
        if (node.text.includes('`')) {
          this.lossy.add('a backtick inside inline code');
          return escapeText(node.text, lineStart);
        }
        return `\`${node.text}\``;
      case 'link':
        return `[${this.inline(node.children, false, breakLoss)}](${linkTarget(node.href)})`;
      case 'strong': {
        const inner = this.inline(node.children, false, breakLoss);
        return inner === '' ? '' : `**${inner}**`;
      }
      case 'em': {
        const inner = this.inline(node.children, false, breakLoss);
        return inner === '' ? '' : `*${inner}*`;
      }
      case 'break':
        if (breakLoss !== undefined) this.lossy.add(breakLoss);
        return ' ';
    }
  }
}

/** The parser reads a link target up to the first `)` or space, so both are percent-encoded. */
function linkTarget(href: string): string {
  return href.replaceAll(' ', '%20').replaceAll(')', '%29');
}

/**
 * Escapes text so the parser reads it back as the same text.
 *
 * Emphasis and code markers are always escaped. Underscores only at a word boundary, since the
 * parser treats one inside a word as literal and `snake\_case` is noise to a reader. A `[` only
 * where it could open a link. At the start of a line, anything that would begin a block.
 */
function escapeText(raw: string, lineStart: boolean): string {
  // A newline inside a text node would end the line it is on; the tree's break node is the only
  // line break the parser can read back.
  const text = raw.replaceAll(/\s*\n\s*/g, ' ');
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    const before = i === 0 ? '' : (text[i - 1] ?? '');
    const after = text[i + 1] ?? '';
    if (char === '\\' || char === '*' || char === '`') out += `\\${char}`;
    else if (char === '_' && !(/[A-Za-z0-9]/.test(before) && /[A-Za-z0-9]/.test(after))) out += '\\_';
    else if (char === '[' && (text.slice(i).includes('](') || (lineStart && i === 0))) out += '\\[';
    else out += char;
  }
  return lineStart ? escapeLineStart(out) : out;
}

/** Block starters that would turn a line of text into a heading, quote, list, rule or refusal. */
function escapeLineStart(text: string): string {
  const leading = /^\s*/.exec(text)?.[0] ?? '';
  const rest = text.slice(leading.length);
  const starts =
    /^#{1,6}(\s|$)/.test(rest) ||
    rest.startsWith('>') ||
    /^[-+](\s|$)/.test(rest) ||
    /^-{3,}\s*$/.test(rest) ||
    /^=+\s*$/.test(rest) ||
    /^<[a-zA-Z!/]/.test(rest) ||
    rest.startsWith('![') ||
    rest.startsWith('|');
  if (starts) return `${leading}\\${rest}`;
  const numbered = /^(\d+)([.)])(\s|$)/.exec(rest);
  if (numbered) return `${leading}${numbered[1] ?? ''}\\${rest.slice((numbered[1] ?? '').length)}`;
  return text;
}
