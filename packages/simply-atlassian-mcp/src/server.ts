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

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

/** The name this server announces during the MCP `initialize` handshake. */
export const SERVER_NAME = 'simply-atlassian';

/** The version this server announces; always the package version, never a separate constant. */
export const SERVER_VERSION = version;

/**
 * Builds the MCP server with its metadata and every tool registered, but not yet connected to a
 * transport. Kept separate from {@link startServer} so tests can attach an in-memory transport
 * and a host process can embed the server over whatever transport it runs.
 *
 * No tools are registered yet: which CLI commands become tools, how they're grouped, and how
 * credentials and write safety carry over are decided in docs/design/0007-mcp-server.md before
 * they're implemented here.
 */
export function createServer(): McpServer {
  return new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
}

/**
 * Creates the server and serves it over stdio, which is how MCP clients such as Claude Desktop,
 * Claude Code, and Cursor launch a local server. Resolves once the transport is connected; the
 * process then stays alive until the client closes the stream.
 */
export async function startServer(): Promise<McpServer> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  return server;
}
