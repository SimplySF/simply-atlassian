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

import { CliError } from '../../core/errors.js';
import { JiraCommand } from '../../shared/base-command.js';
import { formatKeyValue } from '../../shared/output.js';

/** Shape of the fields we surface from `/myself`; the raw payload carries far more. */
interface CurrentUser {
  readonly displayName?: string;
  readonly emailAddress?: string;
  readonly accountId?: string;
  readonly name?: string;
  readonly key?: string;
  readonly active?: boolean;
  readonly timeZone?: string;
}

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
    const user = (await this.jira().getCurrentUser()) as CurrentUser;

    // A 200 with no account in it means something answered that is not the Jira API — a login
    // page or a captive proxy. Reporting success here would tell a caller it is authenticated
    // when it is not, which is the one answer this command must never give.
    if (user.accountId === undefined && user.name === undefined && user.key === undefined) {
      throw new CliError(
        'The instance returned a success response with no account details. Check that the URL ' +
          'points at the Jira API rather than a login page or proxy.',
        1,
      );
    }

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
