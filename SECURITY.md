# Security

This project manages physical access credentials. Treat the local checkout and runtime state as sensitive.

## Sensitive Local State

The following files and directories must not be committed:

- `.env`
- `config/*.local.*`
- `data/`
- `persistent.json`
- raw Eufy responses
- plaintext PIN inventories
- downloaded research artifacts

The `.gitignore` is configured to exclude these paths. Run a tracked-file secret scan before publishing or pushing.

## Passcode Handling

- Tool responses mask passcodes.
- Redacted audit logs are written under `data/audit/`.
- Local plaintext escrow is stored under `data/lock-code-escrow.local.json`.
- Live verification backups are stored under `data/backups/`.

These files are local operational state and should stay private.

## Live Operations

Live write tests require explicit confirmation with `--yes-live-write` or `EUFY_CONFIRM_LIVE_WRITE=1`. The live CRUD verification script creates temporary access users and removes them after verification. It does not send lock or unlock commands.

## Reporting Issues

If you find a security issue, do not open a public issue containing credentials, PINs, device serials, or raw Eufy responses. Use a private channel with enough detail to reproduce the issue safely.
