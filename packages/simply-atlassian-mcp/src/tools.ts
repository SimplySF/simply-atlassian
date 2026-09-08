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

import { z } from 'zod';

/**
 * What a tool does to the instance, which decides whether it is registered at all (only `read`
 * tools without `--allow-writes`), which MCP annotations it carries, and whether `confirm` is
 * demanded before the CLI is even invoked.
 */
export type ToolKind = 'read' | 'write' | 'destructive';

/** How one input property becomes CLI arguments. A bare string is the flag name. */
export interface FlagSpec {
  readonly flag: string;
  /** `false` is passed as `--no-<flag>` rather than omitted (oclif `allowNo`). */
  readonly negatable?: boolean;
  /** Arrays are joined with this into one value instead of repeating the flag. */
  readonly join?: string;
}

export interface ToolSpec {
  /** MCP tool name: `<product>_<noun>_<verb>`, snake case, stable across releases. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The CLI command path after `simply`, e.g. `['atlassian', 'jira', 'issue', 'search']`. */
  readonly command: readonly string[];
  readonly kind: ToolKind;
  readonly inputSchema: z.ZodRawShape;
  /** Input properties passed as positional arguments, in order. All are required strings. */
  readonly positionals: readonly string[];
  /** Input properties passed as flags. Anything not listed here or in `positionals` is ignored. */
  readonly flags: Readonly<Record<string, string | FlagSpec>>;
}

type ToolInput = Readonly<Record<string, unknown>>;

/**
 * Turns validated tool input into the CLI arguments that follow the command path. Properties
 * the spec doesn't map are ignored, so `dryRun`/`confirm` (handled by the caller) never leak
 * through as unknown flags.
 */
export function buildArgs(spec: ToolSpec, input: ToolInput): string[] {
  const args: string[] = [];

  for (const key of spec.positionals) {
    const value = input[key];
    if (typeof value !== 'string') throw new TypeError(`${spec.name}: "${key}" is required.`);
    args.push(value);
  }

  for (const [key, rawSpec] of Object.entries(spec.flags)) {
    const flagSpec: FlagSpec = typeof rawSpec === 'string' ? { flag: rawSpec } : rawSpec;
    const value = input[key];
    if (value === undefined || value === null) continue;
    const flag = `--${flagSpec.flag}`;

    if (typeof value === 'boolean') {
      if (value) args.push(flag);
      else if (flagSpec.negatable) args.push(`--no-${flagSpec.flag}`);
    } else if (Array.isArray(value)) {
      const items = value.map((item) => scalar(item)).filter((item): item is string => item !== undefined);
      if (flagSpec.join !== undefined) {
        if (items.length > 0) args.push(flag, items.join(flagSpec.join));
      } else {
        for (const item of items) args.push(flag, item);
      }
    } else if (typeof value === 'object') {
      args.push(flag, JSON.stringify(value));
    } else {
      const rendered = scalar(value);
      if (rendered !== undefined) args.push(flag, rendered);
    }
  }

  return args;
}

/** Renders a string or number for argv; anything else the schemas never produce is dropped. */
function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  return undefined;
}

// --- Schema building blocks, shared so the wording cannot drift between tools ---

const issueKey = z.string().describe('Issue key, for example PROJ-123.');
const commentId = z.string().describe('Comment id, as returned by jira_issue_comment_list.');
const pageRef = z.string().describe('Confluence page id, or a page URL to read the id from.');

const limit = (fallback: number, what: string): z.ZodOptional<z.ZodNumber> =>
  z.number().int().positive().optional().describe(`Maximum number of ${what} to return. Defaults to ${fallback}.`);

const fields = z
  .array(z.string())
  .optional()
  .describe(
    'Field names to request instead of the instance default. Raw issue payloads are large; ' +
      'name only the fields you need (for example ["summary", "status", "assignee"]).',
  );

const body = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'Raw Jira request body, for anything the typed properties do not cover such as custom ' +
      'fields. Issue fields belong under "fields". Typed properties are merged over it.',
  );

const dryRun = z
  .boolean()
  .optional()
  .describe('Print the request that would be sent and send nothing. Use it to preview a change.');

const confirm = z
  .boolean()
  .optional()
  .describe('Required, and must be true, to proceed with this irreversible change.');

const mentions = z
  .array(z.string())
  .optional()
  .describe(
    'People to @-mention: an account id, or a name or email to resolve. A name that matches ' +
      'more than one active user is an error listing the candidates, so retry with the id.',
  );

const labels = (verb: string): z.ZodOptional<z.ZodArray<z.ZodString>> =>
  z.array(z.string()).optional().describe(`Labels to ${verb}.`);

const WRITE_SHAPE = { dryRun } as const;
const DESTRUCTIVE_SHAPE = { dryRun, confirm } as const;

/**
 * Every tool this server can register, one per CLI command. The `test/tools.test.ts` suite
 * cross-checks this list against the CLI package's `command-snapshot.json`, so a command added
 * to the CLI without a tool here fails CI rather than going quietly unexposed.
 */
export const TOOLS: readonly ToolSpec[] = [
  // --- Jira: identity and users ---
  {
    name: 'jira_whoami',
    title: 'Jira: who am I',
    description:
      'Report the Jira account the configured credentials belong to. Call this first to confirm ' +
      'the connection works and to learn your own account id.',
    command: ['atlassian', 'jira', 'whoami'],
    kind: 'read',
    inputSchema: {},
    positionals: [],
    flags: {},
  },
  {
    name: 'jira_user_search',
    title: 'Jira: search users',
    description: 'Find Jira users by name or email. Returns account ids, which assignee and mention inputs need.',
    command: ['atlassian', 'jira', 'user', 'search'],
    kind: 'read',
    inputSchema: {
      query: z.string().describe('Name or email to search for.'),
      limit: limit(20, 'users'),
    },
    positionals: ['query'],
    flags: { limit: 'limit' },
  },
  {
    name: 'jira_user_view',
    title: 'Jira: view a user',
    description: 'Show one Jira user by account id (Cloud) or username (Server/Data Center).',
    command: ['atlassian', 'jira', 'user', 'view'],
    kind: 'read',
    inputSchema: {
      account: z.string().describe('Account id on Cloud, or username on Server/Data Center.'),
    },
    positionals: ['account'],
    flags: {},
  },

  // --- Jira: issues ---
  {
    name: 'jira_issue_search',
    title: 'Jira: search issues',
    description:
      'Search issues with JQL. Returns an envelope { issues, total?, pages, complete }: "issues" ' +
      'holds raw issue objects, and "complete": false means "limit" cut the results short. ' +
      'Pass "fields" to keep the payload small.',
    command: ['atlassian', 'jira', 'issue', 'search'],
    kind: 'read',
    inputSchema: {
      jql: z.string().describe("JQL query to run, for example 'project = PROJ AND statusCategory != Done'."),
      limit: limit(50, 'issues across all pages'),
      fields,
    },
    positionals: [],
    flags: { jql: 'jql', limit: 'limit', fields: { flag: 'fields', join: ',' } },
  },
  {
    name: 'jira_issue_view',
    title: 'Jira: view an issue',
    description:
      'Fetch one issue as the raw API payload. Pass "fields" to limit it, or "expand" for ' +
      'extras such as the changelog.',
    command: ['atlassian', 'jira', 'issue', 'view'],
    kind: 'read',
    inputSchema: {
      issue: issueKey,
      fields,
      expand: z.array(z.string()).optional().describe('Jira expand parameters, for example ["changelog"].'),
    },
    positionals: ['issue'],
    flags: { fields: { flag: 'fields', join: ',' }, expand: { flag: 'expand', join: ',' } },
  },
  {
    name: 'jira_issue_transitions',
    title: 'Jira: list available transitions',
    description:
      'List the workflow transitions an issue can take right now, with their ids and names. ' +
      'Call this before jira_issue_transition when you are not sure of the transition name.',
    command: ['atlassian', 'jira', 'issue', 'transitions'],
    kind: 'read',
    inputSchema: { issue: issueKey },
    positionals: ['issue'],
    flags: {},
  },
  {
    name: 'jira_issue_create',
    title: 'Jira: create an issue',
    description:
      'Create an issue. Common fields have their own properties; "body" supplies raw fields ' +
      'JSON for anything else, including custom fields. Pass "parent" with type "Subtask" to ' +
      'create a subtask. Use dryRun to see exactly what would be sent.',
    command: ['atlassian', 'jira', 'issue', 'create'],
    kind: 'write',
    inputSchema: {
      project: z.string().optional().describe('Project key the issue belongs to.'),
      type: z.string().optional().describe('Issue type name, for example Task or Bug.'),
      summary: z.string().optional().describe('Issue summary.'),
      description: z.string().optional().describe('Issue description as plain text.'),
      parent: z.string().optional().describe('Parent issue key, making this a subtask of it.'),
      assignee: z.string().optional().describe('Assignee: account id on Cloud, username on Server/Data Center.'),
      priority: z.string().optional().describe('Priority name.'),
      labels: labels('apply'),
      body,
      ...WRITE_SHAPE,
    },
    positionals: [],
    flags: {
      project: 'project',
      type: 'type',
      summary: 'summary',
      description: 'description',
      parent: 'parent',
      assignee: 'assignee',
      priority: 'priority',
      labels: 'label',
      body: 'body',
    },
  },
  {
    name: 'jira_issue_update',
    title: 'Jira: update an issue',
    description:
      'Change fields on an existing issue. Only the properties you pass are changed; "labels" ' +
      'replaces the whole label set. The issue is re-read afterwards unless verify is false. ' +
      'Use dryRun to preview.',
    command: ['atlassian', 'jira', 'issue', 'update'],
    kind: 'write',
    inputSchema: {
      issue: issueKey,
      summary: z.string().optional().describe('New summary.'),
      description: z.string().optional().describe('New description as plain text.'),
      assignee: z.string().optional().describe('New assignee: account id on Cloud, username on Server/Data Center.'),
      priority: z.string().optional().describe('New priority name.'),
      labels: labels('set, replacing the existing labels'),
      body,
      verify: z.boolean().optional().describe('Re-read the issue after updating and return it. Defaults to true.'),
      ...WRITE_SHAPE,
    },
    positionals: ['issue'],
    flags: {
      summary: 'summary',
      description: 'description',
      assignee: 'assignee',
      priority: 'priority',
      labels: 'label',
      body: 'body',
      verify: { flag: 'verify', negatable: true },
    },
  },
  {
    name: 'jira_issue_transition',
    title: 'Jira: transition an issue',
    description:
      'Move an issue through its workflow by transition id or name (see jira_issue_transitions). ' +
      'Optionally add a comment as part of the transition. Use dryRun to preview.',
    command: ['atlassian', 'jira', 'issue', 'transition'],
    kind: 'write',
    inputSchema: {
      issue: issueKey,
      transition: z.string().describe('Transition id, or its name, for example "Done".'),
      comment: z.string().optional().describe('Comment to add as part of the transition.'),
      byName: z.boolean().optional().describe('Treat "transition" as a name even if it is all digits.'),
      body,
      ...WRITE_SHAPE,
    },
    positionals: ['issue', 'transition'],
    flags: { comment: 'comment', byName: 'by-name', body: 'body' },
  },
  {
    name: 'jira_issue_delete',
    title: 'Jira: delete an issue',
    description:
      'Permanently delete an issue. Irreversible: requires confirm: true. Jira refuses to delete ' +
      'an issue that has subtasks unless deleteSubtasks is true. Use dryRun to see what would be ' +
      'deleted without deleting it.',
    command: ['atlassian', 'jira', 'issue', 'delete'],
    kind: 'destructive',
    inputSchema: {
      issue: issueKey,
      deleteSubtasks: z.boolean().optional().describe("Also delete the issue's subtasks."),
      ...DESTRUCTIVE_SHAPE,
    },
    positionals: ['issue'],
    flags: { deleteSubtasks: 'delete-subtasks' },
  },

  // --- Jira: comments ---
  {
    name: 'jira_issue_comment_list',
    title: 'Jira: list comments',
    description: 'List the comments on an issue, newest last, with their ids.',
    command: ['atlassian', 'jira', 'issue', 'comment', 'list'],
    kind: 'read',
    inputSchema: { issue: issueKey, limit: limit(25, 'comments') },
    positionals: ['issue'],
    flags: { limit: 'limit' },
  },
  {
    name: 'jira_issue_comment_add',
    title: 'Jira: add a comment',
    description:
      'Add a comment to an issue. "text" is plain text; "mentions" @-mentions people by account ' +
      'id, name, or email. Use dryRun to preview.',
    command: ['atlassian', 'jira', 'issue', 'comment', 'add'],
    kind: 'write',
    inputSchema: {
      issue: issueKey,
      text: z.string().optional().describe('Comment text.'),
      mentions,
      body,
      ...WRITE_SHAPE,
    },
    positionals: ['issue'],
    flags: { text: 'text', mentions: 'mention', body: 'body' },
  },
  {
    name: 'jira_issue_comment_edit',
    title: 'Jira: edit a comment',
    description: 'Replace the text of an existing comment. Use dryRun to preview.',
    command: ['atlassian', 'jira', 'issue', 'comment', 'edit'],
    kind: 'write',
    inputSchema: {
      issue: issueKey,
      comment: commentId,
      text: z.string().optional().describe('Replacement comment text.'),
      mentions,
      body,
      ...WRITE_SHAPE,
    },
    positionals: ['issue', 'comment'],
    flags: { text: 'text', mentions: 'mention', body: 'body' },
  },
  {
    name: 'jira_issue_comment_delete',
    title: 'Jira: delete a comment',
    description:
      'Permanently delete a comment. Irreversible: requires confirm: true. Use dryRun to see ' +
      'what would be deleted.',
    command: ['atlassian', 'jira', 'issue', 'comment', 'delete'],
    kind: 'destructive',
    inputSchema: { issue: issueKey, comment: commentId, ...DESTRUCTIVE_SHAPE },
    positionals: ['issue', 'comment'],
    flags: {},
  },

  // --- Jira: issue links ---
  {
    name: 'jira_issue_link_list',
    title: 'Jira: list issue links',
    description: "List the links on an issue, each described from that issue's point of view, with link ids.",
    command: ['atlassian', 'jira', 'issue', 'link', 'list'],
    kind: 'read',
    inputSchema: { issue: issueKey, limit: limit(25, 'links') },
    positionals: ['issue'],
    flags: { limit: 'limit' },
  },
  {
    name: 'jira_issue_link_types',
    title: 'Jira: list link types',
    description:
      'List the link types this instance allows, with their outward and inward phrases ' +
      '(for example "blocks" / "is blocked by").',
    command: ['atlassian', 'jira', 'issue', 'link', 'types'],
    kind: 'read',
    inputSchema: { limit: limit(25, 'link types') },
    positionals: [],
    flags: { limit: 'limit' },
  },
  {
    name: 'jira_issue_link_create',
    title: 'Jira: link two issues',
    description:
      'Relate two issues, stated the natural way round: from PROJ-1, "blocks", to PROJ-2 means ' +
      'PROJ-1 blocks PROJ-2. "type" is a phrase or a link type name; either direction\'s phrase ' +
      'is accepted. Use dryRun to preview.',
    command: ['atlassian', 'jira', 'issue', 'link', 'create'],
    kind: 'write',
    inputSchema: {
      from: z.string().describe('Issue the relationship is stated from, for example PROJ-1.'),
      type: z.string().describe('Relationship phrase or link type name, for example "blocks".'),
      to: z.string().describe('Issue the relationship points at, for example PROJ-2.'),
      comment: z.string().optional().describe('Comment to add to the link.'),
      ...WRITE_SHAPE,
    },
    positionals: ['from', 'type', 'to'],
    flags: { comment: 'comment' },
  },
  {
    name: 'jira_issue_link_delete',
    title: 'Jira: remove an issue link',
    description: 'Remove a link between two issues by link id (see jira_issue_link_list). Use dryRun to preview.',
    command: ['atlassian', 'jira', 'issue', 'link', 'delete'],
    kind: 'write',
    inputSchema: {
      linkId: z.string().describe('Link id, as shown by jira_issue_link_list.'),
      ...WRITE_SHAPE,
    },
    positionals: ['linkId'],
    flags: {},
  },

  // --- Confluence: pages ---
  {
    name: 'confluence_page_get',
    title: 'Confluence: get a page',
    description:
      'Fetch a page by id or URL as the raw API payload, including its stored body unless ' + 'bodyFormat is "none".',
    command: ['atlassian', 'confluence', 'page', 'get'],
    kind: 'read',
    inputSchema: {
      page: pageRef,
      bodyFormat: z
        .enum(['markdown', 'storage', 'none'])
        .optional()
        .describe('Which body representation to request. "none" skips the body entirely.'),
      expand: z.array(z.string()).optional().describe('Confluence expansions, replacing the default set.'),
    },
    positionals: ['page'],
    flags: { bodyFormat: 'body-format', expand: { flag: 'expand', join: ',' } },
  },
  {
    name: 'confluence_page_search',
    title: 'Confluence: search pages',
    description: 'Search Confluence content with CQL, for example \'text ~ "release notes" AND space = DOCS\'.',
    command: ['atlassian', 'confluence', 'page', 'search'],
    kind: 'read',
    inputSchema: {
      cql: z.string().describe('CQL query to run.'),
      limit: limit(25, 'results across all pages'),
    },
    positionals: [],
    flags: { cql: 'cql', limit: 'limit' },
  },
  {
    name: 'confluence_page_children',
    title: 'Confluence: list child pages',
    description: 'List the direct child pages of a page.',
    command: ['atlassian', 'confluence', 'page', 'children'],
    kind: 'read',
    inputSchema: { page: pageRef, limit: limit(25, 'children') },
    positionals: ['page'],
    flags: { limit: 'limit' },
  },
];
