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

import { Flags } from '@oclif/core';
import { formatTable, type LinkType, type LinkTypesResponse } from '@simplysf/simply-atlassian-core';
import { JiraCommand } from '../../../../../shared/base-command.js';

export default class JiraIssueLinkTypes extends JiraCommand<typeof JiraIssueLinkTypes> {
  public static override readonly summary = 'List the issue link types this instance offers.';
  public static override readonly description =
    'Both phrases are shown because either one can be passed to "issue link create", and ' +
    'neither is guessable from the type name — Duplicate offers "duplicates" and "is ' +
    'duplicated by". Link types are configured per instance, so this list is the authority.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  public static override readonly flags = {
    // GET /issueLinkType is unpaginated, and link types are administrator-defined prose that
    // lands in a caller's context, so the render is bounded like every other list here.
    limit: Flags.integer({ summary: 'Maximum number of link types to show.', default: 25, min: 1 }),
  };

  public async run(): Promise<unknown> {
    const response = (await this.jira().getLinkTypes()) as LinkTypesResponse;
    const types = response.issueLinkTypes ?? [];

    if (types.length === 0) {
      // Worth saying plainly: an empty list almost always means the feature is switched off
      // rather than that the instance genuinely has no types.
      this.log('This instance reports no issue link types, which usually means issue linking is disabled.');
      return response;
    }

    const shown = types.slice(0, this.flags.limit);
    this.log(
      formatTable(shown, [
        { header: 'NAME', value: (t: LinkType): string | undefined => t.name },
        { header: 'OUTWARD', value: (t: LinkType): string | undefined => t.outward },
        { header: 'INWARD', value: (t: LinkType): string | undefined => t.inward },
      ]),
    );
    const scope = shown.length === types.length ? '' : ` of ${types.length}`;
    this.log(`\nShowing ${shown.length}${scope} link type(s).`);
    return response;
  }
}
