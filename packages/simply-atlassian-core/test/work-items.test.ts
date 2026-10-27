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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Deployment } from '../src/config.js';
import { ConfluenceClient } from '../src/confluence-client.js';
import { CliError, ConfigError, ReadRequiredError, StaleError } from '../src/errors.js';
import { JiraClient } from '../src/jira-client.js';
import { markdownToAdf } from '../src/markdown-adf.js';
import { respondJson, startTestServer, type TestServer } from '../src/testing.js';
import { checkWorkConfig } from '../src/work-check.js';
import { parseWorkConfig } from '../src/work-config.js';
import {
  getWorkItem,
  saveWorkItem,
  type WorkContext,
  type WorkDryRunResult,
  type WorkSaveResult,
} from '../src/work-item.js';
import { EXAMPLE_CONFIG } from './work-config.test.js';

/**
 * A small in-memory Jira and Confluence, enough to exercise a work item end to end: issues with
 * fields, remote links, and pages with versions that refuse a stale update the way Confluence
 * does. Paths follow the deployment (REST v3 and `/wiki` on Cloud, v2 on Server/DC).
 */
class FakeAtlassian {
  public readonly issues = new Map<string, { fields: Record<string, unknown> }>();
  public readonly remoteLinks = new Map<string, Array<Record<string, unknown>>>();
  public readonly pages = new Map<
    string,
    { title: string; version: number; storage: string; space: string; labels: string[] }
  >();
  public nextIssue = 1;
  public nextPage = 900;
  public failPageCreate = false;

  public constructor(
    private readonly server: TestServer,
    public readonly deployment: Deployment,
  ) {
    server.route(`${this.jiraApi}/issue`, (request, response, body) => {
      const key = `PAY-${this.nextIssue++}`;
      const fields = (JSON.parse(body) as { fields: Record<string, unknown> }).fields;
      this.addIssue(key, { ...fields, status: { name: 'To Do' } });
      respondJson(response, 201, { id: '1', key, self: `${server.baseUrl}${this.jiraApi}/issue/${key}` });
    });
    server.route(`${this.wiki}/rest/api/content`, (_request, response, body) => {
      if (this.failPageCreate) {
        respondJson(response, 400, { message: 'A page with this title already exists' });
        return;
      }
      const payload = JSON.parse(body) as {
        title: string;
        space: { key: string };
        body: { storage: { value: string } };
      };
      const id = String(this.nextPage++);
      this.addPage(id, payload.title, payload.body.storage.value, { space: payload.space.key });
      respondJson(response, 200, this.pagePayload(id));
    });
  }

  public get jiraApi(): string {
    return this.deployment === 'cloud' ? '/rest/api/3' : '/rest/api/2';
  }

  public get wiki(): string {
    return this.deployment === 'cloud' ? '/wiki' : '';
  }

  public addIssue(key: string, fields: Record<string, unknown>): void {
    this.issues.set(key, { fields: { issuetype: { name: 'Story' }, ...fields } });
    this.remoteLinks.set(key, this.remoteLinks.get(key) ?? []);
    this.server.route(`${this.jiraApi}/issue/${key}`, (request, response, body) => {
      const issue = this.issues.get(key);
      if (issue === undefined) return respondJson(response, 404, {});
      if (request.method === 'PUT') {
        Object.assign(issue.fields, (JSON.parse(body) as { fields: Record<string, unknown> }).fields);
        response.writeHead(204).end();
        return undefined;
      }
      return respondJson(response, 200, { key, fields: issue.fields });
    });
    this.server.route(`${this.jiraApi}/issue/${key}/remotelink`, (request, response, body) => {
      const links = this.remoteLinks.get(key) ?? [];
      if (request.method === 'POST') {
        const link = JSON.parse(body) as Record<string, unknown>;
        const index = links.findIndex((existing) => existing.globalId === link.globalId);
        if (index === -1) links.push({ id: links.length + 1, ...link });
        else links[index] = { id: index + 1, ...link };
        this.remoteLinks.set(key, links);
        return respondJson(response, 201, { id: links.length });
      }
      return respondJson(response, 200, links);
    });
  }

  public addPage(
    id: string,
    title: string,
    storage: string,
    { space = 'ENG', labels = [] }: { space?: string; labels?: string[] } = {},
  ): void {
    this.pages.set(id, { title, version: 1, storage, space, labels: [...labels] });
    this.server.route(`${this.wiki}/rest/api/content/${id}`, (request, response, body) => {
      const page = this.pages.get(id);
      if (page === undefined) return respondJson(response, 404, {});
      if (request.method === 'PUT') {
        const update = JSON.parse(body) as {
          title: string;
          version: { number: number };
          body: { storage: { value: string } };
        };
        if (update.version.number !== page.version + 1) {
          return respondJson(response, 409, { message: 'Version must be incremented on update.' });
        }
        Object.assign(page, {
          title: update.title,
          version: update.version.number,
          storage: update.body.storage.value,
        });
      }
      return respondJson(response, 200, this.pagePayload(id));
    });
    this.server.route(`${this.wiki}/rest/api/content/${id}/label`, (_request, response, body) => {
      const page = this.pages.get(id);
      for (const label of JSON.parse(body) as Array<{ name: string }>) {
        if (!page?.labels.includes(label.name)) page?.labels.push(label.name);
      }
      respondJson(response, 200, { results: [] });
    });
  }

  /** The page's browser URL, as a remote link to it carries. */
  public pageUrl(id: string): string {
    return `${this.server.baseUrl}${this.wiki}/pages/viewpage.action?pageId=${id}`;
  }

  /** Someone else edits the page in the browser. */
  public editPage(id: string, storage: string): void {
    const page = this.pages.get(id);
    if (page !== undefined) Object.assign(page, { version: page.version + 1, storage });
  }

  private pagePayload(id: string): unknown {
    const page = this.pages.get(id);
    return {
      id,
      type: 'page',
      title: page?.title,
      space: { key: page?.space },
      metadata: { labels: { results: (page?.labels ?? []).map((name) => ({ prefix: 'global', name })) } },
      version: { number: page?.version },
      body: { storage: { value: page?.storage, representation: 'storage' } },
      _links: { base: `${this.server.baseUrl}${this.wiki}`, webui: `/pages/viewpage.action?pageId=${id}` },
    };
  }
}

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

function context(deployment: Deployment, configText = EXAMPLE_CONFIG): { ctx: WorkContext; fake: FakeAtlassian } {
  const fake = new FakeAtlassian(server, deployment);
  const auth =
    deployment === 'cloud'
      ? ({ kind: 'basic', username: 'u', apiToken: 't' } as const)
      : ({ kind: 'bearer', personalToken: 'p' } as const);
  const confluenceUrl = `${server.baseUrl}${fake.wiki}`;
  const ctx: WorkContext = {
    config: parseWorkConfig(configText, 'repo/.simply/atlassian.json'),
    jira: new JiraClient({ url: server.baseUrl, deployment, auth }),
    jiraUrl: server.baseUrl,
    confluence: () => ({ client: new ConfluenceClient({ url: confluenceUrl, deployment, auth }), url: confluenceUrl }),
  };
  return { ctx, fake };
}

const STORY = {
  Summary: 'Offline sync for field technicians',
  Description: 'As a technician I want to sync later\n\n## Out of scope\n\n- Reporting',
  'Acceptance Criteria': '1. **AC-1** Given no signal\n2. **AC-2** When signal returns',
};

const PAGE = '# Problem\n\nTechnicians lose work.\n\n# Design\n\nQueue writes locally.';

describe.each(['cloud', 'server'] as const)('work items on %s', (deployment) => {
  it('returns the empty shape, with guidance, for a new idea', async () => {
    const { ctx } = context(deployment);
    const view = await getWorkItem(ctx);
    expect(view.guidance).toBe('Write for business reviewers outside engineering.');
    expect(view.issue.key).toBeUndefined();
    expect(view.issue.fields.map((field) => field.name)).toContain('Acceptance Criteria');
    expect(view.issue.fields.find((field) => field.name === 'Component/s')).toMatchObject({
      always: true,
      value: ['O&M'],
    });
    expect(view.page).toMatchObject({ when: 'Create a page when the work spans more than one system.' });
    expect(server.requests).toHaveLength(0);
  });

  it('creates the pair from nothing: issue first, page titled with its key, linked from the issue', async () => {
    const { ctx, fake } = context(deployment);
    const result = (await saveWorkItem(ctx, { issue: { fields: STORY }, page: { markdown: PAGE } })) as WorkSaveResult;

    expect(result.saved).toEqual({ issue: 'create', page: 'create', linked: true });
    expect(result.adjusted).toEqual([{ field: 'Priority', reason: 'default', value: 'Medium' }]);

    const issue = fake.issues.get('PAY-1');
    expect(issue?.fields.components).toEqual([{ name: 'O&M' }]);
    expect(issue?.fields.labels).toEqual(['agent-drafted']);
    expect(issue?.fields.priority).toEqual({ name: 'Medium' });
    if (deployment === 'cloud')
      expect(issue?.fields.customfield_10045).toEqual(markdownToAdf(STORY['Acceptance Criteria']));
    else expect(issue?.fields.customfield_10045).toBe('# *AC-1* Given no signal\n# *AC-2* When signal returns');

    const page = fake.pages.get('900');
    expect(page?.title).toBe('PAY-1: Offline sync for field technicians');
    expect(page?.storage).toMatch(
      /^<p><strong>Jira:<\/strong> <a href="[^"]+\/browse\/PAY-1">PAY-1<\/a><\/p><h1>Problem<\/h1>/,
    );
    expect(page?.labels).toEqual(['tech-design']);
    expect(fake.remoteLinks.get('PAY-1')).toMatchObject([
      { relationship: 'Wiki Page', object: { title: page?.title } },
    ]);

    expect(result.item.links.paired).toBe(true);
    expect(result.item.page?.markdown).toBe(PAGE);
    expect(result.item.missingRequired).toEqual([]);
  });

  it('finds the page through the issue, and never the issue through the page', async () => {
    const { ctx } = context(deployment);
    await saveWorkItem(ctx, { issue: { fields: STORY }, page: { markdown: PAGE } });

    const fromIssue = await getWorkItem(ctx, { issue: 'PAY-1' });
    const fromPage = await getWorkItem(ctx, { page: '900' });
    expect(fromIssue.page?.id).toBe('900');
    expect(fromIssue.links.paired).toBe(true);
    expect(fromIssue.issue.fields.find((field) => field.name === 'Acceptance Criteria')?.value).toBe(
      STORY['Acceptance Criteria'],
    );
    // The issue line on the page is for readers; it does not pair anything.
    expect(fromPage.page?.markdown).toBe(PAGE);
    expect(fromPage.issue.key).toBeUndefined();
    expect(fromPage.links.paired).toBe(false);
  });

  it('follows a Confluence link added in Jira, whoever made it', async () => {
    const { ctx, fake } = context(deployment);
    fake.addPage('77', 'Hand-made design', '<h1>Problem</h1><p>Written by hand.</p>', { labels: ['tech-design'] });
    await saveWorkItem(ctx, { issue: { fields: STORY } });
    fake.remoteLinks.set('PAY-1', [
      { id: 1, relationship: 'mentioned in', object: { url: fake.pageUrl('77'), title: 'Hand-made design' } },
      { id: 2, object: { url: 'https://example.com/elsewhere', title: 'Not Confluence' } },
    ]);

    const read = await getWorkItem(ctx, { issue: 'PAY-1' });
    expect(read.page?.id).toBe('77');
    expect(read.links).toEqual({ paired: true, other: [] });
  });

  it('keeps linked pages the config does not describe as context, never as the page', async () => {
    const { ctx, fake } = context(deployment);
    fake.addPage('70', 'Requirements', '<p>Unlabelled, in the right space.</p>');
    fake.addPage('71', 'Other team design', '<p>Labelled, elsewhere.</p>', { space: 'OPS', labels: ['tech-design'] });
    await saveWorkItem(ctx, { issue: { fields: STORY } });
    fake.remoteLinks.set('PAY-1', [
      { id: 1, object: { url: fake.pageUrl('70'), title: 'Reqs' } },
      { id: 2, object: { url: fake.pageUrl('71'), title: 'Theirs' } },
    ]);

    const read = await getWorkItem(ctx, { issue: 'PAY-1' });
    expect(read.page?.id).toBeUndefined();
    expect(read.links.other).toEqual([
      { id: '70', title: 'Requirements', url: fake.pageUrl('70') },
      { id: '71', title: 'Other team design', url: fake.pageUrl('71') },
    ]);

    // With no design page linked, a new one can be created beside them.
    const saved = (await saveWorkItem(ctx, {
      issue: { key: 'PAY-1', basedOn: read.issue.revision },
      page: { markdown: PAGE },
    })) as WorkSaveResult;
    expect(saved.saved.page).toBe('create');
    expect(saved.item.page?.id).toBe('900');
    expect(saved.item.links.other.map((page) => page.id)).toEqual(['70', '71']);
    expect(fake.pages.get('70')?.storage).toBe('<p>Unlabelled, in the right space.</p>');
  });

  it('refuses to adopt a page from another space', async () => {
    const { ctx, fake } = context(deployment);
    fake.addPage('71', 'Other team design', '<p>x</p>', { space: 'OPS' });
    await expect(saveWorkItem(ctx, { issue: { fields: STORY }, page: { id: '71' } })).rejects.toThrow(
      /71 is in space OPS, but this project's pages are in ENG/,
    );
    expect(fake.issues.size).toBe(0);
  });

  it('asks which page when the issue links to several', async () => {
    const { ctx, fake } = context(deployment);
    fake.addPage('77', 'Design', '<p>a</p>', { labels: ['tech-design'] });
    fake.addPage('78', 'Requirements', '<p>b</p>', { labels: ['tech-design'] });
    await saveWorkItem(ctx, { issue: { fields: STORY } });
    fake.remoteLinks.set('PAY-1', [
      { id: 1, object: { url: fake.pageUrl('77') } },
      { id: 2, object: { url: fake.pageUrl('78') } },
    ]);

    await expect(getWorkItem(ctx, { issue: 'PAY-1' })).rejects.toThrow(/more than one design page \(77, 78\)/);
    const chosen = await getWorkItem(ctx, { issue: 'PAY-1', page: '78' });
    expect(chosen.page?.title).toBe('Requirements');
    expect(chosen.links.paired).toBe(true);
  });

  it('refuses an update that was not built on a read', async () => {
    const { ctx } = context(deployment);
    await saveWorkItem(ctx, { issue: { fields: STORY } });
    await expect(saveWorkItem(ctx, { issue: { key: 'PAY-1', fields: { Summary: 'x' } } })).rejects.toThrow(
      ReadRequiredError,
    );
  });

  it('updates only the fields that change, and re-applies fixed values', async () => {
    const { ctx, fake } = context(deployment);
    await saveWorkItem(ctx, { issue: { fields: STORY } });
    const issue = fake.issues.get('PAY-1');
    if (issue !== undefined) issue.fields.labels = ['someone-removed-it'];
    const read = await getWorkItem(ctx, { issue: 'PAY-1' });

    const before = server.requests.length;
    const result = (await saveWorkItem(ctx, {
      issue: { key: 'PAY-1', basedOn: read.issue.revision, fields: { Priority: 'High' } },
    })) as WorkSaveResult;

    const put = server.requests.slice(before).find((request) => request.method === 'PUT');
    expect(JSON.parse(put?.body ?? '{}')).toEqual({
      fields: { priority: { name: 'High' }, labels: ['agent-drafted'] },
    });
    expect(result.adjusted).toEqual([{ field: 'Labels', reason: 'always', value: ['agent-drafted'] }]);
    expect(result.item.issue.revision).not.toBe(read.issue.revision);
  });

  it('sends nothing when the save changes nothing', async () => {
    const { ctx } = context(deployment);
    await saveWorkItem(ctx, { issue: { fields: STORY } });
    const read = await getWorkItem(ctx, { issue: 'PAY-1' });
    const values = Object.fromEntries(read.issue.fields.map((field) => [field.name, field.value]));

    const before = server.requests.length;
    const result = (await saveWorkItem(ctx, {
      issue: { key: 'PAY-1', basedOn: read.issue.revision, fields: values },
    })) as WorkSaveResult;
    expect(result.saved.issue).toBe('none');
    expect(server.requests.slice(before).some((request) => request.method === 'PUT')).toBe(false);
  });

  it('reports a concurrent field edit as stale, with the current fields and a diff', async () => {
    const { ctx, fake } = context(deployment);
    await saveWorkItem(ctx, { issue: { fields: STORY } });
    const read = await getWorkItem(ctx, { issue: 'PAY-1' });
    const issue = fake.issues.get('PAY-1');
    if (issue !== undefined) issue.fields.summary = 'Renamed by a reviewer';

    const error = await saveWorkItem(ctx, {
      issue: { key: 'PAY-1', basedOn: read.issue.revision, fields: { Priority: 'Low' } },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StaleError);
    const details = (error as StaleError).details as {
      issue: { fields: Array<{ name: string; value: unknown }> };
      diff: string;
    };
    expect(details.issue.fields.find((field) => field.name === 'Summary')?.value).toBe('Renamed by a reviewer');
    expect(details.diff).toContain('-Medium');
    expect(details.diff).toContain('+Low');
  });

  it('does not treat a status change made outside the agent as a conflict', async () => {
    const { ctx, fake } = context(deployment);
    await saveWorkItem(ctx, { issue: { fields: STORY } });
    const read = await getWorkItem(ctx, { issue: 'PAY-1' });
    const issue = fake.issues.get('PAY-1');
    if (issue !== undefined) issue.fields.status = { name: 'In Business Review' };

    const result = (await saveWorkItem(ctx, {
      issue: { key: 'PAY-1', basedOn: read.issue.revision, fields: { Priority: 'Low' } },
    })) as WorkSaveResult;
    expect(result.saved.issue).toBe('update');
    expect(result.item.issue.status).toBe('In Business Review');
  });

  it('refuses a stale page edit, and a page edit Confluence itself rejects as a conflict', async () => {
    const { ctx, fake } = context(deployment);
    await saveWorkItem(ctx, { issue: { fields: STORY }, page: { markdown: PAGE } });
    const read = await getWorkItem(ctx, { issue: 'PAY-1' });
    fake.editPage('900', `${fake.pages.get('900')?.storage ?? ''}<p>Added in the browser.</p>`);

    const error = await saveWorkItem(ctx, {
      page: { id: '900', basedOn: read.page?.revision, markdown: `${PAGE}\n\nMine.` },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StaleError);
    const details = (error as StaleError).details as { page: { markdown: string; revision: number }; diff: string };
    expect(details.page.markdown).toContain('Added in the browser.');
    expect(details.diff).toContain('-Added in the browser.');
    expect(details.diff).toContain('+Mine.');

    const merged = `${details.page.markdown}\n\nMine.`;
    const saved = (await saveWorkItem(ctx, {
      page: { id: '900', basedOn: details.page.revision, markdown: merged },
    })) as WorkSaveResult;
    expect(saved.saved.page).toBe('update');
    expect(saved.item.page?.markdown).toBe(merged);
    // Saved on its own, the page keeps its issue line.
    expect(fake.pages.get('900')?.storage).toMatch(/^<p><strong>Jira:<\/strong> .*PAY-1<\/a><\/p>/);
  });

  it('will not create a second page for an issue that already has one', async () => {
    const { ctx } = context(deployment);
    await saveWorkItem(ctx, { issue: { fields: STORY }, page: { markdown: PAGE } });
    const read = await getWorkItem(ctx, { issue: 'PAY-1' });
    await expect(
      saveWorkItem(ctx, { issue: { key: 'PAY-1', basedOn: read.issue.revision }, page: { markdown: PAGE } }),
    ).rejects.toThrow(/already has page 900/);
  });

  it('adopts an existing issue and adds its page', async () => {
    const { ctx, fake } = context(deployment);
    // eslint-disable-next-line camelcase -- a real Jira custom field is named exactly this
    fake.addIssue('PAY-50', { summary: 'Existing story', description: null, customfield_10045: null });
    const read = await getWorkItem(ctx, { issue: 'PAY-50' });
    expect(read.missingRequired).toEqual(['issue: Description', 'issue: Acceptance Criteria']);

    const result = (await saveWorkItem(ctx, {
      issue: { key: 'PAY-50', basedOn: read.issue.revision, fields: { Description: 'd', 'Acceptance Criteria': 'a' } },
      page: { markdown: PAGE },
    })) as WorkSaveResult;
    expect(result.saved).toEqual({ issue: 'update', page: 'create', linked: true });
    expect(fake.pages.get('900')?.title).toBe('PAY-50: Existing story');
  });

  it('adopts an existing page by linking it from a new issue, without touching the page', async () => {
    const { ctx, fake } = context(deployment);
    const original = '<p>Written by hand.</p><ac:structured-macro ac:name="toc" />';
    fake.addPage('77', 'Hand-made design', original);

    const result = (await saveWorkItem(ctx, { issue: { fields: STORY }, page: { id: '77' } })) as WorkSaveResult;
    expect(result.saved).toEqual({ issue: 'create', page: 'none', linked: true });
    expect(fake.pages.get('77')?.storage).toBe(original);
    // Labelled so the next read finds it as the design page.
    expect(fake.pages.get('77')?.labels).toEqual(['tech-design']);
    expect((await getWorkItem(ctx, { issue: 'PAY-1' })).page?.id).toBe('77');
    expect(fake.remoteLinks.get('PAY-1')).toMatchObject([{ object: { url: fake.pageUrl('77') } }]);
    expect(result.item.links.paired).toBe(true);
    expect(result.item.page?.lossy).toEqual(['a "toc" macro']);
  });

  it('refuses to overwrite content Markdown cannot carry unless told to', async () => {
    const { ctx, fake } = context(deployment);
    fake.addPage('77', 'Hand-made design', '<p>Intro</p><ac:structured-macro ac:name="toc" />');
    await saveWorkItem(ctx, { issue: { fields: STORY }, page: { id: '77' } });
    const read = await getWorkItem(ctx, { page: '77' });

    await expect(
      saveWorkItem(ctx, { page: { id: '77', basedOn: read.page?.revision, markdown: PAGE } }),
    ).rejects.toThrow(/holds a "toc" macro[\s\S]*acceptLoss/);
    const saved = (await saveWorkItem(ctx, {
      page: { id: '77', basedOn: read.page?.revision, markdown: PAGE },
      acceptLoss: true,
    })) as WorkSaveResult;
    expect(saved.item.page?.lossy).toBeUndefined();
  });

  it('validates everything before sending anything, and reports it all at once', async () => {
    const { ctx } = context(deployment);
    const error = await saveWorkItem(ctx, {
      issue: { fields: { Summary: 'x', Priority: 'Urgent', Epic: 'not-a-key', Nonsense: 1 } },
      page: { markdown: '# Problem\n\nNo design yet.' },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain('"Nonsense" is not a configured field');
    expect(message).toContain('Urgent is not allowed');
    expect(message).toContain('must be an issue key');
    expect(message).toContain('"Description" is required');
    expect(message).toContain('the "Design" section is required');
    expect(server.requests).toHaveLength(0);
  });

  it('reports Markdown it cannot convert alongside the other problems', async () => {
    const { ctx } = context(deployment);
    const error = await saveWorkItem(ctx, {
      issue: { fields: { ...STORY, Description: '<div>raw</div>' } },
      page: { markdown: '# Problem\n\n<div>raw</div>' },
    }).catch((caught: unknown) => caught);
    const message = (error as Error).message;
    expect(message).toMatch(/issue\.fields\["Description"\]: Line 1: raw HTML/);
    expect(message).toMatch(/page\.markdown: Line 3: raw HTML/);
    expect(server.requests).toHaveLength(0);
  });

  it('previews exactly what would be sent, and sends nothing', async () => {
    const { ctx } = context(deployment);
    const preview = (await saveWorkItem(ctx, {
      issue: { fields: STORY },
      page: { markdown: PAGE },
      dryRun: true,
    })) as WorkDryRunResult;
    expect(preview.dryRun).toBe(true);
    expect(preview.issue?.action).toBe('create');
    expect(preview.issue?.request).toMatchObject({ fields: { project: { key: 'PAY' }, issuetype: { name: 'Story' } } });
    expect(preview.page?.request).toMatchObject({
      title: 'NEW: Offline sync for field technicians',
      space: { key: 'ENG' },
    });
    expect(preview.issue?.diff).toContain('+Offline sync for field technicians');
    expect(preview.links).toEqual([
      'remote link from the new issue to the page (relationship "Wiki Page")',
      'label tech-design on the page',
    ]);
    expect(server.requests.filter((request) => request.method !== 'GET')).toHaveLength(0);
  });

  it('says exactly what landed when a later step fails', async () => {
    const { ctx, fake } = context(deployment);
    fake.failPageCreate = true;
    const error = await saveWorkItem(ctx, { issue: { fields: STORY }, page: { markdown: PAGE } }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as Error).message).toMatch(/^Partly saved: issue PAY-1 created\. Then this failed/);
    expect(fake.issues.has('PAY-1')).toBe(true);
  });

  it('refuses to read an issue of a different type as a work item', async () => {
    const { ctx, fake } = context(deployment);
    fake.addIssue('PAY-9', { issuetype: { name: 'Bug' }, summary: 'A bug' });
    await expect(getWorkItem(ctx, { issue: 'PAY-9' })).rejects.toThrow(
      /is a Bug, but this project's work items are Story/,
    );
  });
});

describe('user fields on Cloud', () => {
  it('resolves an email to the one account it names, and refuses an ambiguous name', async () => {
    const { ctx, fake } = context('cloud');
    server.route('/rest/api/3/user/search', (request, response) => {
      const query = new URL(request.url ?? '/', 'http://x').searchParams.get('query');
      respondJson(
        response,
        200,
        query === 'sam@example.com'
          ? [
              {
                accountId: '712020:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                emailAddress: 'sam@example.com',
                displayName: 'Sam',
              },
            ]
          : [
              { accountId: 'a1', displayName: 'Alex One' },
              { accountId: 'a2', displayName: 'Alex Two' },
            ],
      );
    });
    await saveWorkItem(ctx, { issue: { fields: { ...STORY, Assignee: 'sam@example.com' } } });
    expect(fake.issues.get('PAY-1')?.fields.assignee).toEqual({
      accountId: '712020:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    await expect(saveWorkItem(ctx, { issue: { fields: { ...STORY, Assignee: 'Alex' } } })).rejects.toThrow(
      /matches 2 people/,
    );
  });
});

describe('checkWorkConfig', () => {
  function routeInstance(options: { required?: string[]; screen?: string[] } = {}): void {
    server.route('/rest/api/3/project/PAY', (_request, response) => respondJson(response, 200, { key: 'PAY' }));
    server.route('/rest/api/3/issue/createmeta/PAY/issuetypes', (_request, response) =>
      respondJson(response, 200, {
        issueTypes: [
          { id: '10001', name: 'Story' },
          { id: '10002', name: 'Bug' },
        ],
      }),
    );
    const screen = options.screen ?? [
      'summary',
      'description',
      'customfield_10045',
      'components',
      'priority',
      'parent',
      'assignee',
      'labels',
    ];
    server.route('/rest/api/3/issue/createmeta/PAY/issuetypes/10001', (_request, response) =>
      respondJson(response, 200, {
        fields: [
          ...screen.map((fieldId) =>
            fieldId === 'priority'
              ? { fieldId, name: 'Priority', allowedValues: [{ name: 'High' }, { name: 'Medium' }, { name: 'Low' }] }
              : { fieldId, name: fieldId },
          ),
          ...(options.required ?? []).map((fieldId) => ({ fieldId, name: 'Team', required: true })),
        ],
      }),
    );
    server.route('/rest/api/3/project/PAY/components', (_request, response) =>
      respondJson(response, 200, [{ name: 'O&M' }]),
    );
    server.route('/wiki/rest/api/space/ENG', (_request, response) => respondJson(response, 200, { key: 'ENG' }));
    server.route('/wiki/rest/api/content/123456', (_request, response) => respondJson(response, 200, { id: '123456' }));
  }

  it('passes a config that matches the instance', async () => {
    const { ctx } = context('cloud');
    routeInstance();
    await expect(checkWorkConfig(ctx)).resolves.toMatchObject({ ok: true, errors: [] });
  });

  it('catches an unknown field, a field required by Jira but not configured, and a missing component', async () => {
    const config = EXAMPLE_CONFIG.replace('"value": ["O&M"]', '"value": ["Billing"]');
    const { ctx } = context('cloud', config);
    routeInstance({
      screen: ['summary', 'description', 'components', 'priority', 'parent', 'assignee', 'labels'],
      required: ['customfield_200'],
    });
    const check = await checkWorkConfig(ctx);
    expect(check.ok).toBe(false);
    expect(check.errors).toEqual([
      'jira.fields[2]: customfield_10045 ("Acceptance Criteria") is not on the create screen for this issue type',
      'jira.fields[3]: "Billing" is not one of Component/s\'s options (O&M)',
      'jira.fields: "Team" (customfield_200) is required to create a Story but is not configured',
    ]);
  });

  it('names an issue type the project cannot create', async () => {
    const { ctx } = context('cloud', EXAMPLE_CONFIG.replace('"issueType": "Story"', '"issueType": "Epic"'));
    routeInstance();
    const check = await checkWorkConfig(ctx);
    expect(check.errors).toEqual(['jira.issueType: PAY cannot create "Epic" issues (it can create: Story, Bug)']);
  });
});
