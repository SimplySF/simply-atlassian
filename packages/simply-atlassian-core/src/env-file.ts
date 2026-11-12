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

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { LEGACY_ENV } from './env-vars.js';
import { ConfigError } from './errors.js';

/**
 * The only variables a `.env` file may set: each `SIMPLY_*` setting and its deprecated unprefixed
 * name. Without this, a file the user did not write — one from a repo, a shared drive, or generated
 * by an agent — could set `NODE_TLS_REJECT_UNAUTHORIZED` and turn off the certificate verification
 * this CLI otherwise guarantees, handing the token to whoever answers. `*_SSL_VERIFY` is
 * deliberately included so that setting it still produces the explanatory ConfigError rather than
 * silence. `SIMPLY_ATLASSIAN_READ_ONLY` is safe to allow: the real environment still wins, so a
 * file can turn the guard on but never off.
 */
const APPLICABLE_KEYS = new Map<string, readonly string[]>();
for (const [current, legacy] of Object.entries(LEGACY_ENV)) {
  // Each name maps to both spellings of its setting, so the file is checked against either.
  APPLICABLE_KEYS.set(current, [current, legacy]);
  APPLICABLE_KEYS.set(legacy, [current, legacy]);
}

/** Matches `KEY=value`, tolerating a leading `export` and surrounding whitespace. */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * Strips one layer of matching quotes. Only double quotes get escape processing, matching how
 * shells treat them — `\n` in a single-quoted value is two literal characters.
 */
function unquote(raw: string): string {
  const value = raw.trim();
  const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : undefined;

  if (quote !== undefined) {
    // Anything after the closing quote is a comment, so a quoted value keeps its content even
    // when the line ends in `# note` — otherwise the quotes end up inside the credential.
    const closingAt = value.indexOf(quote, 1);
    if (closingAt !== -1) {
      const inner = value.slice(1, closingAt);
      // Only double quotes carry escapes, matching how a shell treats them.
      return quote === '"' ? inner.replaceAll('\\n', '\n').replaceAll('\\"', '"') : inner;
    }
    // Unterminated quote: fall through and treat the rest as a plain value.
  }

  // Unquoted values stop at an inline comment: `TOKEN=abc # note` is the token `abc`.
  const commentAt = value.search(/\s#/);
  return (commentAt === -1 ? value : value.slice(0, commentAt)).trim();
}

/** Parses `.env` contents into pairs, ignoring blanks, comments, and malformed lines. */
export function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  // An editor-written .env can start with a BOM, which would otherwise become part of the key.
  for (const line of contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const match = ASSIGNMENT.exec(line);
    if (match?.[1] !== undefined) parsed[match[1]] = unquote(match[2] ?? '');
  }
  return parsed;
}

/**
 * Loads a `.env` file into `env`, leaving any variable that is already set untouched — the real
 * environment and explicit flags outrank the file. A path the user named explicitly but that
 * cannot be read is a `ConfigError`: silently continuing would leave the caller (often an agent)
 * guessing why its credentials vanished.
 *
 * Only Atlassian connection variables, prefixed or deprecated, are applied; every other entry in
 * the file is ignored.
 */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : 'could not be read';
    throw new ConfigError(`Env file ${path} ${reason}.`);
  }

  for (const [key, value] of Object.entries(parseEnvFile(contents))) {
    const names = APPLICABLE_KEYS.get(key);
    if (names === undefined) continue;
    // The environment wins if it sets the setting under *either* name. Checking only `key` would
    // let a file's `SIMPLY_ATLASSIAN_READ_ONLY=0` outrank a real `ATLASSIAN_READ_ONLY=1` — the
    // prefixed name wins on lookup — and so turn the guard off from a file.
    // A variable exported as the empty string carries no value, so it must not outrank the
    // file the user explicitly named — otherwise `export SIMPLY_JIRA_API_TOKEN=` in a wrapper
    // script silently discards the real token and the run fails as if nothing were configured.
    if (names.every((name) => env[name] === undefined || env[name] === '')) env[key] = value;
  }
}
