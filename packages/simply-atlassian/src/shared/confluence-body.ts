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

import { readFileSync } from 'node:fs';
import { ConfigError } from '../core/errors.js';
import { stripControl } from '../core/text.js';

/** The shape Confluence expects for a page or comment body. */
export interface StorageBody {
  readonly storage: { readonly value: string; readonly representation: 'storage' };
}

/**
 * Resolves a page or comment body from the three ways a caller can supply one.
 *
 * Confluence stores content as **storage format** — XHTML plus Atlassian's own macro tags, e.g.
 * `<ac:structured-macro ac:name="info">`. That is what these flags carry, verbatim. Markdown
 * input is deliberately not supported yet: converting markdown to storage is a mapping to design
 * (storage has no markdown form for an info panel; a fenced code block has to become a macro with
 * a CDATA body), not a function to write in passing. See design 0008.
 *
 * `--text` exists because the simple case is common and shouldn't require knowing any of that:
 * plain lines become paragraphs. It is not a markdown renderer and does not pretend to be — the
 * text is escaped, so a caller who passes `<b>x</b>` sees those characters on the page rather
 * than bold text, which is the honest reading of "text".
 *
 * Exactly one source is allowed. Accepting several and picking a winner would make a caller's
 * mistake look like a preference — the same rule as `parseBodyInput`.
 */
export function resolveStorageBody(flags: {
  text?: string;
  body?: string;
  'body-file'?: string;
}): StorageBody | undefined {
  const supplied = [
    ['--text', flags.text],
    ['--body', flags.body],
    ['--body-file', flags['body-file']],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined);

  if (supplied.length > 1) {
    throw new ConfigError(`Pass only one of ${supplied.map(([name]) => name).join(', ')}.`);
  }
  if (supplied.length === 0) return undefined;

  const [name, value] = supplied[0];
  const storage = name === '--text' ? paragraphs(value) : name === '--body' ? value : readBodyFile(value);
  return { storage: { value: storage, representation: 'storage' } };
}

/**
 * Wraps plain text as storage paragraphs.
 *
 * Blank-line separated blocks become paragraphs and single newlines become `<br/>`, matching how
 * the Jira description helper treats the same input so the two products behave alike. The text is
 * XML-escaped: storage format is XHTML, so an unescaped `&` or `<` from a caller's text would
 * produce a body Confluence rejects — or worse, silently reinterprets as markup.
 */
function paragraphs(text: string): string {
  // Stripped as well as escaped. Escaping stops caller text becoming markup; stripping stops it
  // carrying terminal escapes or invisible characters into stored content that a later reader —
  // a person, or a tool without this CLI's hardening — will ingest. This CLI removes exactly this
  // class on the way out of the API; writing it in unremarked would make the tool the vector.
  const blocks = stripControl(text)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '');
  if (blocks.length === 0) return '<p />';
  return blocks.map((block) => `<p>${escapeXml(block).replaceAll('\n', '<br />')}</p>`).join('');
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function readBodyFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    // The path is named but never the contents: a caller can point this at any file, and echoing
    // bytes back would turn a typo into a disclosure.
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : 'could not be read';
    throw new ConfigError(`Body file ${path} ${reason}.`);
  }
}
