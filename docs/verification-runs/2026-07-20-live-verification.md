# Live Verification Run: 2026-07-20

This is a sanitized maintainer-run record. Raw logs, backups, lock serials, property names, and passcodes remain in ignored local state.

## Environment

- Runtime: local checkout with ignored `.env`
- Config source: ignored `config/properties.local.yaml`
- Target: designated test lock from local config
- Safety constraint: no lock or unlock commands

## Commands

```bash
npm run check
npm run coverage
npm run smoke
npm run test:live -- --property <local-property-alias> --lock-alias <local-lock-alias> --yes-live-write
gitleaks protect --staged --redact --verbose
```

## Results

- Unit tests: passed
- Coverage threshold: passed
- Demo: passed without Eufy credentials
- MCP metadata validation: passed
- npm audit at moderate level: passed
- Read-only live smoke: passed against configured local inventory
- Live create/update/delete verification: passed
- Live scheduled expiring code verification: passed
- Local escrow verification: passed
- Cleanup verification: passed; temporary test users were absent at the end
- Staged secret scan: passed

## Notes

- The live script wrote before/after backups and a detailed report under ignored `data/backups/`.
- The raw report is intentionally not tracked because it can contain operational lock metadata.
- Eufy does not consistently expose plaintext passcodes after writes; verification combines acknowledgement, final user-list state, schedule metadata when available, and local escrow.
