# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.12.0](https://github.com/SimplySF/simply-atlassian/compare/%40simplysf%2Fsimply-atlassian%400.11.0...%40simplysf%2Fsimply-atlassian%400.12.0) (2026-09-10)

### Features

- **docs:** ship the guides in the packages, redirect the site ([#29](https://github.com/SimplySF/simply-atlassian/issues/29)) ([4543300](https://github.com/SimplySF/simply-atlassian/commit/454330092e0b86233333fba6b40eaa6f0382f7a8))

# [0.11.0](https://github.com/SimplySF/simply-atlassian/compare/%40simplysf%2Fsimply-atlassian%400.10.0...%40simplysf%2Fsimply-atlassian%400.11.0) (2026-09-10)

- feat!: become a plugin of the simply CLI (#27) ([a8be948](https://github.com/SimplySF/simply-atlassian/commit/a8be9485ee32fd42f525c9f5092a1feaf4024a96)), closes [#27](https://github.com/SimplySF/simply-atlassian/issues/27)

### BREAKING CHANGES

- this package no longer provides the `simply` command. Install
  @simplysf/simply-cli instead; this plugin installs itself the first time one of
  its commands runs, or ahead of time with `simply plugins install
@simplysf/simply-atlassian`. Command names are unchanged — `simply atlassian ...`
  is exactly what it was.

  This package and @simplysf/simply-gitlab both declared bin: { simply }, so npm
  could only ever link one of them and the two could not be installed together. A
  single host now owns the name and both are plugins.

  Two changes make that work:

  - `bin` is removed, so nothing competes for the name.
  - `prepack` generates oclif.manifest.json, which is what the host reads out of
    this package's tarball to build its just-in-time manifest. Without it the host
    cannot discover these commands and the JIT install never fires. It also lets
    the CLI start without scanning every command file, which it never did before —
    the file was listed in `files` but nothing generated it.

  prepack compiles first. `oclif manifest` reads lib/commands, and packing against
  a stale lib produced a manifest with 33 of 43 commands and no error at all.

# [0.10.0](https://github.com/SimplySF/simply-atlassian/compare/%40simplysf%2Fsimply-atlassian%400.9.1...%40simplysf%2Fsimply-atlassian%400.10.0) (2026-09-09)

### Features

- **simply-atlassian-core:** add discovery, labels, sprint writes, and remote links ([#23](https://github.com/SimplySF/simply-atlassian/issues/23)) ([be52c06](https://github.com/SimplySF/simply-atlassian/commit/be52c066df99791271288c8f5c86563d828b3764))

## [0.9.1](https://github.com/SimplySF/simply-atlassian/compare/%40simplysf%2Fsimply-atlassian%400.9.0...%40simplysf%2Fsimply-atlassian%400.9.1) (2026-09-09)

**Note:** Version bump only for package @simplysf/simply-atlassian

# [0.9.0](https://github.com/SimplySF/simply-atlassian/compare/%40simplysf%2Fsimply-atlassian%400.8.1...%40simplysf%2Fsimply-atlassian%400.9.0) (2026-09-09)

### Features

- **simply-atlassian-core:** accept Markdown page bodies, and add --append ([#20](https://github.com/SimplySF/simply-atlassian/issues/20)) ([baa52e8](https://github.com/SimplySF/simply-atlassian/commit/baa52e81847279f27b0e350259e02009874a4321)), closes [0012/#18](https://github.com/SimplySF/simply-atlassian/issues/18)

## [0.8.1](https://github.com/SimplySF/simply-atlassian/compare/%40simplysf%2Fsimply-atlassian%400.8.0...%40simplysf%2Fsimply-atlassian%400.8.1) (2026-09-09)

**Note:** Version bump only for package @simplysf/simply-atlassian

# [0.8.0](https://github.com/SimplySF/simply-atlassian/compare/%40simplysf%2Fsimply-atlassian%400.7.0...%40simplysf%2Fsimply-atlassian%400.8.0) (2026-09-09)

### Features

- **simply-atlassian-mcp:** serve Jira and Confluence tools in-process on the core library ([#18](https://github.com/SimplySF/simply-atlassian/issues/18)) ([f6be204](https://github.com/SimplySF/simply-atlassian/commit/f6be204d87f34ebf69aa37a8c62db5bf6ec06214))

# [0.7.0](https://github.com/SimplySF/simply-atlassian/compare/%40simplysf%2Fsimply-atlassian%400.6.0...%40simplysf%2Fsimply-atlassian%400.7.0) (2026-09-09)

### Features

- **simply-atlassian-core:** extract the client core and shared logic from the CLI ([#17](https://github.com/SimplySF/simply-atlassian/issues/17)) ([081811e](https://github.com/SimplySF/simply-atlassian/commit/081811e9d566740f9be46feae9cd9d6b9afd3cff))

# [0.6.0](https://github.com/SimplySF/simply-atlassian/compare/%40simplysf%2Fsimply-atlassian%400.5.0...%40simplysf%2Fsimply-atlassian%400.6.0) (2026-09-09)

### Features

- **simply-atlassian:** add confluence page create, update, delete, and comments ([#16](https://github.com/SimplySF/simply-atlassian/issues/16)) ([a59c1a6](https://github.com/SimplySF/simply-atlassian/commit/a59c1a6d30c045f4e9fd8e47766d705f6a814cbd))

# [0.5.0](https://github.com/SimplySF/simply-atlassian/compare/%40simplysf%2Fsimply-atlassian%400.4.0...%40simplysf%2Fsimply-atlassian%400.5.0) (2026-09-09)

### Features

- **jira:** add issue history command ([#15](https://github.com/SimplySF/simply-atlassian/issues/15)) ([96ce62e](https://github.com/SimplySF/simply-atlassian/commit/96ce62e987a76dcb40115abaf6992eac94992137))

# [0.4.0](https://github.com/SimplySF/simply-atlassian/compare/%40simplysf%2Fsimply-atlassian%400.3.0...%40simplysf%2Fsimply-atlassian%400.4.0) (2026-09-09)

### Features

- **simply-atlassian:** add Jira agile boards and sprints ([#14](https://github.com/SimplySF/simply-atlassian/issues/14)) ([619f644](https://github.com/SimplySF/simply-atlassian/commit/619f644035b6de55195a2a6e7815a2f469e599f1))

# [0.3.0](https://github.com/SimplySF/simply-atlassian/compare/%40simplysf%2Fsimply-atlassian%400.2.1...%40simplysf%2Fsimply-atlassian%400.3.0) (2026-09-09)

### Features

- **cli:** open Atlassian objects in browser ([#13](https://github.com/SimplySF/simply-atlassian/issues/13)) ([9b5581d](https://github.com/SimplySF/simply-atlassian/commit/9b5581d04876ab77f5924b89eac4c6c1b24b4fbc))

## [0.2.1](https://github.com/SimplySF/simply-atlassian/compare/%40simplysf%2Fsimply-atlassian%400.2.0...%40simplysf%2Fsimply-atlassian%400.2.1) (2026-09-08)

### Bug Fixes

- **simply-atlassian:** harden output sanitising and unexpected-error handling ([ec4c43d](https://github.com/SimplySF/simply-atlassian/commit/ec4c43d42229ae4b31252ea1f40fa7b86eed841f))

# 0.2.0 (2026-09-08)

### Features

- scaffold simply-atlassian monorepo framework ([bc5410b](https://github.com/SimplySF/simply-atlassian/commit/bc5410bd42422ec38a9ada31fd3f6f3a82c4d4bc))
- **simply-atlassian:** add Atlassian client core (config, auth, transport, clients) ([61e627c](https://github.com/SimplySF/simply-atlassian/commit/61e627c35e7fc2284df11577280e57ada66860c3))
- **simply-atlassian:** add confluence page get, search, and children ([84dfd76](https://github.com/SimplySF/simply-atlassian/commit/84dfd7646adda26b446b6df9adc3e8bdfb4d92b6)), closes [#3](https://github.com/SimplySF/simply-atlassian/issues/3) [#3](https://github.com/SimplySF/simply-atlassian/issues/3)
- **simply-atlassian:** add jira issue create, update, delete, and transition ([8545a54](https://github.com/SimplySF/simply-atlassian/commit/8545a5490226f425a5b01d4d0c783295a333e081))
- **simply-atlassian:** add jira issue links and subtask parents ([f886736](https://github.com/SimplySF/simply-atlassian/commit/f8867366988480ba23ed4d2233329dfb596ead73))
- **simply-atlassian:** add jira whoami, issue view, and issue search ([c9242ed](https://github.com/SimplySF/simply-atlassian/commit/c9242eda8a7ae29420db4f9ed3f4c0dc0618c86b))
- **simply-atlassian:** add user lookup, mentions, and comment editing ([c1463ec](https://github.com/SimplySF/simply-atlassian/commit/c1463ec4bbc000cb0fb8ec4b512e009d0b9845be))
