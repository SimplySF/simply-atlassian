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

import process from 'node:process';
import { Command, Flags, type Interfaces } from '@oclif/core';
import {
  type AtlassianConfig,
  type ConfigOverrides,
  resolveConfluenceConfig,
  resolveJiraConfig,
} from '../core/config.js';
import { ConfluenceClient } from '../core/confluence-client.js';
import { loadEnvFile } from '../core/env-file.js';
import { AuthError, CliError, HttpError } from '../core/errors.js';
import { JiraClient } from '../core/jira-client.js';
import { stripControl } from './output.js';

/**
 * Splits a comma-separated flag value, dropping blanks. `--fields ''` and `--fields 'a,'`
 * would otherwise yield an empty field name, which Jira rejects outright (and which, on Cloud,
 * suppresses the client's own default field set).
 */
export function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length === 0 ? undefined : items;
}

/** Credential flags, used both to declare them and to scrub their values out of any output. */
const SECRET_FLAGS = new Set([
  'jira-api-token',
  'jira-personal-token',
  'confluence-api-token',
  'confluence-personal-token',
]);
const SECRET_ENV = ['JIRA_API_TOKEN', 'JIRA_PERSONAL_TOKEN', 'CONFLUENCE_API_TOKEN', 'CONFLUENCE_PERSONAL_TOKEN'];

/**
 * Blanks out any credential that could otherwise ride along in an error message. Values are
 * collected from the process arguments and environment rather than parsed flags, because the
 * errors most likely to echo an argument are the ones thrown before parsing finishes.
 */
function redactSecrets(message: string): string {
  const secrets = new Set<string>();
  const remember = (value: string | undefined): void => {
    // Short values would mangle unrelated text; real tokens are far longer than this.
    if (value !== undefined && value.length >= 8) secrets.add(value);
  };

  const argv = process.argv;
  for (const [index, arg] of argv.entries()) {
    if (arg.startsWith('--') && SECRET_FLAGS.has(arg.slice(2))) remember(argv[index + 1]);
    const inline = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (inline?.[1] !== undefined && SECRET_FLAGS.has(inline[1])) remember(inline[2]);
  }
  for (const name of SECRET_ENV) remember(process.env[name]);

  let redacted = message;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, '<redacted>');
  return redacted;
}

/** Names the failure for a machine reader: our own errors keep their class name. */
function errorName(error: unknown, oclifExit: number | undefined): string {
  if (error instanceof CliError) return error.name;
  return oclifExit === undefined ? 'Error' : 'UsageError';
}

/** Shared by every command regardless of product. */
const envFileFlag = {
  'env-file': Flags.string({
    char: 'e',
    summary: 'Path to a .env file holding connection settings.',
    description:
      'Loaded before anything else. Variables already present in the environment win, so the ' +
      'file never overrides an explicit export, and only Atlassian connection variables are ' +
      'read from it. A path that cannot be read is an error.',
    helpGroup: 'CONNECTION',
  }),
};

const jiraFlags = {
  ...envFileFlag,
  'jira-url': Flags.string({
    summary: 'Base URL of the Jira instance.',
    env: 'JIRA_URL',
    helpGroup: 'CONNECTION',
  }),
  'jira-username': Flags.string({
    summary: 'Account email for Jira Cloud basic auth.',
    env: 'JIRA_USERNAME',
    helpGroup: 'CONNECTION',
  }),
  'jira-api-token': Flags.string({
    summary: 'API token for Jira Cloud basic auth.',
    env: 'JIRA_API_TOKEN',
    helpGroup: 'CONNECTION',
  }),
  'jira-personal-token': Flags.string({
    summary: 'Personal access token for Jira Server/Data Center.',
    env: 'JIRA_PERSONAL_TOKEN',
    helpGroup: 'CONNECTION',
  }),
};

const confluenceFlags = {
  ...envFileFlag,
  'confluence-url': Flags.string({
    summary: 'Base URL of the Confluence instance.',
    env: 'CONFLUENCE_URL',
    helpGroup: 'CONNECTION',
  }),
  'confluence-username': Flags.string({
    summary: 'Account email for Confluence Cloud basic auth.',
    env: 'CONFLUENCE_USERNAME',
    helpGroup: 'CONNECTION',
  }),
  'confluence-api-token': Flags.string({
    summary: 'API token for Confluence Cloud basic auth.',
    env: 'CONFLUENCE_API_TOKEN',
    helpGroup: 'CONNECTION',
  }),
  'confluence-personal-token': Flags.string({
    summary: 'Personal access token for Confluence Server/Data Center.',
    env: 'CONFLUENCE_PERSONAL_TOKEN',
    helpGroup: 'CONNECTION',
  }),
};

export type JiraFlags<T extends typeof Command> = Interfaces.InferredFlags<typeof jiraFlags & T['flags']>;
export type ConfluenceFlags<T extends typeof Command> = Interfaces.InferredFlags<typeof confluenceFlags & T['flags']>;
export type CommandArgs<T extends typeof Command> = Interfaces.InferredArgs<T['args']>;

/**
 * Everything neither product owns: `--json` (oclif prints whatever `run()` returns, verbatim),
 * `--env-file` loading, and turning failures into stable exit codes without letting anything
 * reach stdout. Product subclasses add only their own connection flags, so the behaviour proven
 * once here — in particular the error handling below — cannot drift between products.
 */
export abstract class AtlassianCommand<T extends typeof Command> extends Command {
  public static override enableJsonFlag = true;
  public static override baseFlags = envFileFlag;

  protected args!: CommandArgs<T>;
  protected rawFlags: Record<string, unknown> = {};

  public override async init(): Promise<void> {
    await super.init();
    const { args, flags } = await this.parse({
      // The subclass's own baseFlags, so a Jira command never offers Confluence flags.
      baseFlags: (this.constructor as typeof AtlassianCommand).baseFlags,
      flags: this.ctor.flags,
      enableJsonFlag: this.ctor.enableJsonFlag,
      args: this.ctor.args,
      strict: this.ctor.strict,
    });
    this.args = args as CommandArgs<T>;
    this.rawFlags = flags;

    // Applied here, before anything reads configuration, so every later lookup sees the file.
    const envFile = this.rawFlags['env-file'];
    if (typeof envFile === 'string') loadEnvFile(envFile);
  }

  /**
   * Turns any failure into one compact, machine-readable line on stderr plus a stable exit
   * code, and never lets a failure reach stdout.
   *
   * This has to cover *every* error, not just this CLI's own: oclif's default `--json` error
   * path serializes its whole parse context — including the raw argv, and therefore any token
   * passed as a flag — to stdout. For a caller that captures stdout into an AI agent's
   * context, that is a credential disclosure, so the default path is never taken here.
   *
   * Exit codes stay identical with and without `--json`: 2 config or usage, 3 auth, 1
   * everything else.
   */
  protected override async catch(error: Interfaces.CommandError): Promise<unknown> {
    // oclif attaches its own exit code to usage errors; reuse it so --json and plain runs agree.
    const oclifExit = (error as { oclif?: { exit?: number } }).oclif?.exit;
    const exitCode = error instanceof CliError ? error.exitCode : (oclifExit ?? 1);
    // Error text can quote a server response body, which is as attacker-influenced as any
    // other field the instance returns.
    const message = stripControl(redactSecrets(error.message));

    if (this.jsonEnabled()) {
      // Written straight to the stream: oclif silences this.log/logToStderr under --json.
      process.stderr.write(
        `${JSON.stringify({
          error: {
            name: errorName(error, oclifExit),
            message,
            exitCode,
            ...(error instanceof HttpError ? { status: error.status, body: error.body } : {}),
            ...(error instanceof AuthError ? { status: error.status } : {}),
          },
        })}\n`,
      );
      this.exit(exitCode);
    }

    if (error instanceof CliError) {
      this.error(message, { exit: exitCode, code: error.name });
    }
    return super.catch(error);
  }

  /** Narrowed accessor so subclasses read flags without casting at every use. */
  protected flagValue(name: string): string | undefined {
    const value = this.rawFlags[name];
    return typeof value === 'string' ? value : undefined;
  }
}

/** Base for Jira commands: adds the `--jira-*` connection flags. */
export abstract class JiraCommand<T extends typeof Command> extends AtlassianCommand<T> {
  public static override baseFlags = jiraFlags;

  protected get flags(): JiraFlags<T> {
    return this.rawFlags as JiraFlags<T>;
  }

  protected jira(): JiraClient {
    return new JiraClient(this.jiraConfig());
  }

  /** Explicit flags outrank the environment, which outranks the `--env-file` contents. */
  protected jiraConfig(): AtlassianConfig {
    const overrides: ConfigOverrides = {
      url: this.flagValue('jira-url'),
      username: this.flagValue('jira-username'),
      apiToken: this.flagValue('jira-api-token'),
      personalToken: this.flagValue('jira-personal-token'),
    };
    return resolveJiraConfig(overrides);
  }
}

/** Base for Confluence commands: adds the `--confluence-*` connection flags. */
export abstract class ConfluenceCommand<T extends typeof Command> extends AtlassianCommand<T> {
  public static override baseFlags = confluenceFlags;

  protected get flags(): ConfluenceFlags<T> {
    return this.rawFlags as ConfluenceFlags<T>;
  }

  protected confluence(): ConfluenceClient {
    return new ConfluenceClient(this.confluenceConfig());
  }

  /** Explicit flags outrank the environment, which outranks the `--env-file` contents. */
  protected confluenceConfig(): AtlassianConfig {
    const overrides: ConfigOverrides = {
      url: this.flagValue('confluence-url'),
      username: this.flagValue('confluence-username'),
      apiToken: this.flagValue('confluence-api-token'),
      personalToken: this.flagValue('confluence-personal-token'),
    };
    return resolveConfluenceConfig(overrides);
  }
}
