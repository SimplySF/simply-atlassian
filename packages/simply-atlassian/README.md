# @simplysf/simply-atlassian

[![NPM](https://img.shields.io/npm/v/@simplysf/simply-atlassian?label=@simplysf/simply-atlassian)](https://npmjs.com/@simplysf/simply-atlassian) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt)

Command-line interface for working with Atlassian products, built by [SimplySF](https://github.com/SimplySF).

This package is framework-only right now: one placeholder command (`hello world`) proving the
build/lint/test/oclif pipeline works end to end. Real Atlassian commands land next.

## Install

```bash
npm install -g @simplysf/simply-atlassian
```

## Issues

Please report any issues at https://github.com/SimplySF/simply-atlassian/issues

## Contributing

This package is part of the [`@simplysf/simply-atlassian`](https://github.com/SimplySF/simply-atlassian) monorepo. See the repo's [CONTRIBUTING.md](https://github.com/SimplySF/simply-atlassian/blob/main/CONTRIBUTING.md) for the repo structure, how to set up and build the project, our commit conventions, and how to submit a pull request. Please also read our [Code of Conduct](https://github.com/SimplySF/simply-atlassian/blob/main/CODE_OF_CONDUCT.md).

## Commands

<!-- commands -->

- [`atlassian hello world`](#atlassian-hello-world)

## `atlassian hello world`

Print a friendly greeting.

```
USAGE
  $ atlassian hello world

DESCRIPTION
  Print a friendly greeting.

  A placeholder command that proves the CLI framework is wired up end to end. Replace or remove it once real Atlassian
  commands land.

EXAMPLES
  $ atlassian hello world
```

_See code: [lib/commands/hello/world.js](https://github.com/SimplySF/simply-atlassian/blob/@simplysf/simply-atlassian@0.1.0/packages/simply-atlassian/lib/commands/hello/world.js)_
<!-- commandsstop -->

## License

Licensed under the [Apache-2.0](https://raw.githubusercontent.com/SimplySF/simply-atlassian/main/LICENSE.txt) license.
