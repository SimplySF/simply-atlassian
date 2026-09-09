#!/usr/bin/env node

// Stdio MCP servers own stdout as the protocol channel, so nothing here (or anywhere under
// src/) may write to it except the transport. Diagnostics go to stderr.
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'allow-writes': { type: 'boolean', default: false },
    'env-file': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

const { selectTools, startServer } = await import('../lib/index.js');

if (values.help) {
  const list = (tools) => tools.map((tool) => `  ${tool.name.padEnd(30)} ${tool.title}`).join('\n');
  process.stderr.write(
    [
      'Usage: simply-atlassian-mcp [--allow-writes] [--env-file <path>]',
      '',
      'Serves Jira and Confluence as MCP tools over stdio, one tool per simply-atlassian CLI',
      'command, calling the same library in-process. Connection settings come from the',
      'environment (JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN, CONFLUENCE_*, ...) or --env-file.',
      '',
      '  --allow-writes    Also register the tools that change or delete data (off by default).',
      '                    ATLASSIAN_READ_ONLY in the environment still refuses every write.',
      '  --env-file <path> A .env file holding connection settings the environment does not.',
      '',
      'Read tools (always registered):',
      list(selectTools(false)),
      '',
      'Write tools (with --allow-writes):',
      list(selectTools(true).filter((tool) => tool.kind !== 'read')),
      '',
    ].join('\n'),
  );
  process.exit(0);
}

try {
  await startServer({ allowWrites: values['allow-writes'], envFile: values['env-file'] });
} catch (error) {
  // A missing or unreadable --env-file is the one failure that can happen before the transport
  // is up; everything else is reported per tool call.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(typeof error?.exitCode === 'number' ? error.exitCode : 1);
}
