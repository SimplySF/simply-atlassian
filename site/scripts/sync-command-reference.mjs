#!/usr/bin/env node
// Regenerates the command-reference pages under src/content/docs/reference/ from the
// oclif-generated command block in packages/simply-atlassian/README.md, so the site never
// hand-duplicates content that `pnpm run readme` already keeps current. Every file it writes is
// fully derived from that README and package.json; the output directory is gitignored and this
// runs automatically before `astro dev`/`astro build` (see site/package.json's pre* scripts).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const packageDir = path.join(repoRoot, 'packages', 'simply-atlassian');
const outputDir = path.join(__dirname, '../src/content/docs/reference');

const COMMANDS_START = '<!-- commands -->';
const COMMANDS_STOP = '<!-- commandsstop -->';

/**
 * One page per command group. Array order is the matching order: the first entry whose `match`
 * prefix appears in a command's header wins, so `jira issue comment` and `jira issue link` must
 * precede `jira issue`. Sidebar position is the explicit `order` instead, so the most-used page
 * (issues) can come first even though its prefix has to be matched last. An entry without a
 * `title` routes its commands onto an earlier entry's page (`whoami` sits with the user commands).
 */
const GROUPS = [
  {
    match: 'simply atlassian jira issue comment ',
    file: 'jira-issue-comments.md',
    order: 2,
    title: 'Jira — Issue comments',
    description: 'List, add, edit, and delete comments on a Jira issue, including @-mentions.',
  },
  {
    match: 'simply atlassian jira issue link ',
    file: 'jira-issue-links.md',
    order: 3,
    title: 'Jira — Issue links',
    description: 'Relate Jira issues to one another: list, create, and delete links, and list the link types.',
  },
  {
    match: 'simply atlassian jira issue ',
    file: 'jira-issues.md',
    order: 1,
    title: 'Jira — Issues',
    description: 'Search, view, create, update, transition, and delete Jira issues.',
  },
  {
    match: 'simply atlassian jira user ',
    file: 'jira-users.md',
    order: 4,
    title: 'Jira — Users',
    description: 'Look up Jira users by name or account, and check which account the CLI is authenticated as.',
  },
  {
    match: 'simply atlassian jira whoami',
    file: 'jira-users.md',
  },
  {
    match: 'simply atlassian confluence page ',
    file: 'confluence-pages.md',
    order: 5,
    title: 'Confluence — Pages',
    description: 'Read Confluence pages: fetch one by id or title, search, and list child pages.',
  },
];

/** Pulls the oclif-generated command block out of the package README. */
function extractCommandsBlock(readme) {
  const start = readme.indexOf(COMMANDS_START);
  const stop = readme.indexOf(COMMANDS_STOP);
  if (start === -1 || stop === -1) return null;
  return readme.slice(start + COMMANDS_START.length, stop).trim();
}

/**
 * Splits a commands block into one chunk per `## \`simply ...\`` command, dropping the
 * auto-generated table-of-contents bullet list that precedes the first command header.
 */
function splitCommands(block) {
  const chunks = [];
  let current = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('## `')) {
      if (current) chunks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) chunks.push(current);
  return chunks.map((lines) => lines.join('\n').trim());
}

function frontmatter({ title, description, order }) {
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    'sidebar:',
    `  order: ${order}`,
    '---',
    '',
    '',
  ].join('\n');
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  console.log(`wrote ${path.relative(repoRoot, filePath)}`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(packageDir, 'README.md'), 'utf8');
const block = extractCommandsBlock(readme);
if (!block) {
  throw new Error('Could not find a <!-- commands --> block in packages/simply-atlassian/README.md');
}

// Start from a clean directory so a group that's renamed or removed doesn't leave a stale page.
fs.rmSync(outputDir, { recursive: true, force: true });

const pages = new Map(); // file -> { group (the entry carrying title/description), bodies }
for (const group of GROUPS) {
  if (group.title && !pages.has(group.file)) pages.set(group.file, { group, bodies: [] });
}

for (const body of splitCommands(block)) {
  const header = body.split('\n')[0];
  const group = GROUPS.find((g) => header.includes(`\`${g.match}`));
  if (!group) {
    console.warn(`sync-command-reference: no reference group matched ${header}`);
    continue;
  }
  pages.get(group.file).bodies.push(body);
}

const populated = [...pages.values()]
  .filter(({ bodies }) => bodies.length > 0)
  .sort((a, b) => a.group.order - b.group.order);

for (const { group, bodies } of populated) {
  writeFile(
    path.join(outputDir, group.file),
    frontmatter({ title: group.title, description: group.description, order: group.order }) +
      bodies.join('\n\n') +
      '\n',
  );
}

// A landing page for the group, so /reference/ resolves and lists what's in it.
const indexRows = populated.map(({ group, bodies }) => {
  const slug = group.file.replace(/\.md$/, '');
  return `| [${group.title}](/reference/${slug}/) | ${bodies.length} | ${group.description} |`;
});

writeFile(
  path.join(outputDir, 'index.md'),
  frontmatter({
    title: 'Command Reference',
    description: `Every ${pkg.name} command, grouped by topic and generated from the package README.`,
    order: 0,
  }) +
    [
      `Every command \`${pkg.name}\` ships, grouped by topic. Each page is generated from the`,
      `package README's command reference (\`pnpm run readme\` in the package, then this site's`,
      '`sync` script), so it always matches the published `--help` output.',
      '',
      '```sh',
      `npm install -g ${pkg.name}`,
      'simply atlassian --help',
      '```',
      '',
      '| Page | Commands | Covers |',
      '| ---- | -------- | ------ |',
      ...indexRows,
      '',
      'Every command accepts `--json` for raw API output, and every command that changes data accepts',
      '`--dry-run`. See [Scripts and agents](/guides/scripting/) for how those fit together, and',
      '[Credentials](/guides/credentials/) for the connection settings every command reads.',
      '',
    ].join('\n'),
);
