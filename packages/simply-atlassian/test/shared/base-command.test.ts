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

import { describe, expect, it } from 'vitest';
import { parseList } from '../../src/shared/base-command.js';

describe('parseList', () => {
  it('trims entries and drops blanks so no empty field name reaches the API', () => {
    expect(parseList('summary, status ')).toEqual(['summary', 'status']);
    // A trailing comma is what an agent templating a field list emits; Jira rejects `fields=`.
    expect(parseList('summary,')).toEqual(['summary']);
  });

  it('returns undefined for a value with nothing usable in it', () => {
    expect(parseList('')).toBeUndefined();
    expect(parseList(' , ')).toBeUndefined();
    expect(parseList(undefined)).toBeUndefined();
  });
});
