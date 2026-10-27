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

/** Lines of unchanged context shown around each change. */
const CONTEXT = 2;

/** Above this many line comparisons the diff is reported whole rather than computed line by line. */
const MAX_CELLS = 4_000_000;

/**
 * A unified-style line diff: `-` for a line only in `before`, `+` for one only in `after`, a
 * space for context, and `…` between separated hunks. Empty when the texts are identical.
 *
 * Written for people and agents to read before a save — not for `patch` — so there are no
 * line-number headers to get wrong. Documents here are a few hundred lines at most; anything far
 * larger is shown as a whole replacement rather than spending seconds on the alignment.
 */
export function lineDiff(before: string, after: string): string {
  if (before === after) return '';
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)].join('\n');
  }

  const ops = align(a, b);
  const keep = ops.map((op, index) => {
    if (op.kind !== ' ') return true;
    const near = ops.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1);
    return near.some((other) => other.kind !== ' ');
  });

  const out: string[] = [];
  let skipped = false;
  for (const [index, op] of ops.entries()) {
    if (!keep[index]) {
      skipped = true;
      continue;
    }
    if (skipped && out.length > 0) out.push('…');
    skipped = false;
    out.push(`${op.kind}${op.line}`);
  }
  return out.join('\n');
}

interface Op {
  readonly kind: ' ' | '-' | '+';
  readonly line: string;
}

/** Longest-common-subsequence alignment, removals before additions within a change. */
function align(a: readonly string[], b: readonly string[]): Op[] {
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if (
      j >= b.length ||
      (i < a.length && (lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0))
    ) {
      ops.push({ kind: '-', line: a[i] ?? '' });
      i += 1;
    } else {
      ops.push({ kind: '+', line: b[j] ?? '' });
      j += 1;
    }
  }
  return ops;
}
