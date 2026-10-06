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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

export type RouteHandler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

export interface TestServer {
  baseUrl: string;
  requests: RecordedRequest[];
  route: (pathname: string, handler: RouteHandler) => void;
  close: () => Promise<void>;
}

export function respondJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(payload));
}

/** Tiny local HTTP server: register handlers per pathname, and every request gets recorded. */
export async function startTestServer(): Promise<TestServer> {
  const routes = new Map<string, RouteHandler>();
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      requests.push({ method: request.method ?? '', url: request.url ?? '', body });
      const handler = routes.get(url.pathname);
      if (handler) {
        handler(request, response, body);
      } else {
        respondJson(response, 404, { error: `no route for ${url.pathname}` });
      }
    });
  });

  const baseUrl = await new Promise<string>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate a port'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return {
    baseUrl,
    requests,
    route: (pathname, handler): void => {
      routes.set(pathname, handler);
    },
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * An Xray instance whose fields carry deliberately unusual ids and renamed, translated display
 * names, so nothing passes by matching a default. Discovery must find every role by schema type.
 */
export const XRAY_FIXTURE_FIELDS = [
  { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string', system: 'summary' } },
  { id: 'components', name: 'Component/s', custom: false, schema: { type: 'array', system: 'components' } },
  { id: 'customfield_40016', name: 'Story Points', custom: true, schema: { type: 'number' } },
  xrayField('customfield_93001', 'Prüfart', 'test-type-custom-field'),
  xrayField('customfield_93002', 'Schritte', 'manual-test-steps-custom-field'),
  xrayField('customfield_93003', 'Cucumber-Art', 'automated-test-type-custom-field'),
  xrayField('customfield_93004', 'Szenario', 'steps-editor-custom-field'),
  xrayField('customfield_93005', 'Generische Definition', 'path-editor-custom-field'),
  xrayField('customfield_93006', 'Vorbedingungen', 'test-precondition-custom-field'),
  xrayField('customfield_93007', 'In Testsets', 'test-sets-custom-field'),
  xrayField('customfield_93008', 'In Testplänen', 'test-plans-associated-with-test-custom-field'),
  xrayField('customfield_93009', 'Ablageort', 'test-repository-path-custom-field'),
  xrayField('customfield_93010', 'Tests im Set', 'test-sets-tests-custom-field'),
  xrayField('customfield_93011', 'Tests im Plan', 'tests-associated-with-test-plan-custom-field'),
  xrayField('customfield_93099', 'Neues Xray-Feld', 'some-future-custom-field'),
];

/** The fixture's role → field id map, for asserting what discovery should have found. */
export const XRAY_FIXTURE_IDS = {
  testType: 'customfield_93001',
  steps: 'customfield_93002',
  cucumberType: 'customfield_93003',
  cucumberScenario: 'customfield_93004',
  genericDefinition: 'customfield_93005',
  preconditions: 'customfield_93006',
  testSets: 'customfield_93007',
  testPlans: 'customfield_93008',
  repositoryPath: 'customfield_93009',
  testSetTests: 'customfield_93010',
  testPlanTests: 'customfield_93011',
} as const;

/** Where Xray DC serves its issue-type icons, as observed on a live instance: hyphenated file names. */
const XRAY_ICON = 'https://jira.example.test/download/resources/com.xpandit.plugins.xray/images';

/** Renamed Xray issue types, recognisable only by icon and description. */
export const XRAY_FIXTURE_ISSUE_TYPES = [
  { id: '1', name: 'Story', description: 'A user story.', iconUrl: '/images/icons/issuetypes/story.svg' },
  { id: '10100', name: 'Prüfung', description: 'Represents a Test', iconUrl: `${XRAY_ICON}/test.png` },
  { id: '10101', name: 'Prüfsammlung', description: 'Represents a Test Set', iconUrl: `${XRAY_ICON}/test-set.png` },
  { id: '10102', name: 'Prüfplan', description: 'Represents a Test Plan', iconUrl: `${XRAY_ICON}/test-plan.png` },
  { id: '10103', name: 'Prüflauf', description: '', iconUrl: `${XRAY_ICON}/test-execution.png` },
  {
    id: '10104',
    name: 'Vorbedingung',
    description: 'Represents a Pre-Condition',
    iconUrl: `${XRAY_ICON}/precondition.png`,
  },
];

/** Answers Xray discovery (`/field`, `/issuetype`, and the plugin version) on a test server. */
export function routeXrayDiscovery(
  server: Pick<TestServer, 'route'>,
  options: { readonly fields?: unknown; readonly issueTypes?: unknown; readonly version?: string } = {},
): void {
  server.route('/rest/api/2/field', (_request, response) =>
    respondJson(response, 200, options.fields ?? XRAY_FIXTURE_FIELDS),
  );
  server.route('/rest/api/2/issuetype', (_request, response) =>
    respondJson(response, 200, options.issueTypes ?? XRAY_FIXTURE_ISSUE_TYPES),
  );
  server.route('/rest/plugins/1.0/com.xpandit.plugins.xray-key', (_request, response) =>
    respondJson(response, 200, { key: 'com.xpandit.plugins.xray', version: options.version ?? '7.4.0' }),
  );
}

function xrayField(id: string, name: string, type: string): unknown {
  return { id, name, custom: true, schema: { type: 'any', custom: `com.xpandit.plugins.xray:${type}`, customId: 1 } };
}

/**
 * Answers Server/DC `/rest/api/2/search` from a function of the JQL, paging the result by the
 * request's `startAt` and `maxResults` the way Jira does, and reporting a `total`.
 */
export function routeJiraSearch(server: Pick<TestServer, 'route'>, answer: (jql: string, url: URL) => unknown[]): void {
  server.route('/rest/api/2/search', (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const all = answer(url.searchParams.get('jql') ?? '', url);
    const startAt = Number(url.searchParams.get('startAt') ?? 0);
    const maxResults = Number(url.searchParams.get('maxResults') ?? 50);
    respondJson(response, 200, {
      startAt,
      maxResults,
      total: all.length,
      issues: all.slice(startAt, startAt + maxResults),
    });
  });
}

/** The keys a `key in (…)` query names, in order. */
export function keysInJql(jql: string): string[] {
  const list = /key in \(([^)]*)\)/.exec(jql)?.[1] ?? '';
  return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
}

export interface XrayFixtureIssueOptions {
  readonly summary?: string;
  readonly status?: string;
  readonly issueType?: string;
  readonly testType?: string;
  readonly steps?: unknown[];
  readonly scenario?: string;
  readonly preconditions?: string[];
  readonly sets?: string[];
  readonly plans?: string[];
  readonly path?: string;
  readonly links?: unknown[];
  readonly extra?: Record<string, unknown>;
}

/** A Test issue as the fixture instance returns it, with Xray data under the fixture's field ids. */
export function xrayFixtureIssue(key: string, options: XrayFixtureIssueOptions = {}): unknown {
  return {
    id: String(10_000 + Number(key.split('-')[1] ?? 0)),
    key,
    fields: {
      summary: options.summary ?? `Summary of ${key}`,
      status: { name: options.status ?? 'Ready' },
      issuetype: { name: options.issueType ?? 'Prüfung' },
      issuelinks: options.links ?? [],
      [XRAY_FIXTURE_IDS.testType]: { value: options.testType ?? 'Manual' },
      [XRAY_FIXTURE_IDS.steps]: { steps: options.steps ?? [] },
      [XRAY_FIXTURE_IDS.cucumberScenario]: options.scenario ?? null,
      [XRAY_FIXTURE_IDS.preconditions]: options.preconditions ?? [],
      [XRAY_FIXTURE_IDS.testSets]: options.sets ?? [],
      [XRAY_FIXTURE_IDS.testPlans]: options.plans ?? [],
      [XRAY_FIXTURE_IDS.repositoryPath]: options.path ?? null,
      ...options.extra,
    },
  };
}

/** A manual step in the current `{ index, fields: { Action, Data, "Expected Result" } }` form. */
export function xrayStep(index: number, action: string, result = '', data = ''): unknown {
  return { id: index, index, fields: { Action: action, Data: data, 'Expected Result': result }, attachments: [] };
}
