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

/** One labelled value in a detail view. `undefined` values are dropped, not printed as blanks. */
export type Pair = readonly [label: string, value: unknown];

export interface Column<Row> {
  readonly header: string;
  readonly value: (row: Row) => unknown;
}

const EM_DASH = '—';

/**
 * Removes anything from server-chosen text that could make the rendered output lie.
 *
 * Anyone able to file a ticket controls an issue summary, anyone with page-edit rights controls
 * a page body, and anyone with an account controls their display name. Three classes of
 * character therefore have to go.
 *
 * ESC, BEL, backspace and the C1 range can erase or overwrite lines already printed, so a table
 * could show a different status or assignee than the API actually returned.
 *
 * A bare carriage return does the same thing with no escape sequence at all: everything before
 * it is overwritten on screen but still reaches a caller reading the stream. That splits what a
 * person reviewing the terminal sees from what an agent actually ingests, which is precisely the
 * human-in-the-loop check this output exists to support.
 *
 * Invisible Unicode format and bidi characters can reorder or hide text visually while leaving
 * the underlying bytes intact.
 *
 * Newline and tab are kept: they carry the layout this renderer emits.
 */
export function stripControl(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- matching control characters is the entire point
      .replaceAll(/[\u0000-\u0008\u000B-\u000D\u000E-\u001F\u007F-\u009F]/g, '')
      .replaceAll(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
  );
}

/** Renders any API value as one line of terminal text; missing values read as an em dash. */
function cell(value: unknown): string {
  if (value === null || value === undefined || value === '') return EM_DASH;
  if (typeof value === 'string') return stripControl(value).replaceAll(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return stripControl(JSON.stringify(value));
}

/** Right-pads to `width`, counting characters (adequate for the ASCII-ish fields we render). */
function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Aligned `Label: value` lines for a single entity. */
export function formatKeyValue(pairs: readonly Pair[]): string {
  const shown = pairs.filter(([, value]) => value !== undefined);
  if (shown.length === 0) return '';
  const labelWidth = Math.max(...shown.map(([label]) => label.length));
  return shown.map(([label, value]) => `${pad(`${label}:`, labelWidth + 1)} ${cell(value)}`).join('\n');
}

/**
 * Two-space-separated columns with a header rule. Every column is sized to its widest cell, and
 * the last column is never padded so trailing whitespace never lands in a pipeline.
 */
export function formatTable<Row>(rows: readonly Row[], columns: ReadonlyArray<Column<Row>>): string {
  if (rows.length === 0) return '';

  const body = rows.map((row) => columns.map((column) => cell(column.value(row))));
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...body.map((cells) => (cells[index] ?? '').length)),
  );

  const render = (cells: readonly string[]): string =>
    cells
      .map((text, index) => (index === cells.length - 1 ? text : pad(text, widths[index] ?? 0)))
      .join('  ')
      .trimEnd();

  return [
    render(columns.map((column) => column.header)),
    render(widths.map((width) => '─'.repeat(width))),
    ...body.map(render),
  ].join('\n');
}
