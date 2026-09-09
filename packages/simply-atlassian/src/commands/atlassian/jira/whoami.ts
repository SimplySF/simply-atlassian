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

import { currentAccount, formatKeyValue } from '@simplysf/simply-atlassian-core';
import { JiraCommand } from '../../../shared/base-command.js';

export default class JiraWhoami extends JiraCommand<typeof JiraWhoami> {
  public static override readonly summary = 'Show the account the configured credentials belong to.';
  public static override readonly description =
    'Calls the Jira /myself endpoint. This is the cheapest way to confirm that the URL, ' +
    'credentials, and network path all work before running anything heavier.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --env-file .env',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  public async run(): Promise<unknown> {
    // A success response with no account in it is refused inside the shared operation: reporting
    // success there would tell a caller it is authenticated when it is not.
    const user = await currentAccount(this.jira());

    this.log(
      formatKeyValue([
        ['Name', user.displayName],
        ['Email', user.emailAddress],
        // Cloud identifies accounts by accountId; Server/DC by username and key.
        ['Account ID', user.accountId],
        ['Username', user.name],
        ['Key', user.key],
        ['Active', user.active],
        ['Time zone', user.timeZone],
      ]),
    );

    return user;
  }
}
