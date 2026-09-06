# Changelog

All notable changes to RainTerminal will be documented here. The project follows Semantic Versioning after the first stable release.

## [Unreleased]

## [1.0.0] - 2026-09-06

### Added

- Network device command template library with built-in query commands for Huawei, H3C, Ruijie, ZTE and other mainstream vendors.
- Dynamic category management: create, delete, and rename command categories; right-click to move commands between groups.
- Command search with auto-expand groups and keyword matching across name, command, and category.
- Persistent snippet categories with versioned localStorage migration.

### Changed

- Rebranded from XunDuTerminal to RainTerminal; all user-facing strings, identifiers, and data directories updated.
- Update source pointed to xsenrain/RainTerminal repository.
- Removed enterprise server and technical QQ group sections from the About page.

### Fixed

- New command category not persisting after save (state reset to "未分类" while dropdown showed first category).
- Search results hidden because groups remained collapsed after filtering.
- Category operation notice overlapping with drawer title due to stacking context.

## [0.2.2] - 2026-08-06

### Fixed

- Restore the parent-directory action in the remote file manager when the current directory is `/root` or `~`.
- Allow direct navigation to the Unix root directory `/` while keeping its parent action disabled.

## [0.2.1] - 2026-08-04

### Fixed

- Recover the local terminal automatically after a closed ConPTY pipe or Windows error 232.
- Prevent failed input from being replayed into the replacement shell and deduplicate concurrent recovery attempts.
- Clear stale local-terminal session state and suppress obsolete close events from replaced processes.
- Record local-terminal start, close, write failure, stop, and recovery diagnostics.

## [0.2.0] - 2026-07-22

### Added

- Secure in-app update downloads with progress, cancellation, retry, exact-size checks, and SHA-256 verification.
- Verified installer handoff that still requires explicit user confirmation before installation.
- Windows Credential Manager storage and plaintext credential migration.
- SSH password, private-key, and Agent authentication foundations.
- OpenSSH config import and known-host verification for helper connections.
- Open-source governance, security, and CI scaffolding.

### Changed

- Update downloads now appear in the unified file transfer manager.
- Stable GitHub Releases automatically publish a client update manifest; prereleases remain opt-in.

## [0.1.0] - 2026-07-20

- Initial public preview baseline.
