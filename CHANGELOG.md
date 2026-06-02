# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Public API barrel (`src/index.ts`) re-exporting the stable surface:
  `validateStrategy` and its types, `validateStrategyFamily`, the
  statistical-validation primitives, the `ExecutionCostModel` and
  `chargeExecutionCosts`, the trial/holdout ledgers, the spec loaders, the
  report renderers, the IO parsers, and the cadence helpers.
- Library build pipeline: `tsconfig.build.json` emits declarations and
  JavaScript for `src/` into `dist/`, wired through the `build:lib` script and
  a `prepublishOnly` hook.
- Package metadata for npm consumption (`main`, `types`, `exports`, `files`).

## [0.1.0]

### Added

- Initial internal release of the crypto edge-search validation toolkit.
