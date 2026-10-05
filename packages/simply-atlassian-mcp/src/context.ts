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

import process from 'node:process';
import {
  type AtlassianConfig,
  ConfluenceClient,
  createXrayBackend,
  defaultXrayCacheDir,
  type EnvLike,
  JiraClient,
  loadEnvFile,
  resolveConfluenceConfig,
  resolveJiraConfig,
  stripControlOneLine,
  type XrayBackend,
} from '@simplysf/simply-atlassian-core';

export interface ServerOptions {
  /**
   * Register the tools that change or delete data. Off by default, so a server launched
   * without thinking about it can only read. Even when on, a write is still refused when the
   * environment carries `ATLASSIAN_READ_ONLY`, exactly as the CLI refuses it.
   */
  readonly allowWrites?: boolean;
  /**
   * Register the Xray tools. Off by default: a host lists every registered tool to its model, most
   * people running this server have no Xray, and Xray Server/Data Center needs no settings of its
   * own that could be detected instead.
   */
  readonly xray?: boolean;
  /**
   * A `.env` file holding connection settings the host did not set. Loaded once, at startup,
   * with the CLI's precedence: a variable already in the environment wins over the file.
   */
  readonly envFile?: string;
  /** The environment to read settings from. Defaults to this process's; tests pass their own. */
  readonly env?: EnvLike;
}

/**
 * What every tool handler gets: the environment its settings come from, and clients built from
 * it on demand. Clients are built per call rather than at startup so a missing or wrong setting
 * is reported by the tool that needed it — the same moment the CLI would report it — and so a
 * server configured for only one product still serves that product's tools.
 */
export interface ToolContext {
  readonly env: EnvLike;
  readonly allowWrites: boolean;
  readonly xrayEnabled: boolean;
  jiraConfig(): AtlassianConfig;
  jira(): JiraClient;
  confluenceConfig(): AtlassianConfig;
  confluence(): ConfluenceClient;
  /** Xray on the configured Jira, with the instance record in the CLI's default cache directory. */
  xray(): XrayBackend;
}

/** Builds the context, loading the env file first so every later lookup sees it. */
export function createContext(options: ServerOptions = {}): ToolContext {
  const env = options.env ?? process.env;
  if (options.envFile !== undefined) loadEnvFile(options.envFile, env);

  return {
    env,
    allowWrites: options.allowWrites ?? false,
    xrayEnabled: options.xray ?? false,
    jiraConfig: () => resolveJiraConfig({}, env),
    jira: () => new JiraClient(resolveJiraConfig({}, env)),
    confluenceConfig: () => resolveConfluenceConfig({}, env),
    confluence: () => new ConfluenceClient(resolveConfluenceConfig({}, env)),
    xray: () =>
      createXrayBackend(resolveJiraConfig({}, env), {
        cacheDir: defaultXrayCacheDir(env),
        // stderr, never stdout: stdout is the protocol channel. A host shows this in its server log.
        onWarning: (message) => process.stderr.write(`${stripControlOneLine(message)}\n`),
      }),
  };
}
