# Simply Atlassian

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Simply Atlassian is a command-line interface built by [SimplySF](https://github.com/SimplySF) for working
with Atlassian products (Jira, Confluence, and friends).

This repo is a Lerna/pnpm monorepo, following the same conventions as SimplySF's
[`simply-node`](https://github.com/SimplySF/simply-node) and [`simply-plugins`](https://github.com/SimplySF/simply-plugins)
repos. Right now it's just the framework — tooling, lint/build/test wiring, and a single placeholder
command proving the pipeline works end to end. Real Atlassian commands land next.

## Packages

| Package                                                   | Description         |
| --------------------------------------------------------- | ------------------- |
| [`@simplysf/simply-atlassian`](packages/simply-atlassian) | The `atlassian` CLI |

## Installation

```sh
npm install -g @simplysf/simply-atlassian
```

```sh
atlassian --help
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the repo structure, how to set
up and build the project, our commit conventions, and how to submit a pull request. Please also read
our [Code of Conduct](CODE_OF_CONDUCT.md).

## Issues

Please report bugs or request features by [opening an issue](https://github.com/SimplySF/simply-atlassian/issues)
in this repository.

## License

Licensed under the [Apache-2.0](LICENSE.txt) license.
