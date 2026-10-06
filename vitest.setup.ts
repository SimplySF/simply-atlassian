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

import { Console } from 'node:console';
import process from 'node:process';

// Vitest replaces the global `console` with its own console-like object for capturing test
// output, but that replacement doesn't carry over Node's `Console` class. `patch-console` (used
// by ink, which oclif's table renderer depends on) does `new console.Console(...)` and throws
// "console.Console is not a constructor" without it.
if (typeof console.Console !== 'function') {
  (console as unknown as { Console: typeof Console }).Console = Console;
}

// Commands resolve their connection from flags, then the environment, so a developer's shell
// that holds real `JIRA_*` or `CONFLUENCE_*` settings, or `ATLASSIAN_READ_ONLY`, would change what
// the tests see: "no credentials configured" finds a token, and writes are refused. Each test
// worker starts without them; a test that needs one sets it itself. This changes only the
// worker's own copy of the environment, never the shell that started the run.
for (const name of Object.keys(process.env)) {
  if (/^(JIRA|CONFLUENCE|ATLASSIAN)_/.test(name)) delete process.env[name];
}
