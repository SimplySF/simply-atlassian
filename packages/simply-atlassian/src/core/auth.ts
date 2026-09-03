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

import { Buffer } from 'node:buffer';
import type { AtlassianConfig } from './config.js';

/**
 * Cloud authenticates with Basic (email + API token); Server/Data Center uses a bearer personal
 * access token. Returns just the Authorization header so callers can merge it into a request.
 */
export function buildAuthHeaders(config: AtlassianConfig): Record<string, string> {
  if (config.auth.kind === 'basic') {
    const encoded = Buffer.from(`${config.auth.username}:${config.auth.apiToken}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }

  return { Authorization: `Bearer ${config.auth.personalToken}` };
}
