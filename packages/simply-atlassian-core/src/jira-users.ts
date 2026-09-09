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

import { CliError } from './errors.js';
import type { JiraClient } from './jira-client.js';

/** The fields surfaced from `/myself` and `/user`; the raw payload carries far more. */
export interface JiraUser {
  readonly displayName?: string;
  readonly emailAddress?: string;
  /** Cloud identifies accounts by accountId; Server/DC by username (`name`) and `key`. */
  readonly accountId?: string;
  readonly name?: string;
  readonly key?: string;
  readonly active?: boolean;
  readonly timeZone?: string;
  readonly accountType?: string;
}

/**
 * A 200 with no account in it means something answered that is not the Jira API — a login
 * page or a captive proxy. Reporting success here would tell a caller it is authenticated
 * when it is not, which is the one answer an identity check must never give.
 */
export function assertAccount(user: unknown): JiraUser {
  const account = (user ?? {}) as JiraUser;
  if (account.accountId === undefined && account.name === undefined && account.key === undefined) {
    throw new CliError(
      'The instance returned a success response with no account details. Check that the URL ' +
        'points at the Jira API rather than a login page or proxy.',
      1,
    );
  }
  return account;
}

/** The account the configured credentials belong to, verified to be one. */
export async function currentAccount(client: JiraClient): Promise<JiraUser> {
  return assertAccount(await client.getCurrentUser());
}

/** User search answers a bare array on some deployments and `{ values }` on others. */
export function userList(response: unknown): JiraUser[] {
  if (Array.isArray(response)) return response as JiraUser[];
  const values = (response as { readonly values?: unknown } | null)?.values;
  return Array.isArray(values) ? (values as JiraUser[]) : [];
}
