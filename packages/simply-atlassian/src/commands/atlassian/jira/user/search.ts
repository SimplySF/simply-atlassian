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
import { JiraCommand } from '../../../../shared/base-command.js';
import { formatTable } from '../../../../shared/output.js';

interface JiraUser {
  readonly accountId?: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly emailAddress?: string;
  readonly active?: boolean;
}

export default class JiraUserSearch extends JiraCommand<typeof JiraUserSearch> {
  public static override readonly summary = 'Find users by name or email.';
  public static override readonly description =
    'The account id column is the point of this command: it is what --mention and --assignee ' +
    'need, and it is not something anyone can guess. On Cloud, whether an email address is ' +
    'visible is a per-user privacy setting, so that column is often empty — searching by an ' +
    'email address still works even when it is not shown back.\n\n' +
    "This adds no access the credential does not already have, but it does put colleagues' " +
    'names and addresses wherever the output goes. When an AI agent is the caller, that means ' +
    'into its context — worth a thought before running it broadly against a work instance.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> ada',
    '<%= config.bin %> <%= command.id %> ada@example.com',
    '<%= config.bin %> <%= command.id %> ada --json',
  ];

  public static override readonly args = {
    query: Args.string({ description: 'Name or email to search for.', required: true }),
  };

  public static override readonly flags = {
    limit: Flags.integer({ summary: 'Maximum number of users to return.', default: 20, min: 1 }),
  };

  public async run(): Promise<unknown> {
    const response = (await this.jira().searchUsers(this.args.query, this.flags.limit)) as
      JiraUser[] | { values?: JiraUser[] };
    const users = Array.isArray(response) ? response : (response.values ?? []);

    if (users.length === 0) {
      this.log(`No users match "${this.args.query}".`);
      return response;
    }

    this.log(
      formatTable(users, [
        { header: 'ACCOUNT', value: (u): string | undefined => u.accountId ?? u.name },
        { header: 'NAME', value: (u): string | undefined => u.displayName ?? u.name },
        { header: 'EMAIL', value: (u): string | undefined => u.emailAddress },
        { header: 'ACTIVE', value: (u): boolean | undefined => u.active },
      ]),
    );
    this.log(`\nShowing ${users.length} user(s).`);
    return response;
  }
}
