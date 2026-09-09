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

import { ConfigError } from './errors.js';

/** A remote link as Jira reports it. */
export interface RemoteLink {
  readonly id?: number | string;
  readonly globalId?: string;
  readonly relationship?: string;
  readonly object?: {
    readonly url?: string;
    readonly title?: string;
    readonly summary?: string;
  };
}

export interface RemoteLinkInput {
  readonly url: string;
  readonly title?: string;
  readonly summary?: string;
  /** How the issue relates to the target — Jira renders this as the section heading. */
  readonly relationship?: string;
}

/** Schemes a remote link may point at. A stored link outlives the command that wrote it. */
const SAFE_SCHEMES = new Set(['http:', 'https:']);

/**
 * Builds the body for a remote link.
 *
 * This is the missing half of connecting Jira to Confluence. A page can carry a hyperlink to a
 * ticket by writing an `<a href>` into its body, but that is one-directional and invisible to
 * Jira: nothing can ask which pages reference an issue. A remote link is the other direction, and
 * Jira renders it in the issue's own "Links" section.
 *
 * `globalId` is deliberately set from the URL. Jira treats it as the link's identity, so posting
 * the same URL twice updates the existing link rather than adding a duplicate — which is what a
 * caller re-running a script expects, and what they would not get from an auto-assigned id.
 */
export function buildRemoteLinkBody(input: RemoteLinkInput): Record<string, unknown> {
  const url = input.url.trim();
  if (url === '') throw new ConfigError('A remote link needs a --url.');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`"${url}" is not a URL. Remote links need an absolute http or https URL.`);
  }
  if (!SAFE_SCHEMES.has(parsed.protocol)) {
    throw new ConfigError(
      `The link scheme "${parsed.protocol}" is not allowed; remote links must be http or https. ` +
        'The link stays on the issue for everyone who opens it.',
    );
  }

  const object: Record<string, unknown> = { url, title: input.title ?? url };
  if (input.summary !== undefined) object.summary = input.summary;

  const body: Record<string, unknown> = { globalId: url, object };
  if (input.relationship !== undefined) body.relationship = input.relationship;
  return body;
}

/** Renders one link as a row: what it points at, and how the issue relates to it. */
export function describeRemoteLink(link: RemoteLink): {
  id: string | undefined;
  relationship: string;
  title: string | undefined;
  url: string | undefined;
} {
  return {
    id: link.id === undefined ? undefined : String(link.id),
    // Jira leaves this unset for a plain link and renders it as "links to".
    relationship: link.relationship ?? 'links to',
    title: link.object?.title,
    url: link.object?.url,
  };
}
