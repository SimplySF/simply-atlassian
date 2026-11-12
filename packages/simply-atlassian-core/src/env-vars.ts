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

import type { EnvLike } from './config.js';

/**
 * Every environment variable this package reads, mapped to the unprefixed name it replaced.
 *
 * The `SIMPLY_` prefix exists because the unprefixed names are shared with other Atlassian tooling
 * (`JIRA_URL` and friends are what most Jira MCP servers and scripts read), so a shell configured
 * for one tool silently configured this one too. See docs/design/0023-simply-env-prefix.md.
 *
 * The legacy names still work while the prefixed name is unset, and every use of one is reported
 * by {@link deprecatedEnvWarning}. They will be removed in a future major release.
 */
export const LEGACY_ENV = {
  SIMPLY_ATLASSIAN_READ_ONLY: 'ATLASSIAN_READ_ONLY',
  SIMPLY_JIRA_URL: 'JIRA_URL',
  SIMPLY_JIRA_USERNAME: 'JIRA_USERNAME',
  SIMPLY_JIRA_API_TOKEN: 'JIRA_API_TOKEN',
  SIMPLY_JIRA_PERSONAL_TOKEN: 'JIRA_PERSONAL_TOKEN',
  SIMPLY_JIRA_SSL_VERIFY: 'JIRA_SSL_VERIFY',
  SIMPLY_CONFLUENCE_URL: 'CONFLUENCE_URL',
  SIMPLY_CONFLUENCE_USERNAME: 'CONFLUENCE_USERNAME',
  SIMPLY_CONFLUENCE_API_TOKEN: 'CONFLUENCE_API_TOKEN',
  SIMPLY_CONFLUENCE_PERSONAL_TOKEN: 'CONFLUENCE_PERSONAL_TOKEN',
  SIMPLY_CONFLUENCE_SSL_VERIFY: 'CONFLUENCE_SSL_VERIFY',
} as const;

/** A current, `SIMPLY_`-prefixed variable name. */
export type EnvName = keyof typeof LEGACY_ENV;

function present(value: string | undefined): value is string {
  // An empty export carries no value, matching how `loadEnvFile` treats one.
  return value !== undefined && value !== '';
}

/**
 * Reads a setting: the prefixed name when it has a value, otherwise the deprecated unprefixed one.
 * The prefixed name always wins, so a legacy variable left behind for another tool cannot override
 * a setting made for this one.
 */
export function envValue(env: EnvLike, name: EnvName): string | undefined {
  const current = env[name];
  if (present(current)) return current;
  const legacy = env[LEGACY_ENV[name]];
  return present(legacy) ? legacy : current;
}

/**
 * The deprecated names this environment is actually relying on: set, with the prefixed name
 * unset. A legacy name shadowed by its prefixed one is not reported — it is most likely there for
 * another tool, and this package already ignores it.
 */
export function deprecatedEnvInUse(env: EnvLike): Array<{ readonly legacy: string; readonly current: EnvName }> {
  return (Object.keys(LEGACY_ENV) as EnvName[])
    .filter((current) => !present(env[current]) && present(env[LEGACY_ENV[current]]))
    .map((current) => ({ legacy: LEGACY_ENV[current], current }));
}

/**
 * One line naming each deprecated variable in use and its replacement, or `undefined` when there
 * are none. Returned rather than written, so each surface reports it on its own diagnostic channel.
 */
export function deprecatedEnvWarning(env: EnvLike): string | undefined {
  const inUse = deprecatedEnvInUse(env);
  if (inUse.length === 0) return undefined;
  const renames = inUse.map(({ legacy, current }) => `${legacy} → ${current}`).join(', ');
  return (
    `Deprecated environment variable${inUse.length === 1 ? '' : 's'} in use: ${renames}. ` +
    'Rename to the SIMPLY_ prefix; the unprefixed names will stop working in a future major release.'
  );
}
