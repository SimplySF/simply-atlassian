#!/usr/bin/env node

// Stdio MCP servers own stdout as the protocol channel, so nothing here (or anywhere under
// src/) may write to it except the transport. Diagnostics go to stderr.
const { startServer } = await import('../lib/index.js');

await startServer();
