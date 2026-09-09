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

import { spawn } from 'node:child_process';
import process from 'node:process';

export interface OpenInBrowserOptions {
  readonly print: boolean;
  readonly log: (url: string) => void;
}

interface BrowserOpener {
  readonly command: string;
  readonly args: string[];
  readonly shell?: boolean;
}

function browserOpener(url: string): BrowserOpener {
  if (process.platform === 'darwin') return { command: 'open', args: [url] };
  if (process.platform === 'win32') {
    // `start` is a cmd.exe built-in, so shell mode is required on Windows.
    return { command: 'start', args: [url], shell: true };
  }
  return { command: 'xdg-open', args: [url] };
}

function shouldPrintInsteadOfLaunching(): boolean {
  if (process.env.CI !== undefined) return true;
  return process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

/** Opens a URL and prints it when the browser cannot be launched. */
export function openInBrowser(url: string, options: OpenInBrowserOptions): void {
  if (options.print || shouldPrintInsteadOfLaunching()) {
    options.log(url);
    return;
  }

  const opener = browserOpener(url);
  try {
    const child = spawn(opener.command, opener.args, {
      detached: true,
      shell: opener.shell,
      stdio: 'ignore',
    });
    let didPrint = false;
    const printUrl = (): void => {
      if (!didPrint) {
        didPrint = true;
        options.log(url);
      }
    };
    child.once('error', printUrl);
    child.once('exit', (code) => {
      if (code !== 0) printUrl();
    });
  } catch {
    options.log(url);
  }
}
