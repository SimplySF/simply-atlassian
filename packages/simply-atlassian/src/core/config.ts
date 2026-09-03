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
import { ConfigError } from './errors.js';

/** Atlassian ships two products with different REST surfaces and auth schemes. */
export type Deployment = 'cloud' | 'server';

export interface BasicAuth {
  readonly kind: 'basic';
  readonly username: string;
  readonly apiToken: string;
}

export interface BearerAuth {
  readonly kind: 'bearer';
  readonly personalToken: string;
}

export type AtlassianAuth = BasicAuth | BearerAuth;

export interface AtlassianConfig {
  readonly url: string;
  readonly deployment: Deployment;
  readonly auth: AtlassianAuth;
}

/** Per-invocation overrides, sourced from global flags. Anything set here beats the environment. */
export interface ConfigOverrides {
  readonly url?: string;
  readonly username?: string;
  readonly apiToken?: string;
  readonly personalToken?: string;
}

export type EnvLike = Record<string, string | undefined>;

interface ProductSpec {
  readonly label: string;
  readonly flagPrefix: string;
  readonly urlVar: string;
  readonly usernameVar: string;
  readonly apiTokenVar: string;
  readonly personalTokenVar: string;
  readonly sslVerifyVar: string;
  /** Cloud-only path the REST API lives under, appended during canonicalization. */
  readonly cloudPathPrefix?: string;
}

const JIRA_SPEC: ProductSpec = {
  label: 'Jira',
  flagPrefix: 'jira',
  urlVar: 'JIRA_URL',
  usernameVar: 'JIRA_USERNAME',
  apiTokenVar: 'JIRA_API_TOKEN',
  personalTokenVar: 'JIRA_PERSONAL_TOKEN',
  sslVerifyVar: 'JIRA_SSL_VERIFY',
};

const CONFLUENCE_SPEC: ProductSpec = {
  label: 'Confluence',
  flagPrefix: 'confluence',
  urlVar: 'CONFLUENCE_URL',
  usernameVar: 'CONFLUENCE_USERNAME',
  apiTokenVar: 'CONFLUENCE_API_TOKEN',
  personalTokenVar: 'CONFLUENCE_PERSONAL_TOKEN',
  sslVerifyVar: 'CONFLUENCE_SSL_VERIFY',
  cloudPathPrefix: '/wiki',
};

const CLOUD_HOST_SUFFIX = '.atlassian.net';
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);
const CA_BUNDLE_HINT = 'NODE_EXTRA_CA_CERTS=/path/to/ca.pem';

function detectDeployment(hostname: string): Deployment {
  return hostname.toLowerCase().endsWith(CLOUD_HOST_SUFFIX) ? 'cloud' : 'server';
}

/**
 * Parses the configured base URL and, for Confluence Cloud, moves it under `/wiki` — the Cloud
 * REST API is rooted there, and users routinely paste the bare site URL.
 */
function normalizeUrl(rawUrl: string, spec: ProductSpec): { url: string; deployment: Deployment } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ConfigError(
      `${spec.label} URL is not a valid URL: ${rawUrl}. Set ${spec.urlVar} to something like https://your-domain.atlassian.net.`,
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigError(`${spec.label} URL must use http or https, got ${parsed.protocol} (${spec.urlVar}).`);
  }

  const deployment = detectDeployment(parsed.hostname);
  if (deployment === 'cloud') {
    // Cloud instances live at a fixed root — the origin, plus `/wiki` for Confluence. Whatever
    // else the user pasted (a deep page link, odd casing like /WIKI) is noise, so canonicalize
    // by construction instead of patching the given path.
    return { url: `${parsed.origin}${spec.cloudPathPrefix ?? ''}`, deployment };
  }

  return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`, deployment };
}

/**
 * Certificate verification is not negotiable, so a `*_SSL_VERIFY=false` carried over from other
 * Atlassian tooling fails loudly rather than being silently ignored — the alternative is a user
 * believing verification is off when it is on, or vice versa. The fix keeps verification intact.
 */
function rejectSslOptOut(spec: ProductSpec, env: EnvLike): void {
  const raw = env[spec.sslVerifyVar];
  if (raw !== undefined && FALSE_VALUES.has(raw.trim().toLowerCase())) {
    throw new ConfigError(
      `${spec.sslVerifyVar}=${raw} is not supported: this CLI always verifies TLS certificates. ` +
        `If your ${spec.label} instance is behind an internal or agency CA, trust that CA instead with ${CA_BUNDLE_HINT}.`,
    );
  }
}

function resolveAuth(
  spec: ProductSpec,
  deployment: Deployment,
  overrides: ConfigOverrides,
  env: EnvLike,
): AtlassianAuth {
  const username = overrides.username ?? env[spec.usernameVar];
  const apiToken = overrides.apiToken ?? env[spec.apiTokenVar];
  const personalToken = overrides.personalToken ?? env[spec.personalTokenVar];

  if (deployment === 'cloud') {
    if (!username || !apiToken) {
      const missing: string[] = [];
      if (!username) missing.push(spec.usernameVar);
      if (!apiToken) missing.push(spec.apiTokenVar);
      const hint = personalToken ? ` ${spec.personalTokenVar} only applies to Server/Data Center instances.` : '';
      throw new ConfigError(`${spec.label} Cloud authentication requires ${missing.join(' and ')}.${hint}`);
    }
    return { kind: 'basic', username, apiToken };
  }

  if (!personalToken) {
    const hasCloudCredentials = Boolean(username ?? apiToken);
    const hint = hasCloudCredentials ? ` ${spec.usernameVar}/${spec.apiTokenVar} only apply to Cloud instances.` : '';
    throw new ConfigError(`${spec.label} Server/Data Center authentication requires ${spec.personalTokenVar}.${hint}`);
  }

  return { kind: 'bearer', personalToken };
}

function resolveConfig(spec: ProductSpec, overrides: ConfigOverrides, env: EnvLike): AtlassianConfig {
  const rawUrl = (overrides.url ?? env[spec.urlVar])?.trim();
  if (!rawUrl) {
    throw new ConfigError(`${spec.label} URL is not configured. Set ${spec.urlVar} or pass --${spec.flagPrefix}-url.`);
  }

  rejectSslOptOut(spec, env);
  const { url, deployment } = normalizeUrl(rawUrl, spec);
  return { url, deployment, auth: resolveAuth(spec, deployment, overrides, env) };
}

export function resolveJiraConfig(overrides: ConfigOverrides = {}, env: EnvLike = process.env): AtlassianConfig {
  return resolveConfig(JIRA_SPEC, overrides, env);
}

export function resolveConfluenceConfig(overrides: ConfigOverrides = {}, env: EnvLike = process.env): AtlassianConfig {
  return resolveConfig(CONFLUENCE_SPEC, overrides, env);
}
