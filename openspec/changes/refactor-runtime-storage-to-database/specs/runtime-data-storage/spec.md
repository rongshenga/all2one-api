## ADDED Requirements

### Requirement: Database-backed runtime state
The system SHALL support a database-backed runtime storage backend as the authoritative store for mutable high-frequency operational data.

#### Scenario: Provider runtime state writes are transactional
- **WHEN** provider runtime fields configured for durable persistence, usage counters, health status, or cache data are updated
- **THEN** the system SHALL persist those updates through the database backend using an atomic write path
- **AND** the system SHALL avoid rewriting large shared JSON files for each runtime update

#### Scenario: Runtime state is restored from database on startup
- **WHEN** the service starts with database-backed runtime storage enabled
- **THEN** the system SHALL load provider runtime state, usage cache, and plugin runtime data from the database backend before serving traffic

#### Scenario: High-frequency hot state is buffered before flush
- **WHEN** large provider pools process frequent selections, concurrency slot updates, or short-cycle health changes
- **THEN** the system SHALL allow those hot-path updates to be buffered or aggregated in memory before flushing durable state to the database backend
- **AND** the system SHALL not require a synchronous durable database write for every request-path state mutation

### Requirement: Provider pool decomposition and stable identity
The system SHALL decompose legacy `provider_pools.json` records into separately managed provider registry, secret, credential binding, and runtime state records while preserving a legacy-compatible projection.

#### Scenario: Legacy provider entries are normalized on import
- **WHEN** a provider entry from `provider_pools.json` is imported into database-backed runtime storage
- **THEN** the system SHALL separate non-sensitive registration fields, secret fields, file-backed credential bindings, and mutable runtime fields into their corresponding records
- **AND** the system SHALL preserve a compatibility projection shaped like the legacy provider record for legacy reads and export

#### Scenario: Refreshing provider UUID does not change stable identity
- **WHEN** runtime logic or UI triggers a provider UUID refresh
- **THEN** the system SHALL keep an immutable internal provider identity for foreign keys, deduplication, and migration bookkeeping
- **AND** the system SHALL update the legacy-facing routing UUID atomically without breaking existing routing semantics

### Requirement: Unified provider pool mutation path
The system SHALL route all provider pool mutations through a shared RuntimeStorage-backed write path.

#### Scenario: UI and auto-link mutations avoid raw file rewrites
- **WHEN** provider add/update/delete/disable/reset/delete unhealthy/refresh unhealthy UUIDs/quick link/Grok batch import/auto-link operations mutate provider pool data
- **THEN** the system SHALL persist those changes through the same storage abstraction instead of each call site directly rewriting `provider_pools.json`
- **AND** the system SHALL keep `ProviderPoolManager` and compatibility snapshots in sync after the write commits

#### Scenario: Mutation side effects remain observable
- **WHEN** a provider pool mutation succeeds in database-backed runtime storage mode
- **THEN** the system SHALL preserve the broadcast and diagnostics side effects required by the current Web UI and health workflows

### Requirement: Layered runtime storage model
The system SHALL separate bootstrap configuration, hot-path in-memory state, durable runtime state, and optional secret payload storage into explicit layers.

#### Scenario: Bootstrap configuration remains file-friendly
- **WHEN** operators edit low-frequency startup configuration such as main config, plugin config, or system prompt files
- **THEN** the system SHALL allow those bootstrap settings to remain file-backed and manually editable
- **AND** the system SHALL not require migrating all low-frequency configuration into the runtime database

#### Scenario: Durable state excludes purely transient counters
- **WHEN** the system persists provider runtime state into the database backend
- **THEN** the persisted schema SHALL focus on durable aggregated state and queryable facts
- **AND** purely transient hot-path counters or sequencing helpers SHALL be allowed to remain in the in-memory hot state layer

### Requirement: File compatibility during migration
The system SHALL preserve compatibility with existing `configs/`-based import, export, and recovery workflows during the migration period.

#### Scenario: Existing credential files can be imported
- **WHEN** legacy credential files or provider config files exist under `configs/`
- **THEN** the system SHALL provide a supported import path to register them into the database-backed storage model

#### Scenario: Operators can export data for backup or recovery
- **WHEN** operators need to back up or restore runtime data during or after migration
- **THEN** the system SHALL provide a documented export and recovery path compatible with existing operational workflows

#### Scenario: Provider pool compatibility export remains available
- **WHEN** operators or legacy tooling need a `provider_pools.json`-compatible backup view
- **THEN** the system SHALL provide an explicit export path that materializes the compatibility projection from database-backed storage
- **AND** the system SHALL not require runtime writes to continuously rewrite the legacy JSON file

### Requirement: Credential inventory deduplication
The system SHALL maintain a deduplicated credential inventory for imported or managed provider credentials.

#### Scenario: Re-imported credentials do not create unbounded duplicates
- **WHEN** a credential that matches an existing identity or deduplication key is imported again
- **THEN** the system SHALL update or reference the existing credential record instead of creating an unbounded number of new runtime entries

#### Scenario: Credential records are queryable without directory-wide scans
- **WHEN** the system needs to resolve a credential by provider, identity, or stable key
- **THEN** the system SHALL query the database-backed inventory instead of requiring a full filesystem directory scan

### Requirement: Phased rollout and fallback
The system SHALL support phased rollout from file-backed runtime storage to database-backed runtime storage.

#### Scenario: Feature flag controls the source of truth
- **WHEN** operators enable or disable the database-backed runtime storage feature flag
- **THEN** the system SHALL switch the runtime source of truth according to the configured rollout mode
- **AND** the system SHALL expose enough diagnostics to validate which backend is active

#### Scenario: Migration failure supports rollback
- **WHEN** a migration validation step fails or database-backed storage is not healthy
- **THEN** the system SHALL support reverting to the previous file-compatible runtime path without requiring manual reconstruction of runtime state

### Requirement: Provider pool compatibility reads
The system SHALL provide a database-backed compatibility snapshot for existing provider pool readers during migration.

#### Scenario: Legacy readers no longer depend on raw provider_pools file
- **WHEN** `provider-api`, `usage-api`, `config-scanner`, or service-manager status/routing logic reads provider pools while database-backed storage is enabled
- **THEN** the system SHALL resolve data from `ProviderPoolManager` or the database-backed compatibility snapshot rather than requiring `provider_pools.json` to remain the source of truth
- **AND** the snapshot SHALL continue to expose provider-type grouping and legacy fields required by current consumers
