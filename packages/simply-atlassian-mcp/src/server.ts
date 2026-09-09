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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  assertWritesAllowed,
  AuthError,
  CliError,
  ConfigError,
  HttpError,
  redactSecrets,
  sanitiseDeep,
  secretValues,
  stripControl,
} from '@simplysf/simply-atlassian-core';
import { createContext, type ServerOptions, type ToolContext } from './context.js';
import { TOOLS, type ToolKind, type ToolSpec } from './tools.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

/** The name this server announces during the MCP `initialize` handshake. */
export const SERVER_NAME = 'simply-atlassian';

/** The version this server announces; always the package version, never a separate constant. */
export const SERVER_VERSION = version;

/**
 * Stable, machine-readable failure categories. The first three mirror the CLI's exit codes
 * (2, 3, and 1); `confirm-required` is this server's own gate.
 */
export type ToolErrorCode = 'config' | 'auth' | 'error' | 'confirm-required';

/** The JSON object an `isError` result carries: the same fields as the CLI's `--json` error line. */
export interface ToolError {
  readonly code: ToolErrorCode;
  readonly name: string;
  readonly message: string;
  readonly exitCode: number;
  /** HTTP status, when the instance answered with one. */
  readonly status?: number;
  /** The response body, sanitised the same way the message is, when the instance sent one. */
  readonly body?: unknown;
}

const INSTRUCTIONS =
  'Tools mirror the simply-atlassian CLI one to one and return the raw Atlassian API payload as ' +
  'JSON text, calling the same library the CLI is built on. Only read tools are registered unless ' +
  'the server was started with --allow-writes. Every write tool accepts dryRun: true to preview ' +
  'the request without sending it, and the irreversible ones (issue and comment deletes, and a ' +
  'page purge) additionally require confirm: true. Failures come back as isError results whose ' +
  'text is JSON with a stable "code": config, auth, error, or confirm-required. Prefer "fields" ' +
  'on issue tools to keep payloads small.';

const ANNOTATIONS: Readonly<Record<ToolKind, ToolAnnotations>> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

/** Which tools a server with the given options registers. Exported so `--help` can list them. */
export function selectTools(allowWrites: boolean): readonly ToolSpec[] {
  return allowWrites ? TOOLS : TOOLS.filter((tool) => tool.kind === 'read');
}

/**
 * Builds the MCP server with its metadata and tools registered, but not yet connected to a
 * transport. Kept separate from {@link startServer} so tests can attach an in-memory transport
 * and a host process can embed the server over whatever transport it runs.
 */
export function createServer(options: ServerOptions = {}): McpServer {
  const context = createContext(options);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  for (const spec of selectTools(context.allowWrites)) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: { title: spec.title, ...ANNOTATIONS[spec.kind] },
      },
      (input) => invokeTool(spec, context, input),
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
 * Runs one tool call end to end: the `confirm` gate, the read-only guard, the operation, and
 * the mapping of a failure onto a tool result. Never throws for an operational failure — those
 * are `isError` results the agent can read and act on — and only lets a genuine bug propagate.
 */
export async function invokeTool(
  spec: ToolSpec,
  context: ToolContext,
  input: Readonly<Record<string, unknown>>,
): Promise<CallToolResult> {
  // Gated here, before anything is looked up, so a call without consent never reaches the
  // instance even though the operation would refuse it too. `dryRun` is exempt: previewing
  // needs no consent.
  const needsConfirm = spec.kind === 'destructive' && (spec.requiresConfirm?.(input) ?? true);
  if (needsConfirm && input.dryRun !== true && input.confirm !== true) {
    return errorResult({
      code: 'confirm-required',
      name: 'ConfirmRequired',
      message: `${spec.title} cannot be undone. Pass confirm: true to proceed, or dryRun: true to preview.`,
      exitCode: 2,
    });
  }

  try {
    // The same guard the CLI applies before any write command runs, so a host that enables
    // writes but points the server at a read-only credential file still gets the refusal.
    if (spec.kind !== 'read') assertWritesAllowed(context.env);
    const result = await spec.run(context, input);
    // Handed through untouched so the payload shape stays Atlassian's contract, not this server's.
    return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
  } catch (error) {
    return errorResult(mapError(error, context));
  }
}

/**
 * Turns a failure into the same object the CLI writes to stderr under `--json`, with the same
 * scrubbing: the message and any response body are redacted of credentials and stripped of
 * control characters before they reach an agent's context.
 */
export function mapError(error: unknown, context: Pick<ToolContext, 'env'>): ToolError {
  const secrets = secretValues(context.env);
  const clean = (text: string): string => stripControl(redactSecrets(text, secrets));
  const message = clean(error instanceof Error ? error.message : String(error));

  if (error instanceof ConfigError) return { code: 'config', name: error.name, message, exitCode: error.exitCode };
  if (error instanceof AuthError) {
    return { code: 'auth', name: error.name, message, exitCode: error.exitCode, status: error.status };
  }
  if (error instanceof HttpError) {
    return {
      code: 'error',
      name: error.name,
      message,
      exitCode: error.exitCode,
      status: error.status,
      body: sanitiseDeep(error.body, secrets),
    };
  }
  if (error instanceof CliError) return { code: 'error', name: error.name, message, exitCode: error.exitCode };
  return { code: 'error', name: 'Error', message, exitCode: 1 };
}

function errorResult(error: ToolError): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
}
