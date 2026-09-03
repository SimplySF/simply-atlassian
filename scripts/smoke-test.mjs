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

// Live smoke test for the Atlassian client core. Reads the same env vars the CLI will use.
// Read-only: it calls /myself, one JQL search, and (if configured) one Confluence CQL search.
// Usage: node scripts/smoke-test.mjs   (after `pnpm run compile` in packages/simply-atlassian)

import {
  resolveJiraConfig,
  resolveConfluenceConfig,
  JiraClient,
  ConfluenceClient,
  ConfigError,
} from '../packages/simply-atlassian/lib/index.js';

function section(title) {
  console.log(`\n=== ${title} ===`);
}

let failures = 0;
let checksRun = 0;

async function run(label, fn) {
  checksRun += 1;
  try {
    const result = await fn();
    console.log(`  ✅ ${label}`);
    return result;
  } catch (error) {
    failures += 1;
    console.log(`  ❌ ${label}`);
    console.log(`     ${error.constructor.name}: ${error.message}`);
    return undefined;
  }
}

section('Jira');
let jiraConfig;
try {
  jiraConfig = resolveJiraConfig();
  console.log(`  instance:   ${jiraConfig.url}`);
  console.log(`  deployment: ${jiraConfig.deployment}`);
  console.log(`  auth:       ${jiraConfig.auth.kind}`);
} catch (error) {
  if (error instanceof ConfigError) {
    console.log(`  ⚠️  skipped — ${error.message}`);
  } else {
    throw error;
  }
}

if (jiraConfig) {
  const jira = new JiraClient(jiraConfig);

  const me = await run('GET /myself (credential check)', () => jira.getCurrentUser());
  if (me) console.log(`     signed in as: ${me.displayName ?? me.name ?? '(unknown)'}`);

  const page = await run('search: 5 most recently updated issues visible to you', () =>
    jira.searchIssues({ jql: 'order by updated desc', maxResults: 5, fields: ['key', 'summary'] }),
  );
  if (page) {
    console.log(`     got ${page.issues.length} issue(s), isLast=${page.isLast}`);
    for (const issue of page.issues) {
      console.log(`       ${issue.key}: ${issue.fields?.summary ?? ''}`);
    }
  }
}

section('Confluence');
let confluenceConfig;
try {
  confluenceConfig = resolveConfluenceConfig();
  console.log(`  instance:   ${confluenceConfig.url}`);
  console.log(`  deployment: ${confluenceConfig.deployment}`);
} catch (error) {
  if (error instanceof ConfigError) {
    console.log(`  ⚠️  skipped — ${error.message}`);
  } else {
    throw error;
  }
}

if (confluenceConfig) {
  const confluence = new ConfluenceClient(confluenceConfig);
  const result = await run('CQL search: 3 most recently modified pages', () =>
    confluence.searchPages('type = page order by lastmodified desc', { limit: 3 }),
  );
  if (result) {
    for (const item of result.results ?? []) {
      console.log(`       [${item.id}] ${item.title}`);
    }
  }
}

if (checksRun === 0) {
  console.log('\nNo products configured — nothing was tested.');
  process.exit(1);
}
console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
