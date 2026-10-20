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

import type { ConfluencePageHistory } from './confluence-client.js';

/** The raw versions and completeness flag `page history --json` reports. */
export interface PageHistoryJson {
  readonly rawEntries: readonly unknown[];
  readonly complete: boolean;
}

/**
 * The machine-readable view: the instance's own version objects, newest first. Resolved Cloud
 * display names stay out of them, so the payload is what the instance sent.
 */
export function pageHistoryJson(history: ConfluencePageHistory): PageHistoryJson {
  return { rawEntries: history.rawEntries, complete: history.complete };
}
