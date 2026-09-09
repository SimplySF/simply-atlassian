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

import * as core from '@simplysf/simply-atlassian-core';
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

/**
 * The library surface moved to `@simplysf/simply-atlassian-core` (design doc 0012). This package
 * promised to keep exporting the names it always had, so that promise is asserted: the same
 * keys, and the same objects, not copies.
 */
describe('@simplysf/simply-atlassian compatibility exports', () => {
  it('still exports the names it did before the core split', () => {
    expect(Object.keys(api).sort()).toStrictEqual(
      [
        'AuthError',
        'CliError',
        'ConfigError',
        'ConfluenceClient',
        'HttpError',
        'JiraClient',
        'NetworkError',
        'resolveConfluenceConfig',
        'resolveJiraConfig',
      ].sort(),
    );
  });

  it('re-exports the core package objects themselves, so instanceof checks agree across both', () => {
    expect(api.JiraClient).toBe(core.JiraClient);
    expect(api.ConfluenceClient).toBe(core.ConfluenceClient);
    expect(api.ConfigError).toBe(core.ConfigError);
    expect(api.resolveJiraConfig).toBe(core.resolveJiraConfig);
  });
});
