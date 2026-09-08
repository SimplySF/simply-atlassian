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

import { createRequire } from 'node:module';
import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { type CliResult, type CliRunner, createCliRunner } from './cli.js';
import { buildArgs, TOOLS, type ToolKind, type ToolSpec } from './tools.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

/** The name this server announces during the MCP `initialize` handshake. */
export const SERVER_NAME = 'simply-atlassian';

/** The version this server announces; always the package version, never a separate constant. */
export const SERVER_VERSION = version;

export interface ServerOptions {
  /**
   * Register the tools that change or delete data. Off by default, so a server launched
   * without thinking about it can only read. The child CLI also gets `ATLASSIAN_READ_ONLY=1`
   * when this is off, so even a write tool reached some other way would be refused.
   */
  readonly allowWrites?: boolean;
  /** A `.env` file passed to every CLI call as `--env-file`, for credentials the host didn't set. */
  readonly envFile?: string;
  /** How long one CLI call may run before it is killed and reported as a timeout. */
  readonly timeoutMs?: number;
  /** Replaces the child-process runner; tests use this to capture the argv each tool builds. */
  readonly runCli?: CliRunner;
}

/** Stable, machine-readable failure categories, mirroring the CLI's exit codes where one applies. */
export type ToolErrorCode = 'config' | 'auth' | 'error' | 'confirm-required' | 'timeout' | 'server';

export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  /** The CLI's error class name, when the failure came from the CLI. */
  readonly name?: string;
  readonly exitCode?: number;
  /** HTTP status, when the instance answered with one. */
  readonly status?: number;
}

const INSTRUCTIONS =
  'Tools wrap the simply-atlassian CLI, one tool per command, and return the raw Atlassian API ' +
  'payload as JSON text. Only read tools are registered unless the server was started with ' +
  '--allow-writes. Every write tool accepts dryRun: true to preview the request without sending ' +
  'it, and the irreversible ones (deletes) additionally require confirm: true. Failures come back ' +
  'as isError results whose text is JSON with a stable "code": config, auth, error, ' +
  'confirm-required, timeout, or server. Prefer "fields" on issue tools to keep payloads small.';

const ANNOTATIONS: Readonly<Record<ToolKind, ToolAnnotations>> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

/** Which tools a server with the given options registers. Exported so the CLI's `--help` can list them. */
export function selectTools(allowWrites: boolean): readonly ToolSpec[] {
  return allowWrites ? TOOLS : TOOLS.filter((tool) => tool.kind === 'read');
}

/**
 * Builds the MCP server with its metadata and tools registered, but not yet connected to a
 * transport. Kept separate from {@link startServer} so tests can attach an in-memory transport
 * and a host process can embed the server over whatever transport it runs.
 */
export function createServer(options: ServerOptions = {}): McpServer {
  const allowWrites = options.allowWrites ?? false;
  const runCli =
    options.runCli ??
    createCliRunner({
      env: allowWrites ? process.env : { ...process.env, ATLASSIAN_READ_ONLY: '1' },
      timeoutMs: options.timeoutMs,
    });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  for (const spec of selectTools(allowWrites)) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: { title: spec.title, ...ANNOTATIONS[spec.kind] },
      },
      (input) => invokeTool(spec, input, runCli, options.envFile),
    );
  }

  return server;
}

/**
 * Creates the server and serves it over stdio, which is how MCP clients such as Claude Desktop,
 * Claude Code, and Cursor launch a local server. Resolves once the transport is connected; the
 * process then stays alive until the client closes the stream.
 */
export async function startServer(options: ServerOptions = {}): Promise<McpServer> {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * Runs one tool call end to end: the `confirm` gate, the CLI invocation, and the mapping of what
 * the CLI produced onto a tool result. Never throws for a CLI failure — those are `isError`
 * results the agent can read and act on — and only lets a genuine bug propagate.
 */
async function invokeTool(
  spec: ToolSpec,
  input: Readonly<Record<string, unknown>>,
  runCli: CliRunner,
  envFile: string | undefined,
): Promise<CallToolResult> {
  // Gated here, before anything is spawned, so a call without consent never reaches the CLI
  // even though the CLI would refuse it too. `dryRun` is exempt: previewing needs no consent.
  if (spec.kind === 'destructive' && input.dryRun !== true && input.confirm !== true) {
    return errorResult({
      code: 'confirm-required',
      message: `${spec.title} cannot be undone. Pass confirm: true to proceed, or dryRun: true to preview.`,
    });
  }

  const args = [
    ...spec.command,
    ...buildArgs(spec, input),
    ...(input.dryRun === true ? ['--dry-run'] : []),
    ...(spec.kind === 'destructive' && input.confirm === true ? ['--confirm'] : []),
    '--json',
    ...(envFile === undefined ? [] : ['--env-file', envFile]),
  ];

  let result: CliResult;
  try {
    result = await runCli(args);
  } catch (error) {
    return errorResult({
      code: 'server',
      message: `Could not run the simply-atlassian CLI: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (result.timedOut) {
    return errorResult({ code: 'timeout', message: `${spec.title} did not finish in time and was stopped.` });
  }

  if (result.exitCode !== 0) {
    return errorResult(mapCliError(result));
  }

  // oclif prints whatever `run()` returned as JSON; hand it through untouched so the payload
  // shape stays Atlassian's contract, not this server's.
  const text = result.stdout.trim();
  return { content: [{ type: 'text', text: text === '' ? 'null' : text }] };
}

interface CliErrorLine {
  readonly error?: {
    readonly name?: string;
    readonly message?: string;
    readonly exitCode?: number;
    readonly status?: number;
  };
}

/**
 * Reads the CLI's single-line JSON error from stderr. The CLI guarantees that shape under
 * `--json`, but a crash before its error handler (or a Node startup failure) can still produce
 * plain text, so anything unparseable is passed along as the message rather than dropped.
 */
export function mapCliError(result: CliResult): ToolError {
  const exitCode = result.exitCode ?? 1;
  const code: ToolErrorCode = exitCode === 2 ? 'config' : exitCode === 3 ? 'auth' : 'error';

  const lines = result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const lastLine = lines.at(-1);

  if (lastLine?.startsWith('{')) {
    try {
      const parsed = JSON.parse(lastLine) as CliErrorLine;
      if (parsed.error?.message !== undefined) {
        return {
          code,
          message: parsed.error.message,
          name: parsed.error.name,
          exitCode: parsed.error.exitCode ?? exitCode,
          ...(parsed.error.status === undefined ? {} : { status: parsed.error.status }),
        };
      }
    } catch {
      // Not JSON after all; fall through to the plain-text path.
    }
  }

  return {
    code,
    message: lines.length === 0 ? `The CLI exited with code ${exitCode}.` : lines.join('\n'),
    exitCode,
  };
}

function errorResult(error: ToolError): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
}
