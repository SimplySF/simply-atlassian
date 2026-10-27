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

import { createHash } from 'node:crypto';
import { issueUrl, pageIdForInstance } from './atlassian-url.js';
import type { ConfluenceClient } from './confluence-client.js';
import { webUrl, type ConfluencePageSummary } from './confluence-pages.js';
import { CliError, ConfigError, HttpError, ReadRequiredError, StaleError } from './errors.js';
import { assertIssueKey } from './jira-issues.js';
import type { JiraClient } from './jira-client.js';
import { buildRemoteLinkBody, type RemoteLink } from './jira-remote-links.js';
import { parseMarkdown, type MdInline } from './markdown-ast.js';
import { markdownToStorage } from './markdown-storage.js';
import { storageToMarkdownReading } from './storage-reading.js';
import { lineDiff } from './text-diff.js';
import { workValueProblem, type WorkConfig, type WorkFieldSpec, type WorkSectionSpec } from './work-config.js';
import { decodeWorkField, encodeWorkField, isEmptyValue, resolveWorkUser, type DecodedField } from './work-fields.js';

/**
 * A work item is a pair: one Jira issue, and at most one Confluence page linked to it. These are
 * the operations `jira work get` / `save` and the `jira_work_*` tools run. See design 0020.
 *
 * Four rules hold everywhere in this file:
 *
 * **The issue is the table of contents.** Its page is the one its remote links point at, the same
 * link Jira shows and a person can add or remove in Jira. Of those links, only a page in the
 * configured space carrying the configured labels is the design page; the others are context.
 * Nothing is ever paired from the page side.
 *
 * **The project config is the whole contract.** Only configured fields are read or written, and
 * every value is checked against its spec before anything is sent.
 *
 * **Every update builds on a read.** An update must carry the revision `getWorkItem` returned;
 * without one it is refused, and if the issue or page changed since, it is refused with the
 * current content so the caller can merge rather than overwrite.
 *
 * **Status is never touched.** It belongs to the team's own process, which runs outside agents.
 */

/**
 * The relationship on the remote link `saveWorkItem` adds from an issue to its page: the label Jira
 * itself gives a link to a Confluence page. Only a label; the page is found by following any of the
 * issue's remote links to the configured Confluence, whoever made them.
 */
export const WORK_PAGE_RELATIONSHIP = 'Wiki Page';

export interface WorkContext {
  readonly config: WorkConfig;
  readonly jira: JiraClient;
  /** The Jira base URL, for browse links. */
  readonly jiraUrl: string;
  /** Built on demand, so a project with no page half never needs Confluence settings. */
  readonly confluence: () => { readonly client: ConfluenceClient; readonly url: string };
}

export interface WorkItemRef {
  readonly issue?: string;
  readonly page?: string;
}

export interface WorkFieldView {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly always?: boolean;
  readonly default?: unknown;
  readonly allowed?: readonly string[];
  readonly value: unknown;
  readonly display?: string;
  /** Content the Markdown value cannot carry; saving this field replaces it. */
  readonly lossy?: readonly string[];
}

export interface WorkIssueView {
  readonly key?: string;
  readonly url?: string;
  /** Informational. These tools never change it. */
  readonly status?: string;
  readonly revision?: string;
  readonly fields: readonly WorkFieldView[];
}

export interface WorkPageView {
  readonly id?: string;
  readonly url?: string;
  readonly title?: string;
  readonly revision?: number;
  readonly markdown?: string;
  readonly lossy?: readonly string[];
  readonly when?: string;
  readonly sections: readonly WorkSectionSpec[];
}

/** A Confluence page the issue links to that is not its design page: context, never edited. */
export interface WorkLinkedPage {
  readonly id: string;
  readonly title?: string;
  readonly url?: string;
}

export interface WorkItemView {
  /** The config file the shape came from. */
  readonly config: string;
  readonly guidance?: string;
  readonly issue: WorkIssueView;
  /** Absent when the project config has no Confluence half. */
  readonly page?: WorkPageView;
  readonly links: {
    readonly paired: boolean;
    /** The issue's other Confluence links: pages outside the configured space or without its labels. */
    readonly other: readonly WorkLinkedPage[];
  };
  /** Required fields that are empty and required page headings that are missing. */
  readonly missingRequired: readonly string[];
}

export interface WorkIssueInput {
  readonly key?: string;
  readonly basedOn?: string;
  /** Values by configured field name. Omitted fields keep their current values. */
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface WorkPageInput {
  readonly id?: string;
  readonly basedOn?: number;
  /** The whole page body, as Markdown. */
  readonly markdown?: string;
  readonly title?: string;
}

export interface WorkSaveInput {
  readonly issue?: WorkIssueInput;
  readonly page?: WorkPageInput;
  /** Save over content the Markdown reading could not carry (macros, mentions…), dropping it. */
  readonly acceptLoss?: boolean;
  readonly dryRun?: boolean;
}

/** Something the server changed relative to what the caller sent, so it can be reported. */
export interface WorkAdjustment {
  readonly field: string;
  readonly reason: 'always' | 'default';
  readonly value: unknown;
}

type SaveAction = 'create' | 'update' | 'none';

export interface WorkSaveResult {
  readonly saved: { readonly issue?: SaveAction; readonly page?: SaveAction; readonly linked: boolean };
  readonly adjusted: readonly WorkAdjustment[];
  /** The pair as it now stands, with the revisions to base the next save on. */
  readonly item: WorkItemView;
}

export interface WorkDryRunResult {
  readonly dryRun: true;
  readonly issue?: { readonly action: SaveAction; readonly request?: unknown; readonly diff: string };
  readonly page?: { readonly action: SaveAction; readonly request?: unknown; readonly diff: string };
  readonly links: readonly string[];
  readonly adjusted: readonly WorkAdjustment[];
}

// --- Reading ---

interface IssueState {
  readonly key: string;
  readonly url: string;
  readonly status?: string;
  readonly values: ReadonlyMap<string, DecodedField>;
  readonly revision: string;
}

interface PageState {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly version: number;
  /** The body after the issue header line, as stored. */
  readonly body: string;
  readonly markdown: string;
  readonly lossy: readonly string[];
  /** The issue the page's header line names, kept when the page is rewritten. Never used to pair. */
  readonly headerKey?: string;
  /** Absent when the instance did not report it. */
  readonly space?: string;
  readonly labels: readonly string[];
}

/** The issue's Confluence links, sorted by whether the config says each is the design page. */
interface LinkedPages {
  /** Every page the issue links to on the configured Confluence. */
  readonly ids: readonly string[];
  /** Those in the configured space carrying every configured label: candidates for the page. */
  readonly design: readonly string[];
  readonly other: readonly WorkLinkedPage[];
}

const NO_LINKS: LinkedPages = { ids: [], design: [], other: [] };

/**
 * Reads a work item. Given an issue, its page is the design page its remote links point at, or
 * `ref.page` when it links to several. A page given alone is read alone: no issue is looked up from it.
 */
export async function getWorkItem(ctx: WorkContext, ref: WorkItemRef = {}): Promise<WorkItemView> {
  if (ref.page !== undefined && ctx.config.confluence === undefined) {
    throw new ConfigError(
      `This project's config (${ctx.config.source}) has no confluence section, so there is no page to read.`,
    );
  }
  const issue = ref.issue === undefined ? undefined : await readIssue(ctx, assertIssueKey(ref.issue.trim()));
  let linked = NO_LINKS;
  if (issue !== undefined && ctx.config.confluence !== undefined) linked = await linkedPages(ctx, issue.key);

  let pageId = ref.page === undefined ? undefined : pageIdForInstance(ref.page, ctx.confluence().url);
  if (pageId === undefined && issue !== undefined) pageId = choosePage(issue.key, linked);
  const page = pageId === undefined ? undefined : await readPage(ctx, pageId);
  return itemView(ctx, issue, page, linked);
}

async function readIssue(ctx: WorkContext, key: string): Promise<IssueState> {
  const keys = [...new Set([...ctx.config.jira.fields.map((field) => field.key), 'issuetype', 'status'])];
  const raw = (await ctx.jira.getIssue(key, { fields: keys })) as { key?: string; fields?: Record<string, unknown> };
  const fields = raw.fields ?? {};
  const type = (fields.issuetype as { name?: unknown } | undefined)?.name;
  const expected = ctx.config.jira.issueType;
  if (typeof type === 'string' && type.toLowerCase() !== expected.toLowerCase()) {
    throw new ConfigError(
      `${key} is a ${type}, but this project's work items are ${expected} issues (${ctx.config.source}). ` +
        'Its fields may not match the config, so it is not read as one.',
    );
  }

  const values = new Map<string, DecodedField>();
  for (const spec of ctx.config.jira.fields) {
    values.set(spec.name, decodeWorkField(spec, fields[spec.key], ctx.jira.deployment));
  }
  const status = (fields.status as { name?: unknown } | undefined)?.name;
  const resolvedKey = raw.key ?? key;
  return {
    key: resolvedKey,
    url: issueUrl(ctx.jiraUrl, resolvedKey),
    status: typeof status === 'string' ? status : undefined,
    values,
    revision: issueRevision(ctx.config, (name) => values.get(name)?.value),
  };
}

/**
 * An issue's revision: a hash of its configured fields' values, not Jira's `updated` timestamp.
 * The issue moves through the team's workflow outside the agent, and a status change, comment or
 * sprint move must not make the next save stale — only a change to the content the project
 * configured does.
 */
function issueRevision(config: WorkConfig, valueOf: (name: string) => unknown): string {
  const content = JSON.stringify(config.jira.fields.map((field) => [field.name, valueOf(field.name) ?? null]));
  return `sha256:${createHash('sha256').update(content).digest('hex').slice(0, 32)}`;
}

async function readPage(ctx: WorkContext, pageId: string): Promise<PageState> {
  const { client, url } = ctx.confluence();
  const raw = (await client.getPage(pageId, {
    expand: ['body.storage', 'version', 'space', 'metadata.labels'],
  })) as ConfluencePageSummary & PageMeta;
  if (raw.type !== undefined && raw.type !== 'page') {
    throw new ConfigError(`${pageId} is a ${raw.type}, not a page.`);
  }
  const version = raw.version?.number;
  if (typeof version !== 'number') {
    throw new CliError(`The instance reported no version for page ${pageId}, so it cannot be edited safely.`);
  }
  const { key, body } = splitHeader(raw.body?.storage?.value ?? '');
  const reading = storageToMarkdownReading(body);
  return {
    id: pageId,
    title: raw.title ?? '',
    url: webUrl(raw) ?? pageUrlFallback(url, pageId),
    version,
    body,
    markdown: reading.markdown,
    lossy: reading.lossy,
    headerKey: key,
    ...pageMeta(raw),
  };
}

/** The parts of a page response that say whether it is a design page. */
interface PageMeta {
  readonly space?: { readonly key?: string };
  readonly metadata?: { readonly labels?: { readonly results?: ReadonlyArray<{ readonly name?: string }> } };
}

function pageMeta(raw: PageMeta): { space?: string; labels: string[] } {
  const labels = (raw.metadata?.labels?.results ?? []).flatMap((label) =>
    typeof label.name === 'string' ? [label.name] : [],
  );
  return { ...(raw.space?.key === undefined ? {} : { space: raw.space.key }), labels };
}

/** A page the config's space and labels describe. An unreported space is not held against it. */
function isDesignPage(ctx: WorkContext, meta: { space?: string; labels: readonly string[] }): boolean {
  const confluence = ctx.config.confluence;
  if (confluence === undefined) return false;
  if (meta.space !== undefined && meta.space.toLowerCase() !== confluence.space.toLowerCase()) return false;
  return missingLabels(ctx, meta.labels).length === 0;
}

function missingLabels(ctx: WorkContext, labels: readonly string[]): string[] {
  return (ctx.config.confluence?.labels ?? []).filter((label) => !labels.includes(label));
}

function pageUrlFallback(baseUrl: string, pageId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
}

/**
 * The pages an issue's remote links point at on the configured Confluence, whoever added them —
 * a link made in Jira counts the same as one `saveWorkItem` made — sorted into design pages and
 * the rest. A linked page that cannot be read is never the design page.
 */
async function linkedPages(ctx: WorkContext, issueKey: string): Promise<LinkedPages> {
  const links = (await ctx.jira.getRemoteLinks(issueKey)) as RemoteLink[];
  const { client, url: confluenceUrl } = ctx.confluence();
  const targets = new Map<string, WorkLinkedPage>();
  for (const link of Array.isArray(links) ? links : []) {
    const target = link.object?.url;
    if (target === undefined) continue;
    try {
      const id = pageIdForInstance(target, confluenceUrl);
      if (!targets.has(id)) targets.set(id, { id, title: link.object?.title, url: target });
    } catch {
      continue;
    }
  }

  const sorted = await Promise.all(
    [...targets.values()].map(async (target) => {
      try {
        const raw = (await client.getPage(target.id, { expand: ['space', 'metadata.labels'] })) as PageMeta & {
          type?: string;
          title?: string;
        };
        const design = (raw.type === undefined || raw.type === 'page') && isDesignPage(ctx, pageMeta(raw));
        return { design, page: { ...target, ...(raw.title === undefined ? {} : { title: raw.title }) } };
      } catch {
        return { design: false, page: target };
      }
    }),
  );
  return {
    ids: [...targets.keys()],
    design: sorted.filter((entry) => entry.design).map((entry) => entry.page.id),
    other: sorted.filter((entry) => !entry.design).map((entry) => entry.page),
  };
}

/**
 * Picks the issue's page: its only linked design page. Several is refused rather than guessed,
 * since a guess means the next save edits the wrong document.
 */
function choosePage(issueKey: string, linked: LinkedPages): string | undefined {
  if (linked.design.length <= 1) return linked.design[0];
  throw new ConfigError(
    `${issueKey} links to more than one design page (${linked.design.join(', ')}). Pass the page id to choose one.`,
  );
}

function isLinked(linked: LinkedPages, pageId: string): boolean {
  return linked.ids.includes(pageId);
}

const HEADER =
  /^\s*<p>\s*<strong>\s*Jira:\s*<\/strong>\s*<a\s[^>]*href="[^"]*\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)"[^>]*>[^<]*<\/a>\s*<\/p>/;

/**
 * Separates the issue line `saveWorkItem` puts at the top of a page from the page's own content.
 * The line is for people reading the page; the pair is decided by the issue's links alone.
 */
function splitHeader(storage: string): { key?: string; body: string } {
  const match = HEADER.exec(storage);
  if (match === null) return { body: storage };
  return { key: match[1], body: storage.slice(match[0].length) };
}

function header(issueKey: string, url: string): string {
  return markdownToStorage(`**Jira:** [${issueKey}](${url})`);
}

function itemView(
  ctx: WorkContext,
  issue: IssueState | undefined,
  page: PageState | undefined,
  linked: LinkedPages,
): WorkItemView {
  const { config } = ctx;
  const missing: string[] = [];
  const fields = config.jira.fields.map((spec) => {
    const decoded = issue?.values.get(spec.name);
    if (issue !== undefined && spec.required === true && isEmptyValue(decoded?.value))
      missing.push(`issue: ${spec.name}`);
    return fieldView(spec, decoded);
  });
  if (page !== undefined) {
    for (const heading of missingHeadings(config.confluence?.sections ?? [], page.markdown))
      missing.push(`page: ${heading}`);
  }

  const pageView: WorkPageView | undefined =
    config.confluence === undefined
      ? undefined
      : {
          ...(page === undefined
            ? {}
            : {
                id: page.id,
                url: page.url,
                title: page.title,
                revision: page.version,
                markdown: page.markdown,
                ...(page.lossy.length > 0 ? { lossy: page.lossy } : {}),
              }),
          when: config.confluence.when,
          sections: config.confluence.sections ?? [],
        };

  return {
    config: config.source,
    guidance: config.guidance,
    issue: {
      ...(issue === undefined
        ? {}
        : { key: issue.key, url: issue.url, status: issue.status, revision: issue.revision }),
      fields,
    },
    ...(pageView === undefined ? {} : { page: pageView }),
    links: {
      paired: issue !== undefined && page !== undefined && isLinked(linked, page.id),
      other: linked.other.filter((other) => other.id !== page?.id),
    },
    missingRequired: missing,
  };
}

function fieldView(spec: WorkFieldSpec, decoded: DecodedField | undefined): WorkFieldView {
  return {
    name: spec.name,
    type: spec.type,
    ...(spec.description === undefined ? {} : { description: spec.description }),
    ...(spec.required === true ? { required: true } : {}),
    ...(spec.always === true ? { always: true } : {}),
    ...(spec.default === undefined ? {} : { default: spec.default }),
    ...(spec.allowed === undefined ? {} : { allowed: spec.allowed }),
    value: decoded?.value ?? (spec.always === true ? spec.value : null),
    ...(decoded?.display === undefined ? {} : { display: decoded.display }),
    ...(decoded !== undefined && decoded.lossy.length > 0 ? { lossy: decoded.lossy } : {}),
  };
}

/** Required section headings with no `#`–`######` heading of the same text in the Markdown. */
function missingHeadings(sections: readonly WorkSectionSpec[], markdown: string): string[] {
  const present = new Set(
    parseMarkdown(markdown)
      .filter((block) => block.type === 'heading')
      .map((block) => normalizeHeading(inlineText(block.type === 'heading' ? block.children : []))),
  );
  return sections
    .filter((section) => section.required === true && !present.has(normalizeHeading(section.heading)))
    .map((section) => section.heading);
}

function normalizeHeading(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim().toLowerCase();
}

function inlineText(nodes: readonly MdInline[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text' || node.type === 'code') return node.text;
      if (node.type === 'break') return ' ';
      return inlineText(node.children);
    })
    .join('');
}

// --- Saving ---

interface IssuePlan {
  readonly action: SaveAction;
  readonly current?: IssueState;
  readonly fields: Record<string, unknown>;
  readonly finalValues: ReadonlyMap<string, unknown>;
  readonly diff: string;
}

interface PagePlan {
  readonly action: SaveAction;
  readonly current?: PageState;
  readonly title: (issueKey: string | undefined) => string;
  /** The body below the header: converted Markdown, or the current storage when it is unchanged. */
  readonly body: string;
  readonly diff: string;
}

/**
 * Creates or updates either half of a work item and links the pair. Validates everything before
 * sending anything, and reports every problem at once.
 *
 * Writes go issue first, then page, then links, because a new page's title and header need the
 * issue key. A failure after the issue is written is reported as exactly that — what landed and
 * what did not — and nothing is rolled back: the next read starts from what is there.
 */
export async function saveWorkItem(ctx: WorkContext, input: WorkSaveInput): Promise<WorkSaveResult | WorkDryRunResult> {
  if (input.issue === undefined && input.page === undefined) {
    throw new ConfigError('Nothing to save. Pass issue, page, or both.');
  }
  if (input.page !== undefined && ctx.config.confluence === undefined) {
    throw new ConfigError(
      `This project's config (${ctx.config.source}) has no confluence section, so there is no page to save.`,
    );
  }

  const problems: string[] = [];
  const adjusted: WorkAdjustment[] = [];
  const issuePlan = input.issue === undefined ? undefined : await planIssue(ctx, input, problems, adjusted);

  // An issue that already has a page cannot be given a second one by omission of the id.
  const issueKey = issuePlan?.current?.key;
  let linked = NO_LINKS;
  if (issueKey !== undefined && ctx.config.confluence !== undefined) linked = await linkedPages(ctx, issueKey);
  const pagePlan = input.page === undefined ? undefined : await planPage(ctx, input, issuePlan, linked, problems);

  if (problems.length > 0) {
    throw new ConfigError(`Nothing was saved:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }

  if (input.dryRun === true) return dryRunResult(ctx, issuePlan, pagePlan, adjusted, linked);
  return executeSave(ctx, issuePlan, pagePlan, adjusted, linked);
}

async function planIssue(
  ctx: WorkContext,
  input: WorkSaveInput,
  problems: string[],
  adjusted: WorkAdjustment[],
): Promise<IssuePlan> {
  const issueInput = input.issue ?? {};
  const { config } = ctx;
  const current = await currentIssue(ctx, issueInput);
  const given = givenFields(config, issueInput.fields ?? {}, problems, adjusted);
  const finalValues = mergeIssueValues(config, current, given, problems, adjusted);
  if (input.acceptLoss !== true) checkIssueLoss(current, given, problems);
  await resolveUsers(ctx, given, finalValues, problems);

  const diff = lineDiff(
    issueText(config, (name) => current?.values.get(name)?.value ?? null),
    issueText(config, (name) => finalValues.get(name)),
  );
  if (current !== undefined && issueInput.basedOn !== current.revision) {
    throw new StaleError(
      `${current.key} changed after the read this save is based on. Nothing was saved. Merge the current ` +
        'fields (in details.issue) into your edit and save again with its revision as basedOn.',
      { issue: itemView(ctx, current, undefined, NO_LINKS).issue, diff },
    );
  }

  const fields = issueRequestFields(ctx, current, finalValues, problems);
  let action: SaveAction = 'none';
  if (current === undefined) action = 'create';
  else if (Object.keys(fields).length > 0) action = 'update';
  return { action, current, fields, finalValues, diff };
}

/** The issue being updated, read now; refused when the caller has not read it themselves. */
async function currentIssue(ctx: WorkContext, input: WorkIssueInput): Promise<IssueState | undefined> {
  if (input.key === undefined) return undefined;
  const current = await readIssue(ctx, assertIssueKey(input.key.trim()));
  if (input.basedOn === undefined) {
    throw new ReadRequiredError(
      `${current.key} already exists. Read it with jira_work_get first and pass its issue.revision as issue.basedOn, ` +
        'so this save builds on what is there now.',
    );
  }
  return current;
}

/** The caller's values by spec, each checked against its type and `allowed`. */
function givenFields(
  config: WorkConfig,
  fields: Readonly<Record<string, unknown>>,
  problems: string[],
  adjusted: WorkAdjustment[],
): Map<WorkFieldSpec, unknown> {
  const given = new Map<WorkFieldSpec, unknown>();
  for (const [name, value] of Object.entries(fields)) {
    const spec = findSpec(config, name);
    if (spec === undefined) {
      const known = config.jira.fields.map((field) => field.name).join(', ');
      problems.push(`issue.fields: "${name}" is not a configured field (${known})`);
      continue;
    }
    const problem = value === null ? undefined : workValueProblem(value, spec.type);
    if (problem !== undefined) problems.push(`issue.fields["${spec.name}"]: ${problem}`);
    else if (value !== null) checkAllowed(spec, value, problems);
    if (spec.always !== true) {
      given.set(spec, value);
    } else if (JSON.stringify(value) !== JSON.stringify(spec.value)) {
      adjusted.push({ field: spec.name, reason: 'always', value: spec.value });
    }
  }
  return given;
}

/** Exact name first, then case-insensitively: "acceptance criteria" means the configured field. */
function findSpec(config: WorkConfig, name: string): WorkFieldSpec | undefined {
  return (
    config.jira.fields.find((field) => field.name === name) ??
    config.jira.fields.find((field) => field.name.toLowerCase() === name.toLowerCase())
  );
}

/** Current values, overlaid with the caller's, then defaults on create and `always` values. */
function mergeIssueValues(
  config: WorkConfig,
  current: IssueState | undefined,
  given: ReadonlyMap<WorkFieldSpec, unknown>,
  problems: string[],
  adjusted: WorkAdjustment[],
): Map<string, unknown> {
  const finalValues = new Map<string, unknown>();
  for (const spec of config.jira.fields) {
    const before = current?.values.get(spec.name)?.value ?? null;
    let value: unknown = given.has(spec) ? given.get(spec) : before;
    if (current === undefined && !given.has(spec) && spec.default !== undefined) {
      value = spec.default;
      adjusted.push({ field: spec.name, reason: 'default', value });
    }
    if (spec.always === true) {
      const reported = adjusted.some((adjustment) => adjustment.field === spec.name);
      if (current !== undefined && !reported && JSON.stringify(before) !== JSON.stringify(spec.value)) {
        adjusted.push({ field: spec.name, reason: 'always', value: spec.value });
      }
      value = spec.value;
    }
    finalValues.set(spec.name, value);
    // Jira itself refuses an issue without a summary, so that one is required whatever the config says.
    const required = spec.required === true || (spec.key === 'summary' && current === undefined);
    if (required && isEmptyValue(value)) problems.push(`issue: "${spec.name}" is required`);
  }
  return finalValues;
}

/** Refuses to replace a field whose current value holds content Markdown cannot carry. */
function checkIssueLoss(
  current: IssueState | undefined,
  given: ReadonlyMap<WorkFieldSpec, unknown>,
  problems: string[],
): void {
  if (current === undefined) return;
  for (const [spec, value] of given) {
    const decoded = current.values.get(spec.name);
    const lossy = decoded?.lossy ?? [];
    if (lossy.length === 0 || JSON.stringify(value) === JSON.stringify(decoded?.value)) continue;
    problems.push(
      `issue.fields["${spec.name}"]: the current value holds ${lossy.join(', ')}, which Markdown cannot carry. ` +
        'Saving replaces them. Pass acceptLoss: true if that is intended, or make the edit in Jira.',
    );
  }
}

/** Resolves every `user` value the caller passed, in parallel, to the account Jira expects. */
async function resolveUsers(
  ctx: WorkContext,
  given: ReadonlyMap<WorkFieldSpec, unknown>,
  finalValues: Map<string, unknown>,
  problems: string[],
): Promise<void> {
  const users = [...given].filter(
    (entry): entry is [WorkFieldSpec, string] => entry[0].type === 'user' && typeof entry[1] === 'string',
  );
  const resolved = await Promise.allSettled(users.map(([spec, value]) => resolveWorkUser(ctx.jira, spec, value)));
  for (const [index, outcome] of resolved.entries()) {
    const spec = users[index]?.[0];
    if (spec === undefined) continue;
    if (outcome.status === 'fulfilled') finalValues.set(spec.name, outcome.value);
    else problems.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
  }
}

/** On create, every non-empty field; on update, only those whose encoded value would change. */
function issueRequestFields(
  ctx: WorkContext,
  current: IssueState | undefined,
  finalValues: ReadonlyMap<string, unknown>,
  problems: string[],
): Record<string, unknown> {
  const { config } = ctx;
  const fields: Record<string, unknown> =
    current === undefined ? { project: { key: config.jira.project }, issuetype: { name: config.jira.issueType } } : {};
  for (const spec of config.jira.fields) {
    const value = finalValues.get(spec.name);
    const encoded = safeEncode(spec, value, ctx, problems);
    if (current === undefined) {
      if (!isEmptyValue(value)) fields[spec.key] = encoded;
      continue;
    }
    const before = safeEncode(spec, current.values.get(spec.name)?.value ?? null, ctx, []);
    if (JSON.stringify(encoded) !== JSON.stringify(before)) fields[spec.key] = encoded;
  }
  return fields;
}

function checkAllowed(spec: WorkFieldSpec, value: unknown, problems: string[]): void {
  if (spec.allowed === undefined) return;
  const values = Array.isArray(value) ? value : [value];
  const outside = values.filter((item) => typeof item === 'string' && !(spec.allowed ?? []).includes(item));
  if (outside.length > 0) {
    problems.push(
      `issue.fields["${spec.name}"]: ${outside.join(', ')} is not allowed (${(spec.allowed ?? []).join(', ')})`,
    );
  }
}

/** Markdown that cannot be converted is a problem with this save, reported with the others. */
function safeEncode(spec: WorkFieldSpec, value: unknown, ctx: WorkContext, problems: string[]): unknown {
  try {
    return encodeWorkField(spec, value, ctx.jira.deployment);
  } catch (error) {
    problems.push(`issue.fields["${spec.name}"]: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** The issue's configured fields as one document, for diffs a person or agent can read. */
function issueText(config: WorkConfig, valueOf: (name: string) => unknown): string {
  return config.jira.fields
    .map((spec) => {
      const value = valueOf(spec.name);
      let text: string;
      if (isEmptyValue(value)) text = '(empty)';
      else if (typeof value === 'string') text = value;
      else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) text = value.join(', ');
      else text = JSON.stringify(value);
      return `## ${spec.name}\n${text}`;
    })
    .join('\n\n');
}

async function planPage(
  ctx: WorkContext,
  input: WorkSaveInput,
  issuePlan: IssuePlan | undefined,
  linked: LinkedPages,
  problems: string[],
): Promise<PagePlan> {
  const pageInput = input.page ?? {};
  const issueKey = issuePlan?.current?.key;
  const current = await currentPage(ctx, pageInput, issueKey, linked, problems);
  const before = current?.markdown ?? '';
  const markdown = pageInput.markdown;
  const body = markdown === undefined ? (current?.body ?? '') : pageBody(ctx, input, current, problems);
  const diff = lineDiff(before, markdown ?? before);
  const editing = markdown !== undefined || pageInput.title !== undefined;
  if (current !== undefined && editing) assertPageCurrent(current, pageInput, diff);

  const values = issuePlan?.finalValues ?? new Map<string, unknown>();
  const fixed = pageInput.title ?? current?.title;
  const title = (key: string | undefined): string => fixed ?? pageTitle(ctx.config, key, values);
  return { action: pageAction(current, pageInput), current, title, body, diff };
}

/**
 * Reads the page being edited, refusing an edit not built on a read, and a page outside the
 * configured space: it could never be found again as the issue's page.
 */
async function currentPage(
  ctx: WorkContext,
  pageInput: WorkPageInput,
  issueKey: string | undefined,
  linked: LinkedPages,
  problems: string[],
): Promise<PageState | undefined> {
  const pageId = targetPage(ctx, pageInput, issueKey, linked);
  if (pageId === undefined) return undefined;
  const current = await readPage(ctx, pageId);
  if (pageInput.markdown !== undefined || pageInput.title !== undefined) assertPageRead(current, pageInput);
  const space = ctx.config.confluence?.space ?? '';
  if (current.space !== undefined && current.space.toLowerCase() !== space.toLowerCase()) {
    problems.push(`page: ${pageId} is in space ${current.space}, but this project's pages are in ${space}`);
  }
  return current;
}

function assertPageRead(current: PageState, input: WorkPageInput): void {
  if (input.basedOn !== undefined) return;
  throw new ReadRequiredError(
    `Page ${current.id} already exists. Read it with jira_work_get first and pass its page.revision as ` +
      'page.basedOn, so this save builds on what is there now.',
  );
}

function assertPageCurrent(current: PageState, input: WorkPageInput, diff: string): void {
  if (input.basedOn === current.version) return;
  throw new StaleError(
    `Page ${current.id} changed after the read this save is based on (it is at version ${current.version}, ` +
      `not ${String(input.basedOn)}). Nothing was saved. Merge the current page (in details.page) into your ` +
      'edit and save again with its revision as basedOn.',
    { page: { id: current.id, title: current.title, revision: current.version, markdown: current.markdown }, diff },
  );
}

/** The page being saved: the caller's, or none — never a second page beside the issue's own. */
function targetPage(
  ctx: WorkContext,
  pageInput: WorkPageInput,
  issueKey: string | undefined,
  linked: LinkedPages,
): string | undefined {
  if (pageInput.id !== undefined) return pageIdForInstance(pageInput.id, ctx.confluence().url);
  const existing = issueKey === undefined ? undefined : choosePage(issueKey, linked);
  if (existing !== undefined) {
    throw new ReadRequiredError(
      `${issueKey ?? ''} already has page ${existing}. Read it with jira_work_get and pass page.id and page.basedOn ` +
        'to edit it, rather than creating a second one.',
    );
  }
  return undefined;
}

/** Converts the new Markdown, checking required sections and what the current page would lose. */
function pageBody(ctx: WorkContext, input: WorkSaveInput, current: PageState | undefined, problems: string[]): string {
  const markdown = input.page?.markdown ?? '';
  const lossy = current?.lossy ?? [];
  if (current !== undefined && lossy.length > 0 && markdown !== current.markdown && input.acceptLoss !== true) {
    problems.push(
      `page: ${current.id} holds ${lossy.join(', ')}, which Markdown cannot carry. Saving replaces them. ` +
        'Pass acceptLoss: true if that is intended, or make the edit in Confluence.',
    );
  }
  let storage: string;
  try {
    storage = markdownToStorage(markdown);
  } catch (error) {
    problems.push(`page.markdown: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
  for (const heading of missingHeadings(ctx.config.confluence?.sections ?? [], markdown)) {
    problems.push(`page: the "${heading}" section is required`);
  }
  return storage;
}

/** Linking alone never rewrites a page: the link lives on the issue. */
function pageAction(current: PageState | undefined, input: WorkPageInput): SaveAction {
  if (current === undefined) return 'create';
  const bodyChanged = input.markdown !== undefined && input.markdown !== current.markdown;
  const titleChanged = input.title !== undefined && input.title !== current.title;
  return bodyChanged || titleChanged ? 'update' : 'none';
}

/** `{issue.key}` and `{issue.<field name>}` substituted into the configured title pattern. */
function pageTitle(config: WorkConfig, key: string | undefined, values: ReadonlyMap<string, unknown>): string {
  const summary = config.jira.fields.find((field) => field.key === 'summary')?.name ?? 'Summary';
  const pattern = config.confluence?.title ?? `{issue.key}: {issue.${summary}}`;
  const title = pattern.replaceAll(/\{([^}]*)\}/g, (_match, token: string) => {
    if (token === 'issue.key') return key ?? 'NEW';
    const value = values.get(token.slice('issue.'.length));
    if (isEmptyValue(value)) return '';
    return (Array.isArray(value) ? value.join(', ') : String(value)).replaceAll(/\s+/g, ' ').trim();
  });
  return title.trim() === '' ? (key ?? 'Untitled work item') : title.trim();
}

/** The body under an issue line naming `issueKey`, for readers of the page; none without a key. */
function pageStorage(issueKey: string | undefined, ctx: WorkContext, body: string): string {
  return issueKey === undefined ? body : header(issueKey, issueUrl(ctx.jiraUrl, issueKey)) + body;
}

function dryRunResult(
  ctx: WorkContext,
  issuePlan: IssuePlan | undefined,
  pagePlan: PagePlan | undefined,
  adjusted: readonly WorkAdjustment[],
  linked: LinkedPages,
): WorkDryRunResult {
  const key = issuePlan?.current?.key;
  const links = pairingSteps(ctx, issuePlan, pagePlan, linked);
  const confluence = ctx.config.confluence;
  return {
    dryRun: true,
    ...(issuePlan === undefined
      ? {}
      : {
          issue: {
            action: issuePlan.action,
            ...(issuePlan.action === 'none' ? {} : { request: { fields: issuePlan.fields } }),
            diff: issuePlan.diff,
          },
        }),
    ...(pagePlan === undefined
      ? {}
      : {
          page: {
            action: pagePlan.action,
            ...(pagePlan.action === 'none'
              ? {}
              : {
                  request: {
                    type: 'page',
                    title: pagePlan.title(key),
                    ...(pagePlan.current === undefined
                      ? {
                          space: { key: confluence?.space },
                          ...(confluence?.parent === undefined ? {} : { ancestors: [{ id: confluence.parent }] }),
                        }
                      : { version: { number: pagePlan.current.version + 1 } }),
                    body: {
                      storage: {
                        value: pageStorage(previewLineKey(issuePlan, pagePlan), ctx, pagePlan.body),
                        representation: 'storage',
                      },
                    },
                  },
                }),
            diff: pagePlan.diff,
          },
        }),
    links,
    adjusted,
  };
}

/** What a save would add to pair the halves: the issue's link, and the labels that mark the page. */
function pairingSteps(
  ctx: WorkContext,
  issuePlan: IssuePlan | undefined,
  pagePlan: PagePlan | undefined,
  linked: LinkedPages,
): string[] {
  if (pagePlan === undefined) return [];
  const key = issuePlan?.current?.key;
  const steps: string[] = [];
  const pairing = key !== undefined || issuePlan?.action === 'create';
  if (pairing && (pagePlan.current === undefined || !isLinked(linked, pagePlan.current.id))) {
    steps.push(`remote link from ${key ?? 'the new issue'} to the page (relationship "${WORK_PAGE_RELATIONSHIP}")`);
  }
  const labels = missingLabels(ctx, pagePlan.current?.labels ?? []);
  if (labels.length > 0) steps.push(`label${labels.length === 1 ? '' : 's'} ${labels.join(', ')} on the page`);
  return steps;
}

/** The key the preview's issue line names: a placeholder for an issue not created yet. */
function previewLineKey(issuePlan: IssuePlan | undefined, pagePlan: PagePlan): string | undefined {
  if (issuePlan?.action === 'create') return 'NEW-1';
  return issuePlan?.current?.key ?? pagePlan.current?.headerKey;
}

async function executeSave(
  ctx: WorkContext,
  issuePlan: IssuePlan | undefined,
  pagePlan: PagePlan | undefined,
  adjusted: readonly WorkAdjustment[],
  linkedBefore: LinkedPages,
): Promise<WorkSaveResult> {
  const landed: string[] = [];
  const key = await saveIssue(ctx, issuePlan, landed);

  let pageId = pagePlan?.current?.id;
  let linked = false;
  try {
    if (pagePlan !== undefined) pageId = await savePage(ctx, pagePlan, key, landed);
    if (key !== undefined && pageId !== undefined) linked = await linkPair(ctx, key, pageId, linkedBefore, landed);
  } catch (error) {
    if (landed.length === 0) throw error;
    throw new CliError(
      `Partly saved: ${landed.join('; ')}. Then this failed, and nothing after it was done: ` +
        `${error instanceof Error ? error.message : String(error)} Read the work item again and save the rest.`,
    );
  }

  const item = await getWorkItem(ctx, key === undefined ? { page: pageId } : { issue: key });
  return {
    saved: {
      ...(issuePlan === undefined ? {} : { issue: issuePlan.action }),
      ...(pagePlan === undefined ? {} : { page: pagePlan.action }),
      linked,
    },
    adjusted,
    item,
  };
}

/** Creates or updates the issue; returns its key. */
async function saveIssue(ctx: WorkContext, plan: IssuePlan | undefined, landed: string[]): Promise<string | undefined> {
  if (plan === undefined) return undefined;
  if (plan.action === 'create') {
    const created = (await ctx.jira.createIssue({ fields: plan.fields })) as { key?: string };
    if (created.key === undefined) throw new CliError('Jira created the issue but did not report its key.');
    landed.push(`issue ${created.key} created`);
    return created.key;
  }
  const key = plan.current?.key;
  if (plan.action === 'update' && key !== undefined) {
    await ctx.jira.updateIssue(key, { fields: plan.fields });
    landed.push(`issue ${key} updated`);
  }
  return key;
}

/** Creates or updates the page; returns its id. A conflicting edit is reported as stale. */
async function savePage(
  ctx: WorkContext,
  plan: PagePlan,
  key: string | undefined,
  landed: string[],
): Promise<string | undefined> {
  const { client } = ctx.confluence();
  const confluence = ctx.config.confluence;
  // Saving a page on its own keeps the issue line it already has.
  const lineKey = key ?? plan.current?.headerKey;
  const storage = { storage: { value: pageStorage(lineKey, ctx, plan.body), representation: 'storage' } };

  let pageId = plan.current?.id;
  if (plan.action === 'create') {
    const created = (await client.createContent({
      type: 'page',
      title: plan.title(key),
      space: { key: confluence?.space },
      ...(confluence?.parent === undefined ? {} : { ancestors: [{ id: confluence.parent }] }),
      body: storage,
    })) as { id?: string };
    if (created.id === undefined) throw new CliError('Confluence created the page but did not report its id.');
    pageId = created.id;
    landed.push(`page ${pageId} created`);
  } else if (plan.action === 'update' && plan.current !== undefined) {
    try {
      await client.updateContent(plan.current.id, {
        type: 'page',
        title: plan.title(key),
        version: { number: plan.current.version + 1 },
        body: storage,
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 409 && /version/i.test(error.message)) {
        throw new StaleError(
          `Page ${plan.current.id} was changed by someone else while this saved. Nothing was written to it. ` +
            'Read it again, merge, and save.',
          { page: { id: plan.current.id } },
        );
      }
      throw error;
    }
    landed.push(`page ${plan.current.id} updated`);
  }

  // The labels mark the page as the design page, so an adopted page gets them too.
  const labels = missingLabels(ctx, plan.current?.labels ?? []);
  if (pageId !== undefined && labels.length > 0) {
    await client.addLabels(
      pageId,
      labels.map((name) => ({ prefix: 'global', name })),
    );
  }
  return pageId;
}

/** Makes sure the issue's remote link to the page exists. Idempotent: Jira keys it by URL. */
async function linkPair(
  ctx: WorkContext,
  key: string,
  pageId: string,
  linkedBefore: LinkedPages,
  landed: string[],
): Promise<boolean> {
  if (isLinked(linkedBefore, pageId)) return true;
  const page = await readPage(ctx, pageId);
  await ctx.jira.createRemoteLink(
    key,
    buildRemoteLinkBody({ url: page.url, title: page.title, relationship: WORK_PAGE_RELATIONSHIP }),
  );
  landed.push(`${key} linked to page ${pageId}`);
  return true;
}
