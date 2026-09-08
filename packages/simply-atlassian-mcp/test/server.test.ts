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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_NAME, SERVER_VERSION, createServer } from '../src/index.js';

const { version: packageVersion } = createRequire(import.meta.url)('../package.json') as { version: string };

describe('createServer', () => {
  const client = new Client({ name: 'test-client', version: '0.0.0' });

  afterEach(async () => {
    await client.close();
  });

  it('announces the package name and version during the initialize handshake', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()).toEqual({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(SERVER_VERSION).toBe(packageVersion);

    await server.close();
  });

  // The SDK only advertises the `tools` capability once a tool is registered, and a client's
  // `listTools` against a server without it is rejected as "method not found" — so the scaffold's
  // "no tools yet" state is visible in the handshake, not in an empty list. When the first tool
  // lands (design doc 0007), this becomes a `listTools` assertion on the expected names.
  it('advertises no tools capability yet', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerCapabilities()?.tools).toBeUndefined();
    await expect(client.listTools()).rejects.toThrow(/Method not found/);

    await server.close();
  });
});
