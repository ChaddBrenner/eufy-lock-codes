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
- Pending plan files under `data/plans/` store masked operations only.
- Short-lived pending execution secrets are stored under `data/pending-plan-secrets/`, removed when a plan is claimed for execution, and cleaned when expired plans are detected.
- Local plaintext escrow is stored under `data/lock-code-escrow.local.json`.
- Live verification backups are stored under `data/backups/`.

These files are local operational state and should stay private.

## Live Operations

Live write tests require explicit confirmation with `--yes-live-write` or `EUFY_CONFIRM_LIVE_WRITE=1`. The live CRUD verification script creates temporary access users and removes them after verification. It does not send lock or unlock commands.

The MCP server is intended for local stdio use. Do not expose it as a network service without adding authentication and authorization around tool calls.

## Reporting Issues

If you find a security issue, do not open a public issue containing credentials, PINs, device serials, or raw Eufy responses. Use a private channel with enough detail to reproduce the issue safely.
