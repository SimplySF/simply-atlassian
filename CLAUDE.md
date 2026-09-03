# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Before writing code for a new feature

Every new feature gets a design document in `docs/design/` **before** it gets an implementation.
Read `docs/design/README.md` for the process, the template, and the list of changes that require a
doc (new commands, user-visible flag/output/error changes, new shared modules). In short:

1. Write `docs/design/NNNN-short-slug.md` from the template, using the next free number.
2. Get the design agreed on before implementing — decisions are cheapest to change there.
3. Implement, then correct the doc wherever the implementation taught you something better; a doc
   that silently disagrees with the shipped behavior is worse than no doc.
4. Add the row to the index table in `docs/design/README.md` and update the doc's `Status` line when
   the work lands.

The point is that the reasoning behind the system's shape — why a command lives in one package and
not another, what was rejected — stays recoverable later, instead of dying in PR threads.

## Before considering a command/flag change finished

See `CONTRIBUTING.md`'s "Pull Requests" checklist in full — it's not optional. The steps most likely
to get skipped, because nothing forces them locally the way `pnpm test` forces test failures:

1. **Regenerate the package's README command reference**: run `pnpm run readme` in that package's
   directory and commit the result.
2. **Run `pnpm run build`** for the affected package(s) so `command-snapshot.json` regenerates, and
   commit whatever changes.

CI's `git diff --exit-code` after `pnpm run build` catches a stale `command-snapshot.json`, but there
is no equivalent check for a stale README — it fails silently (published, just wrong) unless you
regenerate it yourself.

## Framework status

This repo is currently scaffolding only — one package (`packages/simply-atlassian`), one placeholder
`hello world` command proving the build/lint/test/oclif pipeline works end to end, and no Atlassian
API client yet. Unlike SimplySF's Salesforce CLI repos (`simply-node`, `simply-plugins`), command copy
(summaries/descriptions/examples) lives inline as static class properties rather than in externalized
`messages/*.md` files — those repos load `messages/*.md` through `@salesforce/core`'s `Messages`
helper, which is Salesforce-specific and doesn't apply here. If externalized messages are wanted later,
that's a small shared utility to design and add, not something to assume already exists.
