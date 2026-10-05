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

import type { RawXrayFolder } from './xray-backend.js';

/** One folder of a project's test repository, with its path written the way Xray stores it. */
export interface XrayFolder {
  readonly id?: string;
  readonly name: string;
  /** Leading slash, `/` for the root: `/O&M/Accounts`. */
  readonly path: string;
  /** Tests directly in this folder, when Xray reports a count. */
  readonly testCount?: number;
  readonly folders: XrayFolder[];
}

/** Server-supplied trees are walked, not trusted: a pathological nesting stops here. */
const MAX_DEPTH = 64;

/**
 * Turns Xray's folder response into one rooted tree. Versions differ: some answer with the root
 * folder, some with the list of top-level folders, and the count and path properties have been
 * spelled more than one way, so each is read tolerantly.
 */
export function normaliseFolders(response: unknown): XrayFolder {
  if (Array.isArray(response)) {
    return { name: '/', path: '/', folders: response.map((child) => folderNode(child as RawXrayFolder, '', 1)) };
  }
  const root = (response ?? {}) as RawXrayFolder;
  const node = folderNode(root, '', 0);
  return { ...node, name: '/', path: '/' };
}

function folderNode(raw: RawXrayFolder, parentPath: string, depth: number): XrayFolder {
  const name = typeof raw.name === 'string' ? raw.name : '';
  const stored = typeof raw.testRepositoryPath === 'string' ? raw.testRepositoryPath : undefined;
  const ownPath = depth === 0 ? '' : withLeadingSlash(stored ?? `${parentPath}/${name}`);
  const count = typeof raw.testsCount === 'number' ? raw.testsCount : raw.testCount;
  const children = Array.isArray(raw.folders) && depth < MAX_DEPTH ? (raw.folders as RawXrayFolder[]) : [];
  return {
    id: typeof raw.id === 'number' || typeof raw.id === 'string' ? String(raw.id) : undefined,
    name,
    path: ownPath === '' ? '/' : ownPath,
    testCount: typeof count === 'number' ? count : undefined,
    folders: children.map((child) => folderNode(child, ownPath, depth + 1)),
  };
}

/** Finds a folder by path, with or without the leading slash; `""` and `/` are the root. */
export function findFolder(tree: XrayFolder, folder: string): XrayFolder | undefined {
  const wanted = comparable(folder);
  if (wanted === '') return tree;
  const walk = (node: XrayFolder): XrayFolder | undefined => {
    if (comparable(node.path) === wanted) return node;
    for (const child of node.folders) {
      const found = walk(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(tree);
}

/** Cuts a tree to `depth` levels below its top (1 keeps only the immediate children). */
export function limitFolderDepth(tree: XrayFolder, depth: number | undefined): XrayFolder {
  if (depth === undefined) return tree;
  const cut = (node: XrayFolder, remaining: number): XrayFolder => ({
    ...node,
    folders: remaining <= 0 ? [] : node.folders.map((child) => cut(child, remaining - 1)),
  });
  return cut(tree, depth);
}

/** Depth-first, parents before children, for an indented listing. */
export function flattenFolders(tree: XrayFolder): Array<{ readonly folder: XrayFolder; readonly depth: number }> {
  const rows: Array<{ folder: XrayFolder; depth: number }> = [];
  const walk = (node: XrayFolder, depth: number): void => {
    rows.push({ folder: node, depth });
    for (const child of node.folders) walk(child, depth + 1);
  };
  walk(tree, 0);
  return rows;
}

function withLeadingSlash(value: string): string {
  return value.startsWith('/') ? value : `/${value}`;
}

/** `/` is always a delimiter, so trimming slashes is the only normalisation a path needs. */
function comparable(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '');
}
