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
} from './core/config.js';
export { ConfluenceClient } from './core/confluence-client.js';
export { AuthError, CliError, ConfigError, HttpError, NetworkError } from './core/errors.js';
export { JiraClient, type JiraSearchOptions, type JiraSearchPage } from './core/jira-client.js';
