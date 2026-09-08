#!/usr/bin/env node

// Stdio MCP servers own stdout as the protocol channel, so nothing here (or anywhere under
// src/) may write to it except the transport. Diagnostics go to stderr.
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'allow-writes': { type: 'boolean', default: false },
    'env-file': { type: 'string' },
    timeout: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (values.help) {
  const { DEFAULT_TIMEOUT_MS, selectTools } = await import('../lib/index.js');
  const list = (allowWrites) =>
    selectTools(allowWrites)
      .map((tool) => `  ${tool.name.padEnd(28)} ${tool.title}`)
      .join('\n');
  process.stderr.write(
    [
      'Usage: simply-atlassian-mcp [--allow-writes] [--env-file <path>] [--timeout <ms>]',
      '',
      'Serves the simply-atlassian CLI as MCP tools over stdio. Connection settings come from',
      'the environment (JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN, CONFLUENCE_*, ...) or --env-file.',
      '',
      '  --allow-writes    Also register the tools that change or delete data (off by default).',
      '  --env-file <path> A .env file passed to every CLI call for connection settings.',
      `  --timeout <ms>    Kill a CLI call that runs longer than this (default ${DEFAULT_TIMEOUT_MS}).`,
      '',
      'Read tools (always registered):',
      list(false),
      '',
      'Write tools (with --allow-writes):',
      selectTools(true)
        .filter((tool) => tool.kind !== 'read')
        .map((tool) => `  ${tool.name.padEnd(28)} ${tool.title}`)
        .join('\n'),
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const timeoutMs = values.timeout === undefined ? undefined : Number(values.timeout);
if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
  process.stderr.write(`--timeout must be a positive integer number of milliseconds, got "${values.timeout}".\n`);
  process.exit(2);
}

const { startServer } = await import('../lib/index.js');
await startServer({ allowWrites: values['allow-writes'], envFile: values['env-file'], timeoutMs });
