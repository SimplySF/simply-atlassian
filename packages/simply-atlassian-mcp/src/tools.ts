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

import {
  addIssuesToSprint,
  BODY_FORMATS,
  buildCommentBody,
  buildCommentEditBody,
  buildCreateIssueBody,
  buildIssueLinkBody,
  buildPageCommentBody,
  buildPageCreateBody,
  buildTransitionBody,
  buildUpdateIssueBody,
  changelogJson,
  currentAccount,
  buildRemoteLinkBody,
  buildSprintCreateBody,
  deleteComment,
  deleteIssue,
  deleteIssueLink,
  deletePage,
  describeRemoteLink,
  filterChangelog,
  issueLinkCreated,
  listFields,
  jiraTargetUrl,
  numericId,
  pageExpand,
  pageIdForInstance,
  pageIdFromInput,
  pageUrl,
  preparePageUpdate,
  prepareSprintUpdate,
  readBackIssue,
  resolveTransitionId,
  type RemoteLink,
  updatePage,
} from '@simplysf/simply-atlassian-core';
import { z } from 'zod';
import type { ToolContext } from './context.js';

/**
 * What a tool does to the instance, which decides whether it is registered at all (only `read`
 * tools without `--allow-writes`), which MCP annotations it carries, and whether `confirm` is
 * demanded before it runs.
 */
export type ToolKind = 'read' | 'write' | 'destructive';

export interface ToolSpec {
  /** MCP tool name: `<product>_<noun>_<verb>`, snake case, stable across releases. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The CLI command this tool is the equivalent of, e.g. `['atlassian', 'jira', 'issue', 'search']`. */
  readonly command: readonly string[];
  readonly kind: ToolKind;
  readonly inputSchema: z.ZodRawShape;
  /**
   * For a destructive tool, whether this particular call needs `confirm`. Defaults to always;
   * `confluence_page_delete` only needs it to purge, because trashing is reversible and the
   * CLI does not demand `--confirm` for it either.
   */
  readonly requiresConfirm?: (input: Readonly<Record<string, unknown>>) => boolean;
  /** Runs the tool against the instance and returns what the CLI would print under `--json`. */
  readonly run: (context: ToolContext, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
}

/** A spec whose handler sees the input typed by its own schema; `tool()` erases that for the catalogue. */
interface TypedToolSpec<S extends z.ZodRawShape> extends Omit<ToolSpec, 'inputSchema' | 'run'> {
  readonly inputSchema: S;
  readonly run: (context: ToolContext, input: z.output<z.ZodObject<S>>) => Promise<unknown>;
}

function tool<S extends z.ZodRawShape>(spec: TypedToolSpec<S>): ToolSpec {
  return spec as unknown as ToolSpec;
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
  .describe('Return the request that would be sent and send nothing. Use it to preview a change.');

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

const storageText = z
  .string()
  .optional()
  .describe('Body as plain text; becomes paragraphs with its markup characters escaped.');
const storageBody = z
  .string()
  .optional()
  .describe('Body as raw Confluence storage-format XHTML, including Atlassian macro tags.');

const storageMarkdown = z
  .string()
  .optional()
  .describe(
    'Body as Markdown, converted to storage format. Headings, emphasis, lists, links, tables, ' +
      'blockquotes and fenced code blocks are supported; anything else — images, raw HTML, task ' +
      'lists — is refused naming the line, rather than dropped. Confluence macros such as info ' +
      'panels have no Markdown form: use body for those.',
  );

const WRITE_SHAPE = { dryRun } as const;
const DESTRUCTIVE_SHAPE = { dryRun, confirm } as const;

/**
 * Every tool this server can register, one per CLI command. The `test/tools.test.ts` suite
 * cross-checks this list against the CLI package's `command-snapshot.json`, so a command added
 * to the CLI without a tool here fails CI rather than going quietly unexposed.
 *
 * Each handler returns exactly what the matching command returns under `--json`, and the logic
 * between input and request is the core package's — the same functions the command calls — so
 * a dry run, a refusal, or an error reads the same from either surface.
 */
export const TOOLS: readonly ToolSpec[] = [
  // --- Jira: identity and users ---
  tool({
    name: 'jira_whoami',
    title: 'Jira: who am I',
    description:
      'Report the Jira account the configured credentials belong to. Call this first to confirm ' +
      'the connection works and to learn your own account id.',
    command: ['atlassian', 'jira', 'whoami'],
    kind: 'read',
    inputSchema: {},
    run: (ctx) => currentAccount(ctx.jira()),
  }),
  tool({
    name: 'jira_user_search',
    title: 'Jira: search users',
    description: 'Find Jira users by name or email. Returns account ids, which assignee and mention inputs need.',
    command: ['atlassian', 'jira', 'user', 'search'],
    kind: 'read',
    inputSchema: {
      query: z.string().describe('Name or email to search for.'),
      limit: limit(20, 'users'),
    },
    run: (ctx, input) => ctx.jira().searchUsers(input.query, input.limit ?? 20),
  }),
  tool({
    name: 'jira_user_view',
    title: 'Jira: view a user',
    description: 'Show one Jira user by account id (Cloud) or username (Server/Data Center).',
    command: ['atlassian', 'jira', 'user', 'view'],
    kind: 'read',
    inputSchema: {
      account: z.string().describe('Account id on Cloud, or username on Server/Data Center.'),
    },
    run: (ctx, input) => ctx.jira().getUser(input.account),
  }),
  tool({
    name: 'jira_open',
    title: 'Jira: browser URL for an issue or project',
    description:
      'Return the browser URL for an issue key or project key, for handing to a person. ' +
      'Nothing is opened; the CLI command of the same name launches a browser, a server cannot.',
    command: ['atlassian', 'jira', 'open'],
    kind: 'read',
    inputSchema: { target: z.string().describe('Jira issue key or project key.') },
    run: (ctx, input) => Promise.resolve({ url: jiraTargetUrl(ctx.jiraConfig().url, input.target) }),
  }),

  // --- Jira: issues ---
  tool({
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
    run: (ctx, input) => ctx.jira().searchAllIssues({ jql: input.jql, fields: input.fields }, input.limit ?? 50),
  }),
  tool({
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
    run: (ctx, input) => ctx.jira().getIssue(input.issue, { fields: input.fields, expand: input.expand?.join(',') }),
  }),
  tool({
    name: 'jira_issue_history',
    title: 'Jira: issue change history',
    description:
      'List who changed which fields on an issue, when, and the previous and new values, as raw ' +
      'changelog entries oldest first. "complete": false means Jira could not retrieve every entry.',
    command: ['atlassian', 'jira', 'issue', 'history'],
    kind: 'read',
    inputSchema: {
      issue: issueKey,
      limit: limit(50, 'history entries'),
      field: z.string().optional().describe('Only entries that changed this field, case-insensitively.'),
    },
    run: async (ctx, input) =>
      changelogJson(filterChangelog(await ctx.jira().getAllChangelog(input.issue, input.limit ?? 50), input.field)),
  }),
  tool({
    name: 'jira_issue_transitions',
    title: 'Jira: list available transitions',
    description:
      'List the workflow transitions an issue can take right now, with their ids and names. ' +
      'Call this before jira_issue_transition when you are not sure of the transition name.',
    command: ['atlassian', 'jira', 'issue', 'transitions'],
    kind: 'read',
    inputSchema: { issue: issueKey },
    run: (ctx, input) => ctx.jira().getTransitions(input.issue),
  }),
  tool({
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
    run: async (ctx, input) => {
      const client = ctx.jira();
      const request = buildCreateIssueBody(client, input);
      return input.dryRun === true ? request : client.createIssue(request);
    },
  }),
  tool({
    name: 'jira_issue_update',
    title: 'Jira: update an issue',
    description:
      'Change fields on an existing issue. Only the properties you pass are changed; "labels" ' +
      'replaces the whole label set. The issue is re-read afterwards and returned unless verify ' +
      'is false. Use dryRun to preview.',
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
    run: async (ctx, input) => {
      const client = ctx.jira();
      const request = buildUpdateIssueBody(client, input.issue, input);
      if (input.dryRun === true) return request;
      await client.updateIssue(input.issue, request);
      if (input.verify === false) return { issue: input.issue, updated: true };
      const readBack = await readBackIssue(client, input.issue);
      return readBack.ok ? readBack.issue : { issue: input.issue, updated: true, verified: false };
    },
  }),
  tool({
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
    run: async (ctx, input) => {
      const client = ctx.jira();
      const id = await resolveTransitionId(client, input.issue, input.transition, { byName: input.byName });
      const request = buildTransitionBody(client, id, { body: input.body, comment: input.comment });
      if (input.dryRun === true) return request;
      await client.transitionIssue(input.issue, request);
      return { issue: input.issue, transition: id, transitioned: true };
    },
  }),
  tool({
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
    run: (ctx, input) => deleteIssue(ctx.jira(), input),
  }),

  // --- Jira: comments ---
  tool({
    name: 'jira_issue_comment_list',
    title: 'Jira: list comments',
    description: 'List the comments on an issue, newest last, with their ids.',
    command: ['atlassian', 'jira', 'issue', 'comment', 'list'],
    kind: 'read',
    inputSchema: { issue: issueKey, limit: limit(25, 'comments') },
    run: (ctx, input) => ctx.jira().getComments(input.issue, { maxResults: input.limit ?? 25 }),
  }),
  tool({
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
    run: async (ctx, input) => {
      const client = ctx.jira();
      const request = await buildCommentBody(client, input.issue, input);
      return input.dryRun === true ? request : client.addComment(input.issue, request);
    },
  }),
  tool({
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
    run: async (ctx, input) => {
      const client = ctx.jira();
      const request = await buildCommentEditBody(client, input.comment, input);
      return input.dryRun === true ? request : client.updateComment(input.issue, input.comment, request);
    },
  }),
  tool({
    name: 'jira_issue_comment_delete',
    title: 'Jira: delete a comment',
    description:
      'Permanently delete a comment. Irreversible: requires confirm: true. Use dryRun to see ' +
      'what would be deleted.',
    command: ['atlassian', 'jira', 'issue', 'comment', 'delete'],
    kind: 'destructive',
    inputSchema: { issue: issueKey, comment: commentId, ...DESTRUCTIVE_SHAPE },
    run: (ctx, input) => deleteComment(ctx.jira(), input),
  }),

  // --- Jira: issue links ---
  tool({
    name: 'jira_issue_link_list',
    title: 'Jira: list issue links',
    description:
      "Fetch an issue's links (its issuelinks field), each carrying the link id, its type with both " +
      'phrases, and the issue at the other end.',
    command: ['atlassian', 'jira', 'issue', 'link', 'list'],
    kind: 'read',
    inputSchema: { issue: issueKey },
    run: (ctx, input) => ctx.jira().getIssue(input.issue, { fields: ['issuelinks'] }),
  }),
  tool({
    name: 'jira_issue_link_types',
    title: 'Jira: list link types',
    description:
      'List the link types this instance allows, with their outward and inward phrases ' +
      '(for example "blocks" / "is blocked by").',
    command: ['atlassian', 'jira', 'issue', 'link', 'types'],
    kind: 'read',
    inputSchema: {},
    run: (ctx) => ctx.jira().getLinkTypes(),
  }),
  tool({
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
    run: async (ctx, input) => {
      const client = ctx.jira();
      const { body: request, resolved } = await buildIssueLinkBody(
        client,
        input.from,
        input.type,
        input.to,
        input.comment,
      );
      if (input.dryRun === true) return request;
      await client.createIssueLink(request);
      return issueLinkCreated(input.from, input.to, resolved);
    },
  }),
  tool({
    name: 'jira_issue_link_delete',
    title: 'Jira: remove an issue link',
    description:
      'Remove a link between two issues by link id (see jira_issue_link_list). The result names ' +
      'the relationship that was removed. Use dryRun to preview.',
    command: ['atlassian', 'jira', 'issue', 'link', 'delete'],
    kind: 'write',
    inputSchema: {
      linkId: z.string().describe('Link id, as shown by jira_issue_link_list.'),
      ...WRITE_SHAPE,
    },
    run: (ctx, input) => deleteIssueLink(ctx.jira(), input.linkId, { dryRun: input.dryRun }),
  }),

  // --- Jira: agile boards and sprints ---
  tool({
    name: 'jira_board_list',
    title: 'Jira: list boards',
    description: 'List the agile boards visible to the current user, optionally filtered by project or type.',
    command: ['atlassian', 'jira', 'board', 'list'],
    kind: 'read',
    inputSchema: {
      project: z.string().optional().describe('Filter by project key or id.'),
      type: z.string().optional().describe('Filter by board type: scrum or kanban.'),
      limit: limit(50, 'boards'),
    },
    run: (ctx, input) =>
      ctx.jira().getBoards({
        projectKeyOrId: input.project,
        type: input.type,
        maxResults: input.limit ?? 50,
        limit: input.limit ?? 50,
      }),
  }),
  tool({
    name: 'jira_sprint_list',
    title: 'Jira: list sprints',
    description:
      "List a board's sprints by numeric board id (see jira_board_list). Board names are not " +
      'resolved. Defaults to active and future sprints.',
    command: ['atlassian', 'jira', 'sprint', 'list'],
    kind: 'read',
    inputSchema: {
      board: z.string().describe('Numeric agile board id.'),
      state: z.string().optional().describe('Sprint states as CSV: active, future, closed. Defaults to active,future.'),
      limit: limit(50, 'sprints'),
    },
    run: (ctx, input) =>
      ctx.jira().getSprints(numericId('Board', input.board), {
        state: input.state ?? 'active,future',
        maxResults: input.limit ?? 50,
        limit: input.limit ?? 50,
      }),
  }),
  tool({
    name: 'jira_sprint_issues',
    title: 'Jira: list sprint issues',
    description: 'List the issues in a sprint by numeric sprint id. Pass "fields" to keep the payload small.',
    command: ['atlassian', 'jira', 'sprint', 'issues'],
    kind: 'read',
    inputSchema: {
      sprint: z.string().describe('Numeric sprint id.'),
      fields,
      limit: limit(50, 'issues'),
    },
    run: (ctx, input) =>
      ctx.jira().getSprintIssues(numericId('Sprint', input.sprint), {
        fields: input.fields,
        maxResults: input.limit ?? 50,
        limit: input.limit ?? 50,
      }),
  }),
  tool({
    name: 'jira_sprint_add',
    title: 'Jira: add issues to a sprint',
    description:
      'Move existing issues into a sprint by numeric sprint id. Reversible, so no confirm is ' +
      'needed. Large lists are sent in chunks of 50. Use dryRun to preview.',
    command: ['atlassian', 'jira', 'sprint', 'add'],
    kind: 'write',
    inputSchema: {
      sprint: z.string().describe('Numeric sprint id.'),
      issues: z.array(z.string()).min(1).describe('Issue keys to move.'),
      ...WRITE_SHAPE,
    },
    run: (ctx, input) => addIssuesToSprint(ctx.jira(), input.sprint, input.issues, { dryRun: input.dryRun }),
  }),

  // --- Confluence: pages ---
  tool({
    name: 'confluence_open',
    title: 'Confluence: browser URL for a page',
    description:
      'Return the browser URL for a page id or page URL, for handing to a person. Nothing is ' +
      'opened; the CLI command of the same name launches a browser, a server cannot.',
    command: ['atlassian', 'confluence', 'open'],
    kind: 'read',
    inputSchema: { page: pageRef },
    run: (ctx, input) => Promise.resolve({ url: pageUrl(ctx.confluenceConfig().url, pageIdFromInput(input.page)) }),
  }),
  tool({
    name: 'confluence_page_get',
    title: 'Confluence: get a page',
    description:
      'Fetch a page by id or URL as the raw API payload, including its stored body (storage-format ' +
      'XHTML) unless bodyFormat is "none".',
    command: ['atlassian', 'confluence', 'page', 'get'],
    kind: 'read',
    inputSchema: {
      page: pageRef,
      bodyFormat: z
        .enum(BODY_FORMATS)
        .optional()
        .describe('Whether to request the body. "none" skips it entirely; the other values fetch it.'),
      expand: z.array(z.string()).optional().describe('Confluence expansions, replacing the default set.'),
    },
    run: (ctx, input) =>
      ctx
        .confluence()
        .getPage(pageIdFromInput(input.page), { expand: pageExpand(input.bodyFormat ?? 'markdown', input.expand) }),
  }),
  tool({
    name: 'confluence_page_search',
    title: 'Confluence: search pages',
    description: 'Search Confluence content with CQL, for example \'text ~ "release notes" AND space = DOCS\'.',
    command: ['atlassian', 'confluence', 'page', 'search'],
    kind: 'read',
    inputSchema: {
      cql: z.string().describe('CQL query to run.'),
      limit: limit(25, 'results across all pages'),
    },
    run: (ctx, input) => ctx.confluence().searchAllPages(input.cql, input.limit ?? 25),
  }),
  tool({
    name: 'confluence_page_children',
    title: 'Confluence: list child pages',
    description: 'List the direct child pages of a page.',
    command: ['atlassian', 'confluence', 'page', 'children'],
    kind: 'read',
    inputSchema: { page: pageRef, limit: limit(25, 'children') },
    run: (ctx, input) => ctx.confluence().getPageChildren(pageIdFromInput(input.page), { limit: input.limit ?? 25 }),
  }),
  tool({
    name: 'confluence_page_create',
    title: 'Confluence: create a page',
    description:
      'Create a page in a space. "text" is plain prose (escaped, paragraphs); "body" is raw ' +
      'storage-format XHTML. Pass "parent" to place it under another page. Use dryRun to preview.',
    command: ['atlassian', 'confluence', 'page', 'create'],
    kind: 'write',
    inputSchema: {
      space: z.string().describe('Space key the page belongs to.'),
      title: z.string().describe('Page title.'),
      parent: z.string().optional().describe('Parent page id or URL; without it the page lands at the space root.'),
      text: storageText,
      body: storageBody,
      markdown: storageMarkdown,
      ...WRITE_SHAPE,
    },
    run: (ctx, input) => {
      const client = ctx.confluence();
      const request = buildPageCreateBody(input, ctx.confluenceConfig().url);
      return input.dryRun === true ? Promise.resolve(request) : client.createContent(request);
    },
  }),
  tool({
    name: 'confluence_page_update',
    title: 'Confluence: update a page',
    description:
      "Replace a page's body or title, or add to it with append. The version is handled for you: " +
      'the page is read and the ' +
      'next version sent, and a conflicting edit by someone else fails rather than overwriting ' +
      'their work. Use dryRun to preview.',
    command: ['atlassian', 'confluence', 'page', 'update'],
    kind: 'write',
    inputSchema: {
      page: pageRef,
      title: z.string().optional().describe("New title. Defaults to the page's current title."),
      text: storageText,
      body: storageBody,
      markdown: storageMarkdown,
      append: z
        .boolean()
        .optional()
        .describe(
          'Add the new body to the end of the page instead of replacing it. Use this to add a ' +
            'section to an existing page — without it the whole body is replaced.',
        ),
      ...WRITE_SHAPE,
    },
    run: async (ctx, input) => {
      const client = ctx.confluence();
      const pageId = pageIdForInstance(input.page, ctx.confluenceConfig().url);
      const plan = await preparePageUpdate(client, pageId, input);
      return input.dryRun === true ? plan.payload : updatePage(client, plan);
    },
  }),
  tool({
    name: 'confluence_page_delete',
    title: 'Confluence: trash or destroy a page',
    description:
      'Move a page to the space trash, which is reversible and needs no confirm. With purge: true ' +
      'the page is destroyed permanently, which requires confirm: true. Use dryRun to preview.',
    command: ['atlassian', 'confluence', 'page', 'delete'],
    kind: 'destructive',
    inputSchema: {
      page: pageRef,
      purge: z.boolean().optional().describe('Destroy the page permanently instead of trashing it. Requires confirm.'),
      ...DESTRUCTIVE_SHAPE,
    },
    requiresConfirm: (input) => input.purge === true,
    run: (ctx, input) => deletePage(ctx.confluence(), pageIdForInstance(input.page, ctx.confluenceConfig().url), input),
  }),
  tool({
    name: 'confluence_page_comment_list',
    title: 'Confluence: list page comments',
    description: 'List the comments on a page with their ids, bodies (storage-format XHTML), and authors.',
    command: ['atlassian', 'confluence', 'page', 'comment', 'list'],
    kind: 'read',
    inputSchema: { page: pageRef, limit: limit(25, 'comments') },
    run: (ctx, input) =>
      ctx
        .confluence()
        .getComments(pageIdForInstance(input.page, ctx.confluenceConfig().url), { limit: input.limit ?? 25 }),
  }),
  tool({
    name: 'confluence_page_comment_add',
    title: 'Confluence: comment on a page',
    description:
      'Add a comment to a page. "text" is plain prose (escaped, paragraphs); "body" is raw ' +
      'storage-format XHTML. Use dryRun to preview.',
    command: ['atlassian', 'confluence', 'page', 'comment', 'add'],
    kind: 'write',
    inputSchema: { page: pageRef, text: storageText, body: storageBody, markdown: storageMarkdown, ...WRITE_SHAPE },
    run: (ctx, input) => {
      const client = ctx.confluence();
      const request = buildPageCommentBody(pageIdForInstance(input.page, ctx.confluenceConfig().url), input);
      return input.dryRun === true ? Promise.resolve(request) : client.createContent(request);
    },
  }),
  tool({
    name: 'jira_projects',
    title: 'Jira: list projects',
    description:
      'List the projects visible to the current user. The key is what every other Jira tool ' +
      'takes, so start here when you do not already have one.',
    command: ['atlassian', 'jira', 'projects'],
    kind: 'read',
    inputSchema: { limit: limit(25, 'projects') },
    run: (ctx, input) => ctx.jira().getProjects({ maxResults: input.limit ?? 25 }),
  }),
  tool({
    name: 'jira_fields',
    title: 'Jira: list fields',
    description:
      'List Jira fields, including custom field ids. Use this before setting a field through a ' +
      'raw body: a custom field is addressed as customfield_NNNNN, the number differs between ' +
      'instances, and it cannot be guessed. search matches the name or the id, so it answers ' +
      'both "what is Story Points called here" and "what is customfield_10016".',
    command: ['atlassian', 'jira', 'fields'],
    kind: 'read',
    inputSchema: {
      custom: z.boolean().optional().describe('Only custom fields.'),
      search: z.string().optional().describe('Match the field name or id, case-insensitively.'),
    },
    run: (ctx, input) => listFields(ctx.jira(), { custom: input.custom, search: input.search }),
  }),
  tool({
    name: 'jira_project_versions',
    title: "Jira: list a project's versions",
    description: "List a project's versions (releases). The id is what sets fixVersions on an issue.",
    command: ['atlassian', 'jira', 'project', 'versions'],
    kind: 'read',
    inputSchema: { project: z.string().describe('Project key, for example PROJ.') },
    run: (ctx, input) => ctx.jira().getProjectVersions(input.project),
  }),
  tool({
    name: 'jira_sprint_create',
    title: 'Jira: create a sprint',
    description:
      'Create a sprint on a board. The board is a numeric id — names are not resolved, because a ' +
      'board name is neither unique nor stable; use jira_board_list first. Dates are ISO-8601.',
    command: ['atlassian', 'jira', 'sprint', 'create'],
    kind: 'write',
    inputSchema: {
      board: z.string().describe('Board id, numeric.'),
      name: z.string().describe('Sprint name.'),
      goal: z.string().optional().describe('Sprint goal.'),
      start: z.string().optional().describe('Start date, ISO-8601.'),
      end: z.string().optional().describe('End date, ISO-8601.'),
      ...WRITE_SHAPE,
    },
    run: (ctx, input) => {
      const request = buildSprintCreateBody(numericId('Board', input.board), input);
      return input.dryRun === true ? Promise.resolve(request) : ctx.jira().createSprint(request);
    },
  }),
  tool({
    name: 'jira_sprint_update',
    title: 'Jira: update a sprint',
    description:
      "Change a sprint's name, dates, goal, or state. Jira treats an update as a full " +
      'replacement and clears what the request omits, so the sprint is read first and your ' +
      'changes applied on top. state "closed" ends a sprint, and is reversible.',
    command: ['atlassian', 'jira', 'sprint', 'update'],
    kind: 'write',
    inputSchema: {
      sprint: z.string().describe('Sprint id, numeric.'),
      name: z.string().optional().describe('New sprint name.'),
      goal: z.string().optional().describe('New sprint goal.'),
      start: z.string().optional().describe('Start date, ISO-8601.'),
      end: z.string().optional().describe('End date, ISO-8601.'),
      state: z.enum(['future', 'active', 'closed']).optional().describe('Sprint state.'),
      ...WRITE_SHAPE,
    },
    run: async (ctx, input) => {
      const client = ctx.jira();
      const sprintId = numericId('Sprint', input.sprint);
      const request = await prepareSprintUpdate(client, sprintId, input);
      return input.dryRun === true ? request : client.updateSprint(sprintId, request);
    },
  }),
  tool({
    name: 'jira_issue_remotelink_list',
    title: "Jira: list an issue's links outside Jira",
    description:
      "List an issue's remote links — anything with a URL, most usefully the Confluence page it " +
      'came from. Different from jira_issue_link_list, which only joins two Jira issues.',
    command: ['atlassian', 'jira', 'issue', 'remotelink', 'list'],
    kind: 'read',
    inputSchema: { issue: issueKey },
    run: async (ctx, input) => {
      const links = (await ctx.jira().getRemoteLinks(input.issue)) as RemoteLink[];
      return Array.isArray(links) ? links.map((link) => describeRemoteLink(link)) : links;
    },
  }),
  tool({
    name: 'jira_issue_remotelink_create',
    title: 'Jira: link an issue to something outside Jira',
    description:
      'Link an issue to a URL — most usefully the Confluence page it came from. This is the ' +
      'direction that makes the relationship visible from the issue: writing a hyperlink into a ' +
      'page body only links one way and Jira cannot see it. Re-running with the same URL updates ' +
      'the existing link rather than adding a duplicate.',
    command: ['atlassian', 'jira', 'issue', 'remotelink', 'create'],
    kind: 'write',
    inputSchema: {
      issue: issueKey,
      url: z.string().describe('Absolute http or https URL to link to.'),
      title: z.string().optional().describe('Link text. Defaults to the URL.'),
      summary: z.string().optional().describe('A line of description shown under the link.'),
      relationship: z
        .string()
        .optional()
        .describe('How the issue relates to the target, e.g. "documented by". Jira groups links under this.'),
      ...WRITE_SHAPE,
    },
    run: (ctx, input) => {
      const request = buildRemoteLinkBody(input);
      return input.dryRun === true ? Promise.resolve(request) : ctx.jira().createRemoteLink(input.issue, request);
    },
  }),
  tool({
    name: 'jira_issue_remotelink_delete',
    title: 'Jira: remove a remote link',
    description:
      'Remove a remote link from an issue. The id comes from jira_issue_remotelink_list. No ' +
      'confirm needed: the link holds no content and is re-creatable from its URL.',
    command: ['atlassian', 'jira', 'issue', 'remotelink', 'delete'],
    kind: 'write',
    inputSchema: {
      issue: issueKey,
      linkId: z.string().describe('Remote link id, numeric.'),
      ...WRITE_SHAPE,
    },
    run: async (ctx, input) => {
      if (input.dryRun === true) return { issue: input.issue, linkId: input.linkId, deleted: false };
      await ctx.jira().deleteRemoteLink(input.issue, input.linkId);
      return { issue: input.issue, linkId: input.linkId, deleted: true };
    },
  }),
  tool({
    name: 'confluence_page_label_list',
    title: "Confluence: list a page's labels",
    description:
      "List a page's labels. Confluence namespaces labels, so the prefix is part of the identity " +
      'and two different labels can share a name.',
    command: ['atlassian', 'confluence', 'page', 'label', 'list'],
    kind: 'read',
    inputSchema: { page: pageRef, limit: limit(25, 'labels') },
    run: (ctx, input) =>
      ctx
        .confluence()
        .getLabels(pageIdForInstance(input.page, ctx.confluenceConfig().url), { limit: input.limit ?? 25 }),
  }),
  tool({
    name: 'confluence_page_label_add',
    title: 'Confluence: add labels to a page',
    description:
      'Add one or more labels to a page. Additive and idempotent: a label the page already ' +
      'carries is accepted rather than an error, and the response is the full label set.',
    command: ['atlassian', 'confluence', 'page', 'label', 'add'],
    kind: 'write',
    inputSchema: {
      page: pageRef,
      labels: z.array(z.string()).min(1).describe('Labels to add.'),
      prefix: z.string().optional().describe('Label namespace; global is what the UI applies.'),
      ...WRITE_SHAPE,
    },
    run: (ctx, input) => {
      const client = ctx.confluence();
      const pageId = pageIdForInstance(input.page, ctx.confluenceConfig().url);
      const request = input.labels.map((name) => ({ prefix: input.prefix ?? 'global', name }));
      return input.dryRun === true ? Promise.resolve(request) : client.addLabels(pageId, request);
    },
  }),
];
