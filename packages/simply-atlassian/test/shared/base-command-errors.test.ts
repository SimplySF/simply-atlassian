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

import { describe, expect, it } from 'vitest';
import JiraIssueLinkTypes from '../../src/commands/atlassian/jira/issue/link/types.js';

/** Reaches the protected handler without an `any`, which this repo bans. */
interface Catchable {
  init(): Promise<void>;
  catch(error: Error): Promise<unknown>;
}

async function surfaced(error: Error): Promise<string> {
  const command = new JiraIssueLinkTypes(
    ['--jira-url', 'https://example.atlassian.net', '--jira-personal-token', 'sup3r-s3cret-pat'],
    { runHook: async () => ({ successes: [], failures: [] }) } as never,
  );
  await (command as unknown as Catchable).init();
  const thrown = await (command as unknown as Catchable).catch(error).catch((caught: unknown) => caught);
  return (thrown as Error).message;
}

/*
 * An unexpected error — a TypeError from a malformed payload, say — used to bypass the
 * sanitisation the handler had already computed: the `CliError` branch printed the cleaned
 * message, and everything else was handed to oclif's default handler carrying the original text.
 * These two cases are the ones that reach that branch.
 */
describe('unexpected errors on the human output path', () => {
  it('strips control characters an instance put in the message', async () => {
    const message = await surfaced(new Error('malformed[2K[1Apayload'));

    expect(message).toBe('malformed[2K[1Apayload');
  });

  /*
   * The correction to an earlier version of this change. Collapsing the whole assembled message
   * to one line looked like the safe choice, but this CLI's own errors use newlines as meaning:
   * the ambiguity errors list candidate ids one per line so a caller can retry precisely, and
   * flattening ran the ids together into an unreadable run. Untrusted text is made single-line
   * where it is interpolated instead — see `formatSnippet` and the `describe` helpers.
   */
  it("keeps this CLI's own line structure, which callers rely on to read candidate lists", async () => {
    const listing = 'ambiguous:\n  70121:8d8e — A\n  qm:8b1e — B';

    const message = await surfaced(new Error(listing));

    expect(message).toContain('\n  70121:8d8e — A');
    expect(message).toContain('\n  qm:8b1e — B');
  });

  it('still strips characters that could rewrite what is already on screen', async () => {
    const message = await surfaced(new Error('line one\rforged'));

    expect(message).toBe('line oneforged');
  });

  /*
   * Redaction reads the real `process.argv`, which is where a token actually appears when someone
   * runs the CLI. A programmatic test passes argv to the constructor instead, so the process's own
   * argv has to be stood up for the check to mean anything.
   */
  it('redacts a credential quoted back in the message', async () => {
    const original = process.argv;
    process.argv = [...original, '--jira-personal-token', 'sup3r-s3cret-pat'];
    try {
      const message = await surfaced(new Error('failed running with token sup3r-s3cret-pat'));

      expect(message).not.toContain('sup3r-s3cret-pat');
      expect(message).toContain('<redacted>');
    } finally {
      process.argv = original;
    }
  });

  it('redacts the inline --flag=value form too', async () => {
    const original = process.argv;
    process.argv = [...original, '--jira-api-token=another-l0ng-secret'];
    try {
      expect(await surfaced(new Error('failed with another-l0ng-secret'))).not.toContain('another-l0ng-secret');
    } finally {
      process.argv = original;
    }
  });
});
