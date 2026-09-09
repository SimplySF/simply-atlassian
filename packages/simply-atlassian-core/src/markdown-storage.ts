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
 * Converts a documented subset of Markdown to Confluence storage format.
 *
 * Storage format is XHTML plus Atlassian's `ac:` macro tags. This exists because the caller this
 * CLI is built around — an agent — writes Markdown, and asking a model to emit
 * `<ac:structured-macro ac:schema-version="1">` correctly every time produces something *nearly*
 * right, which fails as a 400 rather than as anything recoverable.
 *
 * Two rules run through the whole file, and they are the reason it is a parser rather than a pile
 * of regular expressions:
 *
 * **Anything not translatable is an error, never a silent drop.** A dropped construct means the
 * command reports success with a section missing, and nobody re-reads a page they just published.
 * Widening the supported set later is safe; un-losing content is not.
 *
 * **Everything that reaches storage is escaped.** Storage is XHTML, so an unescaped `&` or `<`
 * from caller prose either breaks the body or is silently reinterpreted as markup. That also
 * means Markdown cannot be used to inject a macro: a caller who writes `<ac:structured-macro>`
 * gets those characters on the page.
 *
 * See design 0013.
 */
export function markdownToStorage(markdown: string): string {
  // Control and invisible characters are removed on the way in for the same reason they are
  // removed on the way out: this CLI should not be the thing that puts them into stored content.
  const lines = stripControl(markdown).replaceAll('\r\n', '\n').split('\n');
  return renderBlocks(lines, 0);
}

/** How deeply blocks may nest before the input is treated as pathological rather than clever. */
const MAX_DEPTH = 12;

/** URL schemes a link may use. Everything else is refused — see `linkHref`. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Constructs this converter refuses, with the message the caller sees.
 *
 * Each is something a caller could reasonably write and would otherwise lose. The check is on the
 * raw line, so the error can name the line number.
 */
const UNSUPPORTED: ReadonlyArray<{ readonly test: RegExp; readonly what: string; readonly hint: string }> = [
  { test: /^\s*!\[/, what: 'an image', hint: 'attachments are not supported yet; link to the image instead' },
  { test: /^\s*\[\^[^\]]+\]:/, what: 'a footnote definition', hint: 'inline the note, or use a list' },
  { test: /^\s*\[[^\]]+\]:\s*\S+/, what: 'a reference-style link definition', hint: 'use an inline [text](url) link' },
  { test: /^\s*<[a-zA-Z!/]/, what: 'raw HTML', hint: 'use --body to send storage format directly' },
  { test: /^\s*[-*+]\s+\[[ xX]\]/, what: 'a task list', hint: 'Confluence tasks have no Markdown form; use --body' },
  { test: /^\s*(=+|-{3,}=)\s*$/, what: 'a setext heading', hint: 'use # or ## instead' },
];

function refuseUnsupported(line: string, lineNumber: number): void {
  for (const { test, what, hint } of UNSUPPORTED) {
    if (test.test(line)) {
      throw new ConfigError(
        `Line ${lineNumber}: ${what} is not supported in Markdown input (${hint}). ` +
          'Nothing was sent — unsupported Markdown is refused rather than dropped, so a page ' +
          'never silently loses a section.',
      );
    }
  }
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```\s*([\w+-]*)\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_DIVIDER = /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/;

/** What a block handler consumed, and the storage it produced. */
interface Consumed {
  readonly storage: string;
  readonly next: number;
}

/**
 * One handler per block type, tried in order.
 *
 * Order is load-bearing in two places. A fence comes first, because its contents are literal and
 * a `# comment` inside a shell snippet must not become a heading. A rule comes before a list,
 * because `---` matches neither well and the rule reading is the one people mean.
 *
 * Table-driven rather than one long branch, matching `storage-markdown.ts` — and because the
 * repo's complexity limit is a reasonable proxy for "this function does too many things".
 */
type BlockHandler = (lines: readonly string[], i: number, depth: number, lineOffset: number) => Consumed | undefined;

const BLOCK_HANDLERS: readonly BlockHandler[] = [
  fenceBlock,
  ruleBlock,
  headingBlock,
  quoteBlock,
  tableBlock,
  listBlock,
];

/** Renders a run of lines into storage, recursing for nested structures. */
function renderBlocks(lines: readonly string[], depth: number, lineOffset = 1): string {
  if (depth > MAX_DEPTH) {
    throw new ConfigError(
      `Markdown nested more than ${MAX_DEPTH} levels deep, which is deeper than any real document. ` +
        'Flatten it, or send storage format with --body.',
    );
  }

  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if ((lines[i] ?? '').trim() === '') {
      i += 1;
      continue;
    }

    const handled = runHandlers(lines, i, depth, lineOffset);
    if (handled !== undefined) {
      out.push(handled.storage);
      i = handled.next;
      continue;
    }

    const paragraph = paragraphBlock(lines, i, lineOffset);
    out.push(paragraph.storage);
    i = paragraph.next;
  }

  return out.join('');
}

function runHandlers(lines: readonly string[], i: number, depth: number, lineOffset: number): Consumed | undefined {
  for (const handler of BLOCK_HANDLERS) {
    // A fence is checked before the unsupported-construct scan, since anything inside it is
    // literal — a `<div>` in an HTML example is not raw HTML input.
    if (handler !== fenceBlock) refuseUnsupported(lines[i] ?? '', lineOffset + i);
    const consumed = handler(lines, i, depth, lineOffset);
    if (consumed !== undefined) return consumed;
  }
  return undefined;
}

function fenceBlock(lines: readonly string[], i: number, _depth: number, lineOffset: number): Consumed | undefined {
  const fence = FENCE.exec(lines[i] ?? '');
  if (fence === null) return undefined;

  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length && !/^```\s*$/.test(lines[j] ?? '')) {
    body.push(lines[j] ?? '');
    j += 1;
  }
  if (j >= lines.length) throw new ConfigError(`Line ${lineOffset + i}: unclosed \`\`\` code fence.`);

  return { storage: codeMacro(body.join('\n'), fence[1] ?? ''), next: j + 1 };
}

function ruleBlock(lines: readonly string[], i: number): Consumed | undefined {
  return RULE.test(lines[i] ?? '') ? { storage: '<hr />', next: i + 1 } : undefined;
}

function headingBlock(lines: readonly string[], i: number, _depth: number, lineOffset: number): Consumed | undefined {
  const heading = HEADING.exec(lines[i] ?? '');
  if (heading === null) return undefined;
  const level = (heading[1] ?? '#').length;
  return { storage: `<h${level}>${inline(heading[2] ?? '', lineOffset + i)}</h${level}>`, next: i + 1 };
}

function quoteBlock(lines: readonly string[], i: number, depth: number, lineOffset: number): Consumed | undefined {
  if (QUOTE.exec(lines[i] ?? '') === null) return undefined;

  const inner: string[] = [];
  let j = i;
  while (j < lines.length) {
    const q = QUOTE.exec(lines[j] ?? '');
    if (q === null) break;
    inner.push(q[1] ?? '');
    j += 1;
  }
  return { storage: `<blockquote>${renderBlocks(inner, depth + 1, lineOffset + i)}</blockquote>`, next: j };
}

function tableBlock(lines: readonly string[], i: number, _depth: number, lineOffset: number): Consumed | undefined {
  // A table needs its divider row to be a table at all; without one it is text containing pipe
  // characters, which is far more common.
  if (!(lines[i] ?? '').includes('|') || !TABLE_DIVIDER.test(lines[i + 1] ?? '')) return undefined;

  const rows: string[] = [];
  let j = i;
  while (j < lines.length && (lines[j] ?? '').includes('|')) {
    rows.push(lines[j] ?? '');
    j += 1;
  }
  return { storage: table(rows, lineOffset + i), next: j };
}

function listBlock(lines: readonly string[], i: number, depth: number, lineOffset: number): Consumed | undefined {
  const line = lines[i] ?? '';
  if (!BULLET.test(line) && !NUMBERED.test(line)) return undefined;
  return list(lines, i, depth, lineOffset);
}

/** Everything else: runs until a blank line or a line that starts some other block. */
function paragraphBlock(lines: readonly string[], i: number, lineOffset: number): Consumed {
  const collected: string[] = [];
  let j = i;

  while (j < lines.length) {
    const candidate = lines[j] ?? '';
    if (candidate.trim() === '') break;
    if (startsAnotherBlock(candidate)) break;
    refuseUnsupported(candidate, lineOffset + j);
    collected.push(candidate);
    j += 1;
  }

  // Joined with a break, except where the line already ended in an explicit one — two trailing
  // spaces asks for a single break, not two.
  const rendered = collected.map((l, n) => inline(l, lineOffset + i + n));
  const joined = rendered
    .map((html, n) => (n === rendered.length - 1 || html.endsWith('<br />') ? html : `${html}<br />`))
    .join('');
  return { storage: `<p>${joined}</p>`, next: j };
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
 * Renders one list, including nested lists.
 *
 * Indentation decides nesting, and the *first* item's indentation sets the baseline rather than
 * assuming column zero — a list inside a blockquote or a deeper list starts indented.
 */
function list(
  lines: readonly string[],
  start: number,
  depth: number,
  lineOffset: number,
): { storage: string; next: number } {
  const first = BULLET.exec(lines[start] ?? '') ?? NUMBERED.exec(lines[start] ?? '');
  const baseIndent = (first?.[1] ?? '').length;
  const ordered = NUMBERED.test(lines[start] ?? '') && !BULLET.test(lines[start] ?? '');
  const tag = ordered ? 'ol' : 'ul';

  const items: string[] = [];
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
      const nested = list(lines, i, depth + 1, lineOffset);
      const last = items.pop() ?? '<li></li>';
      items.push(last.replace(/<\/li>$/, `${nested.storage}</li>`));
      i = nested.next;
      continue;
    }

    refuseUnsupported(line, lineOffset + i);
    items.push(`<li><p>${inline(match[2] ?? '', lineOffset + i)}</p></li>`);
    i += 1;
  }

  return { storage: `<${tag}>${items.join('')}</${tag}>`, next: i };
}

/** Renders a GFM pipe table. The divider row is consumed, not rendered. */
function table(rows: readonly string[], lineNumber: number): string {
  const cells = (row: string): string[] =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());

  const header = cells(rows[0] ?? '');
  const body = rows.slice(2).map((row) => cells(row));

  const headerRow = `<tr>${header.map((c) => `<th><p>${inline(c, lineNumber)}</p></th>`).join('')}</tr>`;
  const bodyRows = body
    .map((row) => `<tr>${row.map((c) => `<td><p>${inline(c, lineNumber)}</p></td>`).join('')}</tr>`)
    .join('');

  return `<table><tbody>${headerRow}${bodyRows}</tbody></table>`;
}

/**
 * Wraps a fenced code block in Confluence's code macro.
 *
 * The body goes in CDATA, which is why it is *not* XML-escaped — and why a body containing the
 * CDATA terminator has to be split across two sections. Without that, `]]>` inside a snippet
 * closes the section early and the rest of the code becomes markup.
 */
function codeMacro(body: string, language: string): string {
  const safe = body.replaceAll(']]>', ']]]]><![CDATA[>');
  const parameter = language === '' ? '' : `<ac:parameter ac:name="language">${escapeXml(language)}</ac:parameter>`;
  return (
    '<ac:structured-macro ac:name="code" ac:schema-version="1">' +
    `${parameter}<ac:plain-text-body><![CDATA[${safe}]]></ac:plain-text-body>` +
    '</ac:structured-macro>'
  );
}

/**
 * Renders inline markup by scanning rather than substituting.
 *
 * Regex substitution over the whole string cannot be made safe here: a `**` inside a code span
 * would be turned into `<strong>`, and escaping before or after substitution mangles one or the
 * other. Scanning handles each token where it starts, so a code span's contents are never
 * examined for other markup.
 */
function inline(text: string, lineNumber: number): string {
  const out: string[] = [];
  let i = 0;

  // A hard break is two trailing spaces; it is consumed here so the trim below cannot lose it.
  const hardBreak = /\s{2,}$/.test(text);
  const body = text.replace(/\s+$/, '');

  while (i < body.length) {
    const rest = body.slice(i);

    // A backslash escapes the next character, so a caller can write a literal `*` or `_`.
    // Without this there is no way to say "asterisk" in prose.
    if (rest.startsWith('\\') && rest.length > 1) {
      out.push(escapeXml(rest[1] ?? ''));
      i += 2;
      continue;
    }

    // Code spans first: their contents are literal.
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      out.push(`<code>${escapeXml(code[1] ?? '')}</code>`);
      i += code[0].length;
      continue;
    }

    // A link may carry a title — `[a](url "title")` — which is ordinary Markdown. Without
    // accepting it the whole link fell through and rendered as literal text.
    const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      out.push(`<a href="${linkHref(link[2] ?? '', lineNumber)}">${inline(link[1] ?? '', lineNumber)}</a>`);
      i += link[0].length;
      continue;
    }

    // Bold-italic before bold, or `***x***` reads as `**` plus a stray asterisk.
    const both = /^(\*\*\*|___)([\s\S]+?)\1/.exec(rest);
    if (both) {
      out.push(`<strong><em>${inline(both[2] ?? '', lineNumber)}</em></strong>`);
      i += both[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (strong) {
      out.push(`<strong>${inline(strong[2] ?? '', lineNumber)}</strong>`);
      i += strong[0].length;
      continue;
    }

    // Underscore emphasis only outside a word. CommonMark's rule, and it matters here because
    // identifiers are ordinary prose in this tool's documents: without it `snake_case_name`
    // renders as `snake` + italic `case` + `name`, and `__init__` becomes bold.
    const asterisk = /^\*([^*]+?)\*/.exec(rest);
    const underscore = /^_([^_]+?)_/.exec(rest);
    const emphasis = asterisk ?? (intraword(body, i, underscore) ? null : underscore);
    if (emphasis) {
      out.push(`<em>${inline(emphasis[1] ?? '', lineNumber)}</em>`);
      i += emphasis[0].length;
      continue;
    }

    out.push(escapeXml(body[i] ?? ''));
    i += 1;
  }

  return out.join('') + (hardBreak ? '<br />' : '');
}

/**
 * Validates and escapes a link target.
 *
 * The scheme check is the point: `[click me](javascript:…)` would otherwise put that href on a
 * page other people click, and stored content outlives the command that wrote it. Relative paths
 * are allowed because they resolve within the instance.
 */
function linkHref(url: string, lineNumber: number): string {
  const trimmed = url.trim();
  if (trimmed === '') throw new ConfigError(`Line ${lineNumber}: a link has an empty target.`);

  // `//host/path` is protocol-relative, not instance-relative: a browser resolves it against the
  // current scheme and lands on an external host. Allowing it would put a link that reads as
  // internal, on a page people trust, pointing anywhere. `\\host` is the same trick with
  // backslashes, which some clients normalise to `//`.
  if (/^[/\\]{2}/.test(trimmed)) {
    throw new ConfigError(
      `Line ${lineNumber}: the link target "${trimmed}" is protocol-relative, which resolves to ` +
        'another host rather than this instance. Write the full https:// URL if that is intended.',
    );
  }

  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return escapeXml(trimmed);

  let scheme: string;
  try {
    scheme = new URL(trimmed).protocol;
  } catch {
    // No scheme at all — treat as relative, which Confluence resolves against the instance.
    if (!trimmed.includes(':')) return escapeXml(trimmed);
    throw new ConfigError(`Line ${lineNumber}: cannot read the link target "${trimmed}".`);
  }

  if (!SAFE_SCHEMES.has(scheme)) {
    throw new ConfigError(
      `Line ${lineNumber}: the link scheme "${scheme}" is not allowed. ` +
        'Only http, https and mailto links can be written to a page, because the link stays there ' +
        'for everyone who opens it.',
    );
  }
  return escapeXml(trimmed);
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

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
