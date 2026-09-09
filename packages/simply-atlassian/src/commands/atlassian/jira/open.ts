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

import { Args, Flags } from '@oclif/core';
import { issueUrl, projectUrl } from '../../../shared/atlassian-url.js';
import { JiraCommand } from '../../../shared/base-command.js';
import { openInBrowser } from '../../../shared/open-in-browser.js';

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export default class JiraOpen extends JiraCommand<typeof JiraOpen> {
  public static override readonly summary = 'Open a Jira issue or project in the browser.';
  public static override readonly description =
    'Builds the browser URL for an issue or project and opens it in the default browser. ' +
    'Use --print (or --url) to print the URL without launching a browser.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123',
    '<%= config.bin %> <%= command.id %> PROJ --print',
    '<%= config.bin %> <%= command.id %> PROJ-123 --json',
  ];

  public static override readonly args = {
    target: Args.string({
      description: 'Jira issue key or project key.',
      required: true,
    }),
  };

  public static override readonly flags = {
    print: Flags.boolean({
      aliases: ['url'],
      summary: 'Print the URL without opening a browser.',
      default: false,
    }),
  };

  public run(): Promise<{ url: string }> {
    const target = this.args.target.trim();
    const config = this.jiraConfig();
    const url = ISSUE_KEY.test(target) ? issueUrl(config.url, target) : projectUrl(config.url, target);

    if (!this.jsonEnabled()) {
      openInBrowser(url, { print: this.flags.print, log: (value) => this.log(value) });
    }

    return Promise.resolve({ url });
  }
}
