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

import { Args } from '@oclif/core';
import { JiraCommand } from '../../../../shared/base-command.js';
import { formatKeyValue } from '../../../../shared/output.js';

interface JiraUser {
  readonly accountId?: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly emailAddress?: string;
  readonly active?: boolean;
  readonly timeZone?: string;
  readonly accountType?: string;
}

export default class JiraUserView extends JiraCommand<typeof JiraUserView> {
  public static override readonly summary = 'Show one user.';
  public static override readonly description =
    'Takes an account id on Cloud, or a username on Server/Data Center — the same distinction ' +
    'the connection settings make. Use "user search" if you have a name rather than an id.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> 70121:8d8e579e-980f-49ed-93ec-0a0d519f60e4',
    '<%= config.bin %> <%= command.id %> ada --json',
  ];

  public static override readonly args = {
    account: Args.string({ description: 'Account id (Cloud) or username (Server/DC).', required: true }),
  };

  public async run(): Promise<unknown> {
    const user = (await this.jira().getUser(this.args.account)) as JiraUser;

    this.log(
      formatKeyValue([
        ['Account', user.accountId ?? user.name],
        ['Name', user.displayName],
        ['Email', user.emailAddress],
        ['Active', user.active],
        ['Time zone', user.timeZone],
        ['Type', user.accountType],
      ]),
    );
    return user;
  }
}
