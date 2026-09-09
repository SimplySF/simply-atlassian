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

// The library surface this package used to own now lives in `@simplysf/simply-atlassian-core`
// (docs/design/0012-simply-atlassian-core.md). These re-exports keep the names this package has
// always exported so an existing import keeps working; new code should import the core package
// directly, which is where anything added from here on will appear.
export {
  resolveConfluenceConfig,
  resolveJiraConfig,
  type AtlassianAuth,
  type AtlassianConfig,
  type BasicAuth,
  type BearerAuth,
  type ConfigOverrides,
  type Deployment,
  type EnvLike,
  ConfluenceClient,
  AuthError,
  CliError,
  ConfigError,
  HttpError,
  NetworkError,
  JiraClient,
  type JiraSearchOptions,
  type JiraSearchPage,
} from '@simplysf/simply-atlassian-core';
