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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { respondJson, startTestServer, type TestServer } from '@simplysf/simply-atlassian-core/testing';
import JiraIssueView from '../../src/commands/atlassian/jira/issue/view.js';

/*
 * The finding that mattered most in review, and it was reproduced against the built binary:
 * under `--json` the error `message` was redacted and control-stripped, while `body` — the same
 * bytes from the same response — went out untouched beside it. Whenever the far side echoes the
 * credential back (a captive portal, a proxy, an agency gateway on a government network) that is
 * a cleartext token disclosure straight into the context of whatever is parsing this output.
 *
 * Control characters are built by code point rather than written literally, so this file stays
 * readable and greppable.
 */
const CSI = String.fromCharCode(0x9b); // C1 control introducer — JSON.stringify leaves it raw
const ZERO_WIDTH = '​';
const RTL_OVERRIDE = '‮';

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

/** Captures the single JSON error object the CLI writes straight to stderr under `--json`. */
async function jsonErrorLine(token: string): Promise<string> {
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalArgv = process.argv;
  const flags = ['--jira-personal-token', token];
  // `redactSecrets` reads the real `process.argv`, which is where a token appears in real use.
  process.argv = [...originalArgv, ...flags];
  process.stderr.write = (chunk: unknown): boolean => {
    written.push(String(chunk));
    return true;
  };
  try {
    await JiraIssueView.run(['PROJ-1', '--jira-url', server.baseUrl, ...flags, '--json']).catch(() => undefined);
  } finally {
    process.stderr.write = originalWrite;
    process.argv = originalArgv;
  }
  return written.join('');
}

describe('HttpError body under --json', () => {
  it('redacts a credential the instance echoed back inside the body', async () => {
    const token = 'sup3r-s3cret-token-abcdef';
    server.route('/rest/api/2/issue/PROJ-1', (_req, res) => {
      respondJson(res, 400, { errorMessages: [`rejected token ${token} for this request`] });
    });

    const line = await jsonErrorLine(token);

    expect(line).toContain('<redacted>');
    expect(line).not.toContain(token);
  });

  it('strips characters JSON.stringify leaves live', async () => {
    server.route('/rest/api/2/issue/PROJ-1', (_req, res) => {
      respondJson(res, 400, { errorMessages: [`a${CSI}b${ZERO_WIDTH}c${RTL_OVERRIDE}d`] });
    });

    const line = await jsonErrorLine('pat-value-long-enough');

    expect(line).not.toContain(CSI);
    expect(line).not.toContain(ZERO_WIDTH);
    expect(line).not.toContain(RTL_OVERRIDE);
    expect(line).toContain('abcd');
  });

  it('reaches nested values, since Jira nests its own error text', async () => {
    const token = 'another-l0ng-secret-value';
    server.route('/rest/api/2/issue/PROJ-1', (_req, res) => {
      respondJson(res, 400, { errors: { summary: { detail: `token ${token} refused` } } });
    });

    const line = await jsonErrorLine(token);

    expect(line).not.toContain(token);
  });
});
