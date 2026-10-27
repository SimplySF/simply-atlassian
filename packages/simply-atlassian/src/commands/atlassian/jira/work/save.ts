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
import { Flags } from '@oclif/core';
import {
  ConfigError,
  saveWorkItem,
  type WorkDryRunResult,
  type WorkSaveInput,
  type WorkSaveResult,
} from '@simplysf/simply-atlassian-core';
import { WorkCommand, writeFlags } from '../../../../shared/base-command.js';
import { renderItem } from './get.js';

export default class JiraWorkSave extends WorkCommand<typeof JiraWorkSave> {
  public static override isWrite = true;

  public static override readonly summary =
    'Create or update a work item: a Jira issue and its linked Confluence page.';
  public static override readonly description =
    'The input is JSON: { "issue": { "key", "basedOn", "fields": { "<field name>": value } }, "page": ' +
    '{ "id", "basedOn", "markdown", "title" } }, with field names from "work get". Every value is ' +
    "checked against the project's config before anything is sent, and fields the config fixes are " +
    'applied whatever is passed. An update needs the revision "work get" printed as basedOn; if the ' +
    'issue or page changed since, nothing is saved and the current content is shown, to merge and ' +
    'retry. A page is linked from its issue with a Jira remote link, which is how it is found again. ' +
    'Issue status is never changed.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> --file story.json --dry-run',
    'cat story.json | <%= config.bin %> <%= command.id %> --file -',
  ];

  public static override readonly flags = {
    ...writeFlags,
    file: Flags.string({
      summary: 'Path to the JSON input, or - for stdin.',
      required: true,
    }),
    'accept-loss': Flags.boolean({
      summary: 'Save over content Markdown cannot carry (macros, mentions…), replacing it.',
      description:
        '"work get" names that content as "holds …". Without this flag a save that would replace it is refused.',
      default: false,
    }),
  };

  public async run(): Promise<WorkSaveResult | WorkDryRunResult> {
    const input = readInput(this.flags.file);
    const result = await saveWorkItem(this.workContext(), {
      ...input,
      acceptLoss: this.flags['accept-loss'] || input.acceptLoss === true,
      dryRun: this.flags['dry-run'],
    });

    if ('dryRun' in result) {
      this.log('Dry run — nothing sent.');
      if (result.issue !== undefined)
        this.logSafe(`\nIssue: ${result.issue.action}\n${result.issue.diff || '(no change)'}`);
      if (result.page !== undefined)
        this.logSafe(`\nPage: ${result.page.action}\n${result.page.diff || '(no change)'}`);
      for (const link of result.links) this.logSafe(`\nWould add: ${link}`);
    } else {
      const saved = [`issue ${result.saved.issue ?? 'untouched'}`, `page ${result.saved.page ?? 'untouched'}`].join(
        ', ',
      );
      this.logSafe(`Saved: ${saved}.\n`);
      this.logSafe(renderItem(result.item));
    }
    for (const adjustment of result.adjusted) {
      this.logSafe(
        `Note: ${adjustment.field} set to ${JSON.stringify(adjustment.value)} (${adjustment.reason} in the project config).`,
      );
    }
    return result;
  }
}

function readInput(file: string): WorkSaveInput {
  let text: string;
  try {
    text = file === '-' ? readFileSync(process.stdin.fd, 'utf8') : readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read the work item input ${file === '-' ? 'from stdin' : file}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(`The work item input ${file === '-' ? 'on stdin' : file} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('The work item input must be a JSON object with "issue" and/or "page".');
  }
  return parsed;
}
