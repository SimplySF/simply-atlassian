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

/**
 * Converts a documented subset of Markdown to Confluence storage format.
 *
 * Storage format is XHTML plus Atlassian's `ac:` macro tags. This exists because the caller this
 * CLI is built around — an agent — writes Markdown, and asking a model to emit
 * `<ac:structured-macro ac:schema-version="1">` correctly every time produces something *nearly*
 * right, which fails as a 400 rather than as anything recoverable.
 *
 * Parsing, and the refusal of anything that cannot be translated, is `markdown-ast.ts`'s; this
 * file only renders the tree.
 *
 * **Everything that reaches storage is escaped.** Storage is XHTML, so an unescaped `&` or `<`
 * from caller prose either breaks the body or is silently reinterpreted as markup. That also
 * means Markdown cannot be used to inject a macro: a caller who writes `<ac:structured-macro>`
 * gets those characters on the page.
 *
 * See design 0013.
 */
export function markdownToStorage(markdown: string): string {
  return renderBlocks(parseMarkdown(markdown, 'confluence'));
}

function renderBlocks(blocks: readonly MdBlock[]): string {
  return blocks.map((block) => renderBlock(block)).join('');
}

function renderBlock(block: MdBlock): string {
  switch (block.type) {
    case 'heading':
      return `<h${block.level}>${renderInline(block.children)}</h${block.level}>`;
    case 'paragraph':
      return `<p>${renderInline(block.children)}</p>`;
    case 'code':
      return codeMacro(block.text, block.language);
    case 'rule':
      return '<hr />';
    case 'quote':
      return `<blockquote>${renderBlocks(block.children)}</blockquote>`;
    case 'list':
      return renderList(block);
    case 'table': {
      const headerRow = `<tr>${block.header.map((c) => `<th><p>${renderInline(c)}</p></th>`).join('')}</tr>`;
      const bodyRows = block.rows
        .map((row) => `<tr>${row.map((c) => `<td><p>${renderInline(c)}</p></td>`).join('')}</tr>`)
        .join('');
      return `<table><tbody>${headerRow}${bodyRows}</tbody></table>`;
    }
  }
}

/** A nested list belongs inside the item above it, after that item's own text. */
function renderList(list: MdList): string {
  const tag = list.ordered ? 'ol' : 'ul';
  const items = list.items.map((item) => {
    const text = item.content.length === 0 && item.children.length > 0 ? '' : `<p>${renderInline(item.content)}</p>`;
    return `<li>${text}${item.children.map((child) => renderList(child)).join('')}</li>`;
  });
  return `<${tag}>${items.join('')}</${tag}>`;
}

function renderInline(nodes: readonly MdInline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return escapeXml(node.text);
        case 'code':
          return `<code>${escapeXml(node.text)}</code>`;
        case 'link':
          return `<a href="${escapeXml(node.href)}">${renderInline(node.children)}</a>`;
        case 'strong':
          return `<strong>${renderInline(node.children)}</strong>`;
        case 'em':
          return `<em>${renderInline(node.children)}</em>`;
        case 'break':
          return '<br />';
      }
    })
    .join('');
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

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
