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
import { type AtlassianConfig, type ConfigOverrides, resolveJiraConfig } from '../core/config.js';
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
    if (arg === '--jira-api-token' || arg === '--jira-personal-token') remember(argv[index + 1]);
    remember(/^--jira-(?:api|personal)-token=(.+)$/.exec(arg)?.[1]);
  }
  for (const name of ['JIRA_API_TOKEN', 'JIRA_PERSONAL_TOKEN']) remember(process.env[name]);

  let redacted = message;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, '<redacted>');
  return redacted;
}

/** Names the failure for a machine reader: our own errors keep their class name. */
function errorName(error: unknown, oclifExit: number | undefined): string {
  if (error instanceof CliError) return error.name;
  return oclifExit === undefined ? 'Error' : 'UsageError';
}

/** Flags every Jira command inherits. Secrets are accepted but env vars are the documented path. */
const connectionFlags = {
  'env-file': Flags.string({
    char: 'e',
    summary: 'Path to a .env file holding connection settings.',
    description:
      'Loaded before anything else. Variables already present in the environment win, so the ' +
      'file never overrides an explicit export. A path that cannot be read is an error.',
    helpGroup: 'CONNECTION',
  }),
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

export type JiraFlags<T extends typeof Command> = Interfaces.InferredFlags<
  (typeof JiraCommand)['baseFlags'] & T['flags']
>;
export type JiraArgs<T extends typeof Command> = Interfaces.InferredArgs<T['args']>;

/**
 * Base class for Jira commands. Owns the three things every one of them needs and none of them
 * should re-implement: `--json` (oclif prints whatever `run()` returns, verbatim), connection
 * flags resolved into a config, and mapping this CLI's typed errors onto stable exit codes.
 */
export abstract class JiraCommand<T extends typeof Command> extends Command {
  public static override enableJsonFlag = true;
  public static override baseFlags = connectionFlags;

  protected args!: JiraArgs<T>;
  protected flags!: JiraFlags<T>;

  public override async init(): Promise<void> {
    await super.init();
    const { args, flags } = await this.parse({
      flags: this.ctor.flags,
      baseFlags: (super.ctor as typeof JiraCommand).baseFlags,
      enableJsonFlag: this.ctor.enableJsonFlag,
      args: this.ctor.args,
      strict: this.ctor.strict,
    });
    this.args = args as JiraArgs<T>;
    this.flags = flags as JiraFlags<T>;

    // Applied here, before anything reads configuration, so every later lookup sees the file.
    if (this.flags['env-file'] !== undefined) loadEnvFile(this.flags['env-file']);
  }

  protected jira(): JiraClient {
    return new JiraClient(this.jiraConfig());
  }

  /** Explicit flags outrank the environment, which outranks the `--env-file` contents. */
  protected jiraConfig(): AtlassianConfig {
    const overrides: ConfigOverrides = {
      url: this.flags['jira-url'],
      username: this.flags['jira-username'],
      apiToken: this.flags['jira-api-token'],
      personalToken: this.flags['jira-personal-token'],
    };
    return resolveJiraConfig(overrides);
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
}
