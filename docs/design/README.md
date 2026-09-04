# Design Documents

Every new feature in this repo gets a design document here **before** it gets code. The point isn't
ceremony — it's that a year from now, the "why" behind a command's shape (why this package, why this
flag, what we rejected) is recoverable without archaeology through git history and PR threads.

## Process

1. **Write the design doc first.** Copy the [template](#template) into
   `docs/design/NNNN-short-slug.md`, using the next free four-digit number.
2. **Get agreement on it** — on the doc, not on the diff. Decisions are cheapest to change here.
3. **Implement**, then update the doc if the implementation taught you something the design got
   wrong. A design doc that quietly diverges from the shipped behavior is worse than none.
4. **Set the status line** to `Implemented` (with the PR link) when it lands.

A design doc is not a substitute for user-facing docs. Command summaries, flag descriptions, and
examples still live on the command classes themselves (or in `messages/*.md`, if that convention gets
introduced later) and each package's README — see the root `CONTRIBUTING.md` checklist. The design
doc records the reasoning; the command/README records the behavior.

## When a design doc is required

- Any new command, or a new subtopic.
- Any change to an existing command's flags, output shape, or error behavior that users would
  notice.
- Any new shared module, or a change to how packages depend on each other.
- Introducing an Atlassian API client/SDK dependency, or changing how auth is handled.

Not required for: bug fixes that restore documented behavior, dependency bumps, test-only changes,
refactors that keep the public surface identical (though a short doc is welcome for large ones).

## Index

| #    | Title                                                                                             | Status              |
| ---- | ------------------------------------------------------------------------------------------------- | ------------------- |
| 0001 | [Atlassian client core (config, auth, HTTP)](0001-atlassian-client-core.md)                       | Implemented (PR #2) |
| 0002 | [Output conventions and first Jira read commands](0002-output-conventions-first-jira-commands.md) | Implemented (PR #3) |
| 0003 | [Confluence read commands and page rendering](0003-confluence-read-commands.md)                   | Implemented (PR #4) |
| 0004 | [Write safety, and Jira issue writes](0004-write-safety-and-jira-issue-writes.md)                 | Implemented (PR #5) |

## Template

```markdown
# NNNN — Title

**Status:** Draft | Planned | Implemented (PR #N) | Superseded by NNNN
**Package:** the `packages/*` this lands in
**Date:** YYYY-MM-DD

## Problem

What the user can't do today, and why that hurts.

## Decision

The one-paragraph answer: what we're building and where it lives.

## Behavior

The user-visible contract — command name, flags, resolution rules, output, errors. Tables beat
prose for lookup rules.

## Alternatives considered

Each option we rejected and the specific reason. This section is the one future readers come back
for.

## Implementation plan

Files added/changed, in the order they'd be written.

## Testing

Unit test coverage, and what each case pins down.

## Open questions

Anything deliberately left undecided, and who decides it.
```
