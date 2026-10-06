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

import { ConfigError } from './errors.js';
import type { JiraSearchResult } from './jira-client.js';
import { jqlString, type XrayBackend } from './xray-backend.js';
import {
  XRAY_FIELD_ROLES,
  XRAY_SCHEMA_PREFIX,
  type ResolvedField,
  type XrayInstance,
  type XrayIssueTypeRole,
} from './xray-fields.js';
import { findFolder, limitFolderDepth, normaliseFolders, type XrayFolder } from './xray-folders.js';
import { assertProjectKey, combineJql } from './xray-scope.js';
import { fieldResolver, simplifyFieldValue } from './xray-tests.js';

export interface XrayContainerListInput {
  readonly project: string;
  readonly jql?: string;
  readonly search?: string;
  readonly fields?: readonly string[];
  readonly limit: number;
}

export interface XrayContainerRow {
  readonly key: string | null;
  readonly status: string | null;
  readonly summary: string | null;
  /** How many tests the plan or set holds, when the instance has the field that lists them. */
  readonly testCount: number | null;
  readonly fields: Record<string, unknown>;
}

export interface XrayContainerListResult {
  /** What `--json` prints: raw issues plus paging, like `issue search`. */
  readonly search: JiraSearchResult;
  readonly rows: XrayContainerRow[];
  readonly extraFields: ResolvedField[];
}

export interface XrayFolderListInput {
  readonly project: string;
  /** Start at this folder instead of the root, with or without a leading slash. */
  readonly path?: string;
  /** Levels below the starting folder to include; all of them when omitted. */
  readonly depth?: number;
}

/** One row of `jira xray fields`: a role, or an Xray field no role claims. */
export interface XrayFieldRow {
  readonly role: string | null;
  readonly id: string | null;
  readonly name: string | null;
  readonly schemaType: string | null;
  /** `override`, `ambiguous`, `not found`, or null when discovery settled it. */
  readonly note: string | null;
}

export interface XrayIssueTypeRow {
  readonly role: XrayIssueTypeRole;
  readonly name: string | null;
  readonly note: string | null;
}

const CONTAINERS = {
  plan: { issueType: 'testPlan', testsRole: 'testPlanTests' },
  set: { issueType: 'testSet', testsRole: 'testSetTests' },
} as const;

const ISSUE_TYPE_ROLE_ORDER: readonly XrayIssueTypeRole[] = [
  'test',
  'testSet',
  'testPlan',
  'testExecution',
  'precondition',
];

/** Test plans or test sets in a project, with how many tests each holds. */
export async function listXrayContainers(
  backend: XrayBackend,
  kind: keyof typeof CONTAINERS,
  input: XrayContainerListInput,
): Promise<XrayContainerListResult> {
  const project = assertProjectKey(input.project);
  const spec = CONTAINERS[kind];
  const extrasFor = fieldResolver(backend, input.fields ?? []);
  const filters = { jql: input.jql, search: input.search };

  const { instance, ...search } = await backend.search(
    async (current) => ({
      jql: combineJql(
        `project = ${jqlString(project)} AND issuetype = ${jqlString(current.requireIssueType(spec.issueType))}`,
        filters,
      ),
      fields: [
        ...new Set(
          [
            'summary',
            'status',
            current.field(spec.testsRole),
            ...(await extrasFor(current)).map((extra) => extra.id),
          ].filter((id): id is string => id !== undefined),
        ),
      ],
    }),
    { limit: input.limit },
  );

  // Read with the instance the search ran with, which a rediscovery may have replaced.
  const extras = await extrasFor(instance);
  const testsField = instance.field(spec.testsRole);
  const rows = search.issues.map((issue) => {
    const record = issue as { key?: unknown; fields?: Record<string, unknown> };
    const fields = record.fields ?? {};
    const tests = testsField === undefined ? undefined : fields[testsField];
    return {
      key: typeof record.key === 'string' ? record.key : null,
      status: nameOf(fields.status),
      summary: typeof fields.summary === 'string' ? fields.summary : null,
      testCount: Array.isArray(tests) ? tests.length : null,
      fields: Object.fromEntries(extras.map((extra) => [extra.name, simplifyFieldValue(fields[extra.id])])),
    };
  });
  return { search, rows, extraFields: extras };
}

/** A project's test repository as a tree, optionally starting below the root and cut to a depth. */
export async function listXrayFolders(backend: XrayBackend, input: XrayFolderListInput): Promise<XrayFolder> {
  const project = assertProjectKey(input.project);
  const instance = await backend.instance();
  instance.requireField('repositoryPath');
  const tree = normaliseFolders(await backend.repositoryFolders(project));
  const start = input.path === undefined ? tree : findFolder(tree, input.path);
  if (start === undefined) {
    throw new ConfigError(`No folder "${input.path ?? ''}" in the ${project} test repository.`);
  }
  return limitFolderDepth(start, input.depth);
}

/**
 * The record as rows: every role (found, pinned, ambiguous, or missing), then the Xray fields no
 * role claims. Read straight from the record so an ambiguous role is shown rather than thrown.
 */
export function xrayFieldRows(instance: XrayInstance): XrayFieldRow[] {
  const { record } = instance;
  const name = (id: string | undefined): string | null => (id === undefined ? null : (record.fieldNames[id] ?? null));
  const roles = XRAY_FIELD_ROLES.map((spec): XrayFieldRow => {
    const schemaType = `${XRAY_SCHEMA_PREFIX}${spec.schemaType}`;
    const pinned = record.overrides.fields[spec.role];
    if (pinned !== undefined) return { role: spec.role, id: pinned, name: name(pinned), schemaType, note: 'override' };
    const candidates = record.ambiguous.fields[spec.role];
    if (candidates !== undefined && candidates.length > 1) {
      return { role: spec.role, id: candidates.join(', '), name: null, schemaType, note: 'ambiguous' };
    }
    const id = record.fields[spec.role];
    return { role: spec.role, id: id ?? null, name: name(id), schemaType, note: id === undefined ? 'not found' : null };
  });
  const unmapped = Object.entries(record.unmapped).map(([id, schemaType]): XrayFieldRow => ({
    role: null,
    id,
    name: name(id),
    schemaType,
    note: null,
  }));
  return [...roles, ...unmapped];
}

export function xrayIssueTypeRows(instance: XrayInstance): XrayIssueTypeRow[] {
  const { record } = instance;
  return ISSUE_TYPE_ROLE_ORDER.map((role) => {
    const pinned = record.overrides.issueTypes[role];
    if (pinned !== undefined) return { role, name: pinned, note: 'override' };
    const candidates = record.ambiguous.issueTypes[role];
    if (candidates !== undefined && candidates.length > 1)
      return { role, name: candidates.join(', '), note: 'ambiguous' };
    const found = record.issueTypes[role];
    return { role, name: found ?? null, note: found === undefined ? 'not found' : null };
  });
}

function nameOf(value: unknown): string | null {
  return typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string'
    ? (value as { name: string }).name
    : null;
}
