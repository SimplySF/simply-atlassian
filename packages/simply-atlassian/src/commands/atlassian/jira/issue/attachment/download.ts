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

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Args, Flags } from '@oclif/core';
import {
  CliError,
  describeAttachment,
  formatBytes,
  planAttachmentDownloads,
  saveAttachment,
  selectAttachments,
  type JiraAttachment,
} from '@simplysf/simply-atlassian-core';
import { JiraCommand, parseMultiList, stderrLine } from '../../../../../shared/base-command.js';

export interface DownloadedFile {
  readonly id: string;
  readonly filename: string;
  readonly path: string;
  readonly size: number;
  readonly mimeType?: string;
}

export interface DownloadResult {
  readonly directory?: string;
  readonly files: DownloadedFile[];
}

export default class JiraIssueAttachmentDownload extends JiraCommand<typeof JiraIssueAttachmentDownload> {
  public static override readonly summary = "Download an issue's attachments to a directory, or one to stdout.";
  public static override readonly description =
    'Downloads every attachment on the issue, or the ones --id names, into --output-dir (default: ' +
    'the current directory). Files are streamed, so there is no size limit, and each is written under ' +
    'a temporary name first, so an interrupted download never leaves a partial file under the real ' +
    'name.\n\n' +
    'Every id is checked against the issue, and every target file against the disk, before anything ' +
    'is downloaded: an unknown id or an existing file stops the command, and --overwrite allows the ' +
    'latter. File names are made safe for Windows and POSIX, and two attachments with the same name ' +
    'are told apart by id, as "name (id).ext".\n\n' +
    "--stdout writes one attachment's raw bytes to stdout, for a pipe or a redirect; it refuses to " +
    'write to a terminal, because a file can contain escape sequences. Progress goes to stderr.';

  public static override readonly examples = [
    '<%= config.bin %> <%= command.id %> PROJ-123',
    '<%= config.bin %> <%= command.id %> PROJ-123 --id 10234,10235 --output-dir ./evidence',
    '<%= config.bin %> <%= command.id %> PROJ-123 --id 10234 --stdout | less',
  ];

  public static override readonly args = {
    issue: Args.string({ description: 'Issue key, for example PROJ-123.', required: true }),
  };

  public static override readonly flags = {
    id: Flags.string({
      summary: 'Attachment id to download, as "attachment list" shows. Comma-separated or repeatable.',
      description: 'Default: every attachment on the issue.',
      multiple: true,
    }),
    'output-dir': Flags.string({
      char: 'o',
      summary: 'Directory to write into. Created if missing. Default: the current directory.',
      exclusive: ['stdout'],
    }),
    overwrite: Flags.boolean({
      summary: 'Replace files that already exist. Without it, an existing file stops the command.',
      exclusive: ['stdout'],
    }),
    stdout: Flags.boolean({
      summary: "Stream the one selected attachment's bytes to stdout instead of a file.",
    }),
  };

  /** Where `--stdout` writes. A seam so tests can capture the bytes. */
  protected output: NodeJS.WriteStream = process.stdout;

  public async run(): Promise<DownloadResult> {
    const { issue } = this.args;
    const attachments = (await this.jira().getAttachments(issue)).map((raw) => describeAttachment(raw));
    const ids = parseMultiList(this.flags.id);

    if (this.flags.stdout) return this.toStdout(selectAttachments(attachments, issue, ids));

    if (attachments.length === 0) {
      this.logSafe(`No attachments on ${issue}.`);
      return { directory: undefined, files: [] };
    }

    const directory = path.resolve(this.flags['output-dir'] ?? '.');
    const plan = planAttachmentDownloads(attachments, {
      issueKey: issue,
      ids,
      directory,
      overwrite: this.flags.overwrite,
    });
    mkdirSync(directory, { recursive: true });

    const json = this.jsonEnabled();
    const files: DownloadedFile[] = [];
    /* One file at a time: the plan's order is the order a person watching progress expects. */
    /* eslint-disable no-await-in-loop */
    for (const { attachment, path: file } of plan) {
      let size: number;
      try {
        size = await saveAttachment(this.jira(), attachment, file, { overwrite: this.flags.overwrite });
      } catch (error) {
        // Kept as the same error, so its exit code and --json shape are unchanged.
        if (error instanceof Error) {
          error.message += ` ${files.length} of ${plan.length} attachment(s) were written before this failure.`;
        }
        throw error;
      }
      files.push({ id: attachment.id, filename: attachment.filename, path: file, size, mimeType: attachment.mimeType });
      if (!json) stderrLine(`downloaded ${path.basename(file)} (${formatBytes(size) ?? `${size} B`})`);
    }
    /* eslint-enable no-await-in-loop */

    this.logSafe(`Downloaded ${files.length} attachment(s) to ${directory}.`);
    return { directory, files };
  }

  private async toStdout(selected: JiraAttachment[]): Promise<DownloadResult> {
    if (this.jsonEnabled()) {
      throw new CliError(
        '--stdout cannot be combined with --json: stdout cannot carry both the file and the result.',
        2,
      );
    }
    const [attachment] = selected;
    if (attachment === undefined || selected.length > 1) {
      throw new CliError(
        `--stdout writes exactly one attachment, and ${selected.length} are selected. Name one with --id.`,
        2,
      );
    }
    const out = this.output;
    if (out.isTTY) {
      throw new CliError(
        '--stdout refuses to write to a terminal, because a file can contain escape sequences. ' +
          'Pipe or redirect it, or use --output-dir.',
        2,
      );
    }

    const response = await this.jira().openAttachment(attachment);
    let size = 0;
    try {
      for await (const chunk of response.body) {
        await write(out, chunk);
        size += chunk.byteLength;
      }
    } catch (error) {
      // Bytes have already gone out, so restarting would duplicate them: say so and stop.
      const reason = error instanceof Error ? error.message : String(error);
      throw new CliError(`${attachment.filename} stopped after ${size} bytes; the output is incomplete. ${reason}`);
    }
    stderrLine(`downloaded ${attachment.filename} (${formatBytes(size) ?? `${size} B`})`);
    return {
      files: [{ id: attachment.id, filename: attachment.filename, path: '-', size, mimeType: attachment.mimeType }],
    };
  }
}

function write(out: NodeJS.WritableStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    out.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}
