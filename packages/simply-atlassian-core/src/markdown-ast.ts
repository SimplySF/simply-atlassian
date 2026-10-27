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

import { ConfigError } from './errors.js';
import { stripControl } from './text.js';

/**
 * Parses the documented Markdown subset into a tree that each output format renders on its own.
 *
 * One parser, several emitters: Confluence storage (`markdown-storage.ts`), Jira Cloud's ADF
 * (`markdown-adf.ts`) and Jira Server/DC wiki markup (`markdown-wiki.ts`). The rules that matter
 * live here, once, so the formats cannot disagree about what a document says:
 *
 * **Anything not translatable is an error, never a silent drop.** A dropped construct means the
 * command reports success with a section missing, and nobody re-reads what they just published.
 *
 * **Link targets are checked here**, so no output format can carry a `javascript:` href or a
 * protocol-relative link that reads as internal.
 *
 * Text is kept raw in the tree; escaping belongs to each emitter, because what needs escaping is
 * different in XHTML, JSON and wiki markup.
 *
 * See designs 0013 and 0020.
 */

export type MdInline =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'link'; readonly href: string; readonly children: readonly MdInline[] }
  | { readonly type: 'strong'; readonly children: readonly MdInline[] }
  | { readonly type: 'em'; readonly children: readonly MdInline[] }
  | { readonly type: 'break' };

export interface MdListItem {
  readonly content: readonly MdInline[];
  /** Lists nested under this item, in order. */
  readonly children: readonly MdList[];
}

export interface MdList {
  readonly type: 'list';
  readonly ordered: boolean;
  readonly items: readonly MdListItem[];
}

export type MdBlock =
  | { readonly type: 'heading'; readonly level: number; readonly children: readonly MdInline[] }
  | { readonly type: 'paragraph'; readonly children: readonly MdInline[] }
  | { readonly type: 'code'; readonly language: string; readonly text: string }
  | { readonly type: 'rule' }
  | { readonly type: 'quote'; readonly children: readonly MdBlock[] }
  | MdList
  | {
      readonly type: 'table';
      readonly header: ReadonlyArray<readonly MdInline[]>;
      readonly rows: ReadonlyArray<ReadonlyArray<readonly MdInline[]>>;
    };

/**
 * Who the document is being converted for. Only the wording of refusals depends on it: the
 * escape hatch for a construct Markdown cannot express is a different flag for each.
 */
export type MarkdownTarget = 'confluence' | 'jira';

/** How deeply blocks may nest before the input is treated as pathological rather than clever. */
const MAX_DEPTH = 12;

/** URL schemes a link may use. Everything else is refused — see `linkHref`. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

interface Unsupported {
  readonly test: RegExp;
  readonly what: string;
  readonly hint: Readonly<Record<MarkdownTarget, string>>;
}

/**
 * Constructs this converter refuses, with the message the caller sees.
 *
 * Each is something a caller could reasonably write and would otherwise lose. The check is on the
 * raw line, so the error can name the line number.
 */
const UNSUPPORTED: readonly Unsupported[] = [
  {
    test: /^\s*!\[/,
    what: 'an image',
    hint: {
      confluence: 'attachments are not supported yet; link to the image instead',
      jira: 'attachments are not supported yet; link to the image instead',
    },
  },
  {
    test: /^\s*\[\^[^\]]+\]:/,
    what: 'a footnote definition',
    hint: { confluence: 'inline the note, or use a list', jira: 'inline the note, or use a list' },
  },
  {
    test: /^\s*\[[^\]]+\]:\s*\S+/,
    what: 'a reference-style link definition',
    hint: { confluence: 'use an inline [text](url) link', jira: 'use an inline [text](url) link' },
  },
  {
    test: /^\s*<[a-zA-Z!/]/,
    what: 'raw HTML',
    hint: {
      confluence: 'use --body to send storage format directly',
      jira: 'Jira fields take no HTML; write it as Markdown',
    },
  },
  {
    test: /^\s*[-*+]\s+\[[ xX]\]/,
    what: 'a task list',
    hint: {
      confluence: 'Confluence tasks have no Markdown form; use --body',
      jira: 'use a plain list, or a numbered list of criteria',
    },
  },
  {
    test: /^\s*(=+|-{3,}=)\s*$/,
    what: 'a setext heading',
    hint: { confluence: 'use # or ## instead', jira: 'use # or ## instead' },
  },
];

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```\s*([\w+-]*)\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_DIVIDER = /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/;

/** Parses Markdown into blocks, refusing anything the documented subset cannot express. */
export function parseMarkdown(markdown: string, target: MarkdownTarget = 'confluence'): MdBlock[] {
  // Control and invisible characters are removed on the way in for the same reason they are
  // removed on the way out: this library should not be the thing that puts them into stored content.
  const lines = stripControl(markdown).replaceAll('\r\n', '\n').split('\n');
  return new Parser(target).blocks(lines, 0, 1);
}

/** What a block handler consumed, and the block it produced. */
interface Consumed {
  readonly block: MdBlock;
  readonly next: number;
}

type BlockHandler = (lines: readonly string[], i: number, depth: number, lineOffset: number) => Consumed | undefined;

class Parser {
  /**
   * One handler per block type, tried in order.
   *
   * Order is load-bearing in two places. A fence comes first, because its contents are literal
   * and a `# comment` inside a shell snippet must not become a heading. A rule comes before a
   * list, because `---` matches neither well and the rule reading is the one people mean.
   */
  private readonly handlers: readonly BlockHandler[] = [
    (lines, i, _depth, lineOffset): Consumed | undefined => fenceBlock(lines, i, lineOffset),
    (lines, i): Consumed | undefined =>
      RULE.test(lines[i] ?? '') ? { block: { type: 'rule' }, next: i + 1 } : undefined,
    (lines, i, _depth, lineOffset): Consumed | undefined => this.heading(lines, i, lineOffset),
    (lines, i, depth, lineOffset): Consumed | undefined => this.quote(lines, i, depth, lineOffset),
    (lines, i, _depth, lineOffset): Consumed | undefined => this.table(lines, i, lineOffset),
    (lines, i, depth, lineOffset): Consumed | undefined => this.listBlock(lines, i, depth, lineOffset),
  ];

  public constructor(private readonly target: MarkdownTarget) {}

  /** Parses a run of lines, recursing for nested structures. */
  public blocks(lines: readonly string[], depth: number, lineOffset: number): MdBlock[] {
    if (depth > MAX_DEPTH) {
      throw new ConfigError(
        `Markdown nested more than ${MAX_DEPTH} levels deep, which is deeper than any real document. ` + 'Flatten it.',
      );
    }

    const out: MdBlock[] = [];
    let i = 0;

    while (i < lines.length) {
      if ((lines[i] ?? '').trim() === '') {
        i += 1;
        continue;
      }

      const handled = this.runHandlers(lines, i, depth, lineOffset);
      if (handled !== undefined) {
        out.push(handled.block);
        i = handled.next;
        continue;
      }

      const paragraph = this.paragraph(lines, i, lineOffset);
      out.push(paragraph.block);
      i = paragraph.next;
    }

    return out;
  }

  private runHandlers(lines: readonly string[], i: number, depth: number, lineOffset: number): Consumed | undefined {
    for (const [index, handler] of this.handlers.entries()) {
      // A fence (the first handler) is checked before the unsupported-construct scan, since
      // anything inside it is literal — a `<div>` in an HTML example is not raw HTML input.
      if (index > 0) this.refuseUnsupported(lines[i] ?? '', lineOffset + i);
      const consumed = handler(lines, i, depth, lineOffset);
      if (consumed !== undefined) return consumed;
    }
    return undefined;
  }

  private refuseUnsupported(line: string, lineNumber: number): void {
    for (const { test, what, hint } of UNSUPPORTED) {
      if (test.test(line)) {
        throw new ConfigError(
          `Line ${lineNumber}: ${what} is not supported in Markdown input (${hint[this.target]}). ` +
            'Nothing was sent — unsupported Markdown is refused rather than dropped, so a document ' +
            'never silently loses a section.',
        );
      }
    }
  }

  private heading(lines: readonly string[], i: number, lineOffset: number): Consumed | undefined {
    const heading = HEADING.exec(lines[i] ?? '');
    if (heading === null) return undefined;
    const level = (heading[1] ?? '#').length;
    return {
      block: { type: 'heading', level, children: this.inline(heading[2] ?? '', lineOffset + i) },
      next: i + 1,
    };
  }

  private quote(lines: readonly string[], i: number, depth: number, lineOffset: number): Consumed | undefined {
    if (QUOTE.exec(lines[i] ?? '') === null) return undefined;

    const inner: string[] = [];
    let j = i;
    while (j < lines.length) {
      const q = QUOTE.exec(lines[j] ?? '');
      if (q === null) break;
      inner.push(q[1] ?? '');
      j += 1;
    }
    return { block: { type: 'quote', children: this.blocks(inner, depth + 1, lineOffset + i) }, next: j };
  }

  private table(lines: readonly string[], i: number, lineOffset: number): Consumed | undefined {
    // A table needs its divider row to be a table at all; without one it is text containing pipe
    // characters, which is far more common.
    if (!(lines[i] ?? '').includes('|') || !TABLE_DIVIDER.test(lines[i + 1] ?? '')) return undefined;

    const rows: string[] = [];
    let j = i;
    while (j < lines.length && (lines[j] ?? '').includes('|')) {
      rows.push(lines[j] ?? '');
      j += 1;
    }

    const cells = (row: string): string[] =>
      row
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
    const lineNumber = lineOffset + i;

    return {
      block: {
        type: 'table',
        header: cells(rows[0] ?? '').map((cell) => this.inline(cell, lineNumber)),
        // The divider row is consumed, not rendered.
        rows: rows.slice(2).map((row) => cells(row).map((cell) => this.inline(cell, lineNumber))),
      },
      next: j,
    };
  }

  private listBlock(lines: readonly string[], i: number, depth: number, lineOffset: number): Consumed | undefined {
    const line = lines[i] ?? '';
    if (!BULLET.test(line) && !NUMBERED.test(line)) return undefined;
    const { list, next } = this.list(lines, i, depth, lineOffset);
    return { block: list, next };
  }

  /**
   * Parses one list, including nested lists.
   *
   * Indentation decides nesting, and the *first* item's indentation sets the baseline rather than
   * assuming column zero — a list inside a blockquote or a deeper list starts indented.
   */
  private list(
    lines: readonly string[],
    start: number,
    depth: number,
    lineOffset: number,
  ): { list: MdList; next: number } {
    const first = BULLET.exec(lines[start] ?? '') ?? NUMBERED.exec(lines[start] ?? '');
    const baseIndent = (first?.[1] ?? '').length;
    const ordered = NUMBERED.test(lines[start] ?? '') && !BULLET.test(lines[start] ?? '');

    const items: Array<{ content: readonly MdInline[]; children: MdList[] }> = [];
    let i = start;

    while (i < lines.length) {
      const line = lines[i] ?? '';
      if (line.trim() === '') break;
      const match = BULLET.exec(line) ?? NUMBERED.exec(line);
      if (match === null) break;

      const indent = (match[1] ?? '').length;
      if (indent < baseIndent) break;

      if (indent > baseIndent) {
        // A nested list belongs inside the item above it, not as a sibling.
        const nested = this.list(lines, i, depth + 1, lineOffset);
        const last = items.at(-1);
        if (last === undefined) items.push({ content: [], children: [nested.list] });
        else last.children.push(nested.list);
        i = nested.next;
        continue;
      }

      this.refuseUnsupported(line, lineOffset + i);
      items.push({ content: this.inline(match[2] ?? '', lineOffset + i), children: [] });
      i += 1;
    }

    return { list: { type: 'list', ordered, items }, next: i };
  }

  /** Everything else: runs until a blank line or a line that starts some other block. */
  private paragraph(lines: readonly string[], i: number, lineOffset: number): Consumed {
    const collected: string[] = [];
    let j = i;

    while (j < lines.length) {
      const candidate = lines[j] ?? '';
      if (candidate.trim() === '') break;
      if (startsAnotherBlock(candidate)) break;
      this.refuseUnsupported(candidate, lineOffset + j);
      collected.push(candidate);
      j += 1;
    }

    // Lines are joined with a break, except where a line already ended in an explicit one — two
    // trailing spaces ask for a single break, not two.
    const children: MdInline[] = [];
    for (const [n, line] of collected.entries()) {
      const rendered = this.inline(line, lineOffset + i + n);
      children.push(...rendered);
      const last = n === collected.length - 1;
      if (!last && rendered.at(-1)?.type !== 'break') children.push({ type: 'break' });
    }
    return { block: { type: 'paragraph', children }, next: j };
  }

  /**
   * Parses inline markup by scanning rather than substituting.
   *
   * Regex substitution over the whole string cannot be made safe: a `**` inside a code span
   * would be turned into emphasis. Scanning handles each token where it starts, so a code span's
   * contents are never examined for other markup.
   */
  private inline(text: string, lineNumber: number): MdInline[] {
    const out: MdInline[] = [];
    let i = 0;
    let pending = '';
    const flush = (): void => {
      if (pending !== '') out.push({ type: 'text', text: pending });
      pending = '';
    };
    const push = (node: MdInline): void => {
      flush();
      out.push(node);
    };

    // A hard break is two trailing spaces; it is consumed here so the trim below cannot lose it.
    const hardBreak = /\s{2,}$/.test(text);
    const body = text.replace(/\s+$/, '');

    while (i < body.length) {
      const rest = body.slice(i);

      // A backslash escapes the next character, so a caller can write a literal `*` or `_`.
      // Without this there is no way to say "asterisk" in prose.
      if (rest.startsWith('\\') && rest.length > 1) {
        pending += rest[1] ?? '';
        i += 2;
        continue;
      }

      // Code spans first: their contents are literal.
      const code = /^`([^`]+)`/.exec(rest);
      if (code) {
        push({ type: 'code', text: code[1] ?? '' });
        i += code[0].length;
        continue;
      }

      // A link may carry a title — `[a](url "title")` — which is ordinary Markdown. Without
      // accepting it the whole link fell through and rendered as literal text.
      const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (link) {
        push({
          type: 'link',
          href: linkHref(link[2] ?? '', lineNumber),
          children: this.inline(link[1] ?? '', lineNumber),
        });
        i += link[0].length;
        continue;
      }

      // Bold-italic before bold, or `***x***` reads as `**` plus a stray asterisk.
      const both = /^(\*\*\*|___)([\s\S]+?)\1/.exec(rest);
      if (both) {
        push({ type: 'strong', children: [{ type: 'em', children: this.inline(both[2] ?? '', lineNumber) }] });
        i += both[0].length;
        continue;
      }

      const strong = /^(\*\*|__)(.+?)\1/.exec(rest);
      if (strong) {
        push({ type: 'strong', children: this.inline(strong[2] ?? '', lineNumber) });
        i += strong[0].length;
        continue;
      }

      // Underscore emphasis only outside a word. CommonMark's rule, and it matters here because
      // identifiers are ordinary prose in these documents: without it `snake_case_name` renders
      // as `snake` + italic `case` + `name`, and `__init__` becomes bold.
      const asterisk = /^\*([^*]+?)\*/.exec(rest);
      const underscore = /^_([^_]+?)_/.exec(rest);
      const emphasis = asterisk ?? (intraword(body, i, underscore) ? null : underscore);
      if (emphasis) {
        push({ type: 'em', children: this.inline(emphasis[1] ?? '', lineNumber) });
        i += emphasis[0].length;
        continue;
      }

      pending += body[i] ?? '';
      i += 1;
    }

    flush();
    if (hardBreak) out.push({ type: 'break' });
    return out;
  }
}

function fenceBlock(lines: readonly string[], i: number, lineOffset: number): Consumed | undefined {
  const fence = FENCE.exec(lines[i] ?? '');
  if (fence === null) return undefined;

  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length && !/^```\s*$/.test(lines[j] ?? '')) {
    body.push(lines[j] ?? '');
    j += 1;
  }
  if (j >= lines.length) throw new ConfigError(`Line ${lineOffset + i}: unclosed \`\`\` code fence.`);

  return { block: { type: 'code', language: fence[1] ?? '', text: body.join('\n') }, next: j + 1 };
}

function startsAnotherBlock(line: string): boolean {
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line)
  );
}

/**
 * Validates a link target and returns it trimmed, unescaped.
 *
 * The scheme check is the point: `[click me](javascript:…)` would otherwise put that href in a
 * document other people click, and stored content outlives the command that wrote it. Relative
 * paths are allowed because they resolve within the instance.
 */
function linkHref(url: string, lineNumber: number): string {
  const trimmed = url.trim();
  if (trimmed === '') throw new ConfigError(`Line ${lineNumber}: a link has an empty target.`);

  // `//host/path` is protocol-relative, not instance-relative: a browser resolves it against the
  // current scheme and lands on an external host. Allowing it would put a link that reads as
  // internal, in a document people trust, pointing anywhere. `\\host` is the same trick with
  // backslashes, which some clients normalise to `//`.
  if (/^[/\\]{2}/.test(trimmed)) {
    throw new ConfigError(
      `Line ${lineNumber}: the link target "${trimmed}" is protocol-relative, which resolves to ` +
        'another host rather than this instance. Write the full https:// URL if that is intended.',
    );
  }

  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;

  let scheme: string;
  try {
    scheme = new URL(trimmed).protocol;
  } catch {
    // No scheme at all — treat as relative, which the instance resolves against itself.
    if (!trimmed.includes(':')) return trimmed;
    throw new ConfigError(`Line ${lineNumber}: cannot read the link target "${trimmed}".`);
  }

  if (!SAFE_SCHEMES.has(scheme)) {
    throw new ConfigError(
      `Line ${lineNumber}: the link scheme "${scheme}" is not allowed. ` +
        'Only http, https and mailto links can be written, because the link stays there ' +
        'for everyone who opens it.',
    );
  }
  return trimmed;
}

/**
 * True when an underscore match sits inside a word, where CommonMark treats it as literal.
 *
 * The character before the opening `_` and after the closing one decide it: `a_b_c` is one word
 * and stays literal, while `_b_` and `(_b_)` are emphasis.
 */
function intraword(body: string, i: number, match: RegExpExecArray | null): boolean {
  if (match === null) return false;
  const before = i === 0 ? '' : (body[i - 1] ?? '');
  const after = body[i + match[0].length] ?? '';
  return /[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after);
}
