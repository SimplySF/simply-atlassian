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

import { Command } from '@oclif/core';

/**
 * Placeholder command proving the build/lint/test/oclif pipeline works end to end. Delete this
 * once real Atlassian commands land.
 */
export default class HelloWorld extends Command {
  public static readonly summary = 'Print a friendly greeting.';
  public static readonly description =
    'A placeholder command that proves the CLI framework is wired up end to end. Replace or ' +
    'remove it once real Atlassian commands land.';
  public static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  public async run(): Promise<void> {
    await this.parse(HelloWorld);

    this.log('Hello from simply-atlassian! The framework is wired up — real commands land next.');
  }
}
