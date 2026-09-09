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

import { ConfigError } from './errors.js';
import type { JiraClient } from './jira-client.js';
import { type IssueLink, type LinkTypesResponse, type ResolvedLink, resolveLinkDirection } from './issue-links.js';
import { stripControlOneLine } from './text.js';

/** A link request ready to POST, plus the resolution it was built from for whoever reports it. */
export interface IssueLinkRequest {
  readonly body: Record<string, unknown>;
  readonly resolved: ResolvedLink;
}

/** What `link create` reports: the relationship as the caller said it, not as the payload is shaped. */
export interface IssueLinkCreated {
  readonly from: string;
  readonly to: string;
  readonly type: string | undefined;
  readonly phrase: string;
  readonly linked: true;
}

export type DeleteIssueLinkResult = {
  readonly linkId: string;
  readonly relationship: string;
  readonly deleted: boolean;
};

/**
 * Resolves the phrase against the instance's link types and builds the request.
 *
 * Sent by id when the instance gave one. A name is a mutable string the server re-resolves,
 * so posting it reopens the question the phrase match just answered: a rename between the
 * lookup and the post, or two types sharing a name, would land a different relationship than
 * the one matched.
 */
export async function buildIssueLinkBody(
  client: JiraClient,
  from: string,
  type: string,
  to: string,
  comment?: string,
): Promise<IssueLinkRequest> {
  const response = (await client.getLinkTypes()) as LinkTypesResponse;
  const resolved = resolveLinkDirection(response.issueLinkTypes ?? [], from, type, to);
  const body: Record<string, unknown> = {
    type: resolved.type.id === undefined ? { name: resolved.type.name } : { id: resolved.type.id },
    inwardIssue: { key: resolved.inwardIssue },
    outwardIssue: { key: resolved.outwardIssue },
  };
  if (comment !== undefined) body.comment = { body: client.descriptionValue(comment) };
  return { body, resolved };
}

/**
 * Echoed as the caller said it, not as the payload is shaped: inward/outward is exactly the
 * framing the link commands exist to hide, and repeating it back would invite doubt about
 * whether the right thing was sent.
 */
export function issueLinkCreated(from: string, to: string, resolved: ResolvedLink): IssueLinkCreated {
  return { from, to, type: resolved.type.name ?? resolved.type.id, phrase: resolved.phrase, linked: true };
}

/**
 * A link id is always numeric. Checking the shape turns an issue key passed here by mistake
 * into a usage error rather than a 404 that reads as though the link were already gone.
 */
export function assertLinkId(linkId: string): string {
  if (!/^\d+$/.test(linkId)) {
    throw new ConfigError(
      `"${linkId}" is not a link id. Link ids are numeric and shown by "issue link list"; ` +
        'this looks like an issue key.',
    );
  }
  return linkId;
}

/**
 * States a link as a sentence, for a payload that carries *both* ends.
 *
 * `GET /issueLink/{id}` differs from an issue's `issuelinks` field: it returns `inwardIssue` and
 * `outwardIssue` together, so there is no "which side am I on" to resolve. Per the mapping in
 * `issue-links.ts`, the issue in `inwardIssue` is the subject of the outward phrase. Each part
 * is kept to one line because an administrator-defined phrase containing a newline would forge
 * a whole line of whatever output this lands in.
 */
export function describeIssueLink(link: IssueLink): string {
  const subject = stripControlOneLine(link.inwardIssue?.key ?? '(unknown issue)');
  const object = stripControlOneLine(link.outwardIssue?.key ?? '(unknown issue)');
  const phrase = stripControlOneLine(link.type?.outward ?? '');
  return `${subject} ${phrase === '' ? 'is linked to' : phrase} ${object}`;
}

/**
 * Deletes a link by id. The link is resolved first, so both the dry run and the result name the
 * relationship being removed rather than only its id — a link id is instance-global and
 * identifies nothing on its own, and after the delete this is the only remaining record of it.
 */
export async function deleteIssueLink(
  client: JiraClient,
  linkId: string,
  options: { readonly dryRun?: boolean } = {},
): Promise<DeleteIssueLinkResult> {
  const id = assertLinkId(linkId);
  const link = (await client.getIssueLink(id)) as IssueLink;
  const relationship = describeIssueLink(link);
  if (options.dryRun === true) return { linkId: id, relationship, deleted: false };
  await client.deleteIssueLink(id);
  return { linkId: id, relationship, deleted: true };
}
