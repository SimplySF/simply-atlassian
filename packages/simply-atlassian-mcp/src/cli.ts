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

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

/** What one CLI invocation produced. `exitCode` is `null` only when the process was killed. */
export interface CliResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Runs the CLI with the given arguments (everything after `simply`) and resolves with what it
 * produced. Rejects only when the process could not be started at all; a non-zero exit is a
 * normal result, because the CLI's exit codes and stderr JSON are the contract this server maps
 * onto tool results.
 */
export type CliRunner = (args: readonly string[]) => Promise<CliResult>;

export interface CliRunnerOptions {
  /** Path to the CLI's `bin/run.js`. Defaults to {@link resolveCliBin}. */
  readonly bin?: string;
  /** Environment for the child. Defaults to this process's environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** How long one invocation may run before it is killed. */
  readonly timeoutMs?: number;
}

/** Long enough for a paged search against a slow instance; short enough that a hung call fails. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Grace between SIGTERM and SIGKILL when a call overruns its timeout. */
const KILL_GRACE_MS = 2_000;

/**
 * Locates the CLI's entry script. `@simplysf/simply-atlassian` is a dependency of this package,
 * so the binary is always present at a known place relative to its main export — no reliance on
 * PATH, a global install, or whichever `simply` a shell would find first. `SIMPLY_ATLASSIAN_BIN`
 * overrides it, for running against a checkout or a different build.
 */
export function resolveCliBin(): string {
  const override = process.env.SIMPLY_ATLASSIAN_BIN;
  if (override !== undefined && override !== '') return override;

  // The CLI package's `exports` exposes only its main entry, so resolve that and walk to bin/.
  const mainEntry = createRequire(import.meta.url).resolve('@simplysf/simply-atlassian');
  return path.join(path.dirname(mainEntry), '..', 'bin', 'run.js');
}

/**
 * Builds a {@link CliRunner} that spawns the CLI as a child process, one per call. The child is
 * started with this process's own Node executable so a host that launched the server with a
 * particular Node uses the same one for the CLI. Stdin is closed: nothing the CLI does reads it,
 * and an inherited stdin would be the MCP protocol stream.
 */
export function createCliRunner(options: CliRunnerOptions = {}): CliRunner {
  const bin = options.bin ?? resolveCliBin();
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return (args) =>
    new Promise<CliResult>((resolve, reject) => {
      const child = spawn(process.execPath, [bin, ...args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      child.on('error', (error) => {
        clearTimeout(killTimer);
        reject(error);
      });
      child.on('close', (exitCode) => {
        clearTimeout(killTimer);
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
        });
      });
    });
}
