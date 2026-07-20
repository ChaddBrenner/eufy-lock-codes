# Verification

This repository separates public-safe CI from local maintainer verification against a real Eufy account.

## Public-Safe CI

CI runs only checks that are safe in a fresh clone without Eufy credentials:

```bash
npm ci
npm test
npm run coverage
npm run demo
npm run validate:mcp
npm audit --audit-level=moderate
```

The GitHub workflow also runs a tracked-file secret scan. CI must not use real lock credentials and must not perform live writes.

## Local Maintainer Gate

Backend or tool changes that touch Eufy behavior require a local verification pass with ignored `.env` credentials and ignored `config/properties.local.yaml`.

Required read-only check:

```bash
npm run smoke
```

Required live write check against a designated test lock:

```bash
EUFY_LIVE_TEST_PROPERTY=sample-property \
EUFY_LIVE_TEST_LOCK_ALIAS=front \
npm run test:live -- --yes-live-write
```

The live test performs:

- before backup under `data/backups/`
- create temporary code
- update temporary code
- delete temporary code
- create scheduled expiring code
- verify local escrow
- delete scheduled code
- after backup under `data/backups/`
- post-cleanup verification that temporary users are gone

It does not send lock or unlock commands.

## Latest Maintainer Verification

On 2026-07-20, the maintainer gate was run against the real Eufy account using ignored local configuration. The read-only smoke check passed for the configured inventory, and live CRUD verification passed on the designated test lock. The raw artifacts remain under ignored `data/backups/` because they can contain operational metadata.

A sanitized record is tracked at [verification-runs/2026-07-20-live-verification.md](verification-runs/2026-07-20-live-verification.md).
