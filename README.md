# eufy-lock-codes

`eufy-lock-codes` is a local MCP server for managing Eufy smart-lock access codes across rental properties. It is designed for real operations: code changes are planned first, write operations require an explicit second step, stored plans are redacted, and successful writes are recorded in a private local escrow when Eufy does not return plaintext.

The system uses the unofficial [`eufy-security-client`](https://github.com/bropat/eufy-security-client) package. Eufy does not provide a stable public smart-lock API, so this project keeps the Eufy integration behind a backend adapter and treats live verification as a maintainer gate.

## What It Does

- Discovers Eufy smart locks and reports capability flags.
- Lists lock-code users and passcode metadata for one lock, one property, or all configured properties.
- Creates dry-run plans for creating, updating, deleting, and rotating codes.
- Executes exactly one unexpired confirmation token.
- Atomically claims confirmation tokens so one pending plan cannot be executed twice.
- Waits for Eufy user-event acknowledgments, then verifies final user-list state.
- Stores locally created or updated plaintext passcodes in ignored private escrow.
- Writes redacted audit logs and live-test backups under ignored local state.

It never performs lock or unlock commands.

## Safety Model

- Write operations require a plan first, then `execute_plan`.
- Plans expire and cannot be reused after execution.
- Pending plan files contain masked operations. Plaintext needed for execution is stored separately under ignored local state, deleted when a plan is claimed, and cleaned during expiry maintenance.
- Public tool responses and audit logs mask passcodes.
- Ambiguous usernames, missing mappings, unsupported locks, and failed list calls are hard stops.
- Rotation creates or updates the replacement before deleting an old user when the username changes.
- If a later operation fails after new users were created, the executor attempts to delete those newly created users to avoid leaving extra active access.
- Live verification scripts require `--yes-live-write` or `EUFY_CONFIRM_LIVE_WRITE=1`.

## Architecture

- `mcp/server.mjs` exposes MCP tools over stdio.
- `src/tools.mjs` implements planning, target resolution, safety checks, and execution.
- `src/backend/eufy-adapter.mjs` isolates the unofficial Eufy client and waits for user-event acknowledgments.
- `src/plan-store.mjs` persists redacted plans, short-lived pending secrets, expiry cleanup, and redacted audit records under `data/`.
- `src/escrow.mjs` stores plaintext for locally created or updated codes under ignored local state.
- `src/recovery-cache.mjs` can merge previously recovered local inventory into masked list responses when private recovery files exist.

## MCP Tools

- `discover_locks`: list Eufy smart locks and capability flags.
- `health_check`: verify credentials, Eufy connectivity, config, and mapped lock availability.
- `list_lock_codes`: list users and passcode metadata without returning full plaintext passcodes.
- `plan_create_code`: create a dry-run add-user/code plan.
- `plan_update_code`: create a dry-run passcode or schedule update plan.
- `plan_delete_code`: create a dry-run exact-username delete plan.
- `plan_rotate_codes`: create a dry-run tenant or maintenance rotation plan.
- `execute_plan`: execute one unexpired confirmation token.

## Setup

Requirements:

- Node.js 24 or newer
- A Eufy account with supported smart locks

Install dependencies:

```bash
npm ci
```

Create local configuration:

```bash
cp .env.example .env
cp config/properties.example.yaml config/properties.local.yaml
```

Fill `.env` with:

```bash
eufy_email=your-account@example.com
eufy_pass=your-password
EUFY_COUNTRY=US
EUFY_LANGUAGE=en
```

Fill `config/properties.local.yaml` with your real property aliases and lock serials. Local configs are ignored by git.

## Running

Run the MCP server:

```bash
node mcp/server.mjs
```

Run the no-credentials demo:

```bash
npm run demo
```

Run local checks:

```bash
npm run check
```

Run test coverage:

```bash
npm run coverage
```

Run a read-only Eufy smoke check with real local credentials:

```bash
npm run smoke
```

Run live CRUD verification against one configured test lock:

```bash
EUFY_LIVE_TEST_PROPERTY=sample-property \
EUFY_LIVE_TEST_LOCK_ALIAS=front \
npm run test:live -- --yes-live-write
```

The live test creates and removes temporary users, creates and removes one scheduled expiring code, writes before/after backups under `data/backups/`, and verifies the test users are gone. It does not lock or unlock the door.

## Example Flow

1. Run `health_check`.
2. Run `list_lock_codes` for the target property or lock.
3. Run a `plan_*` tool.
4. Review the dry-run operations and confirmation token.
5. Run `execute_plan` only for the intended token.
6. Re-run `list_lock_codes` to verify final state.

## Limitations

- Eufy smart-lock APIs are unofficial and can drift.
- Existing plaintext PINs are not always available from Eufy cloud responses.
- Passcode value verification is limited by what Eufy returns; writes are verified through acknowledgements, final user-list state, and local escrow.
- Offline or low-battery locks may not answer live P2P/read operations.
- Production use should keep local backups and use a designated live verification lock after backend changes.

See [docs/threat-model.md](docs/threat-model.md) and [docs/verification.md](docs/verification.md) for the safety assumptions and maintainer verification gate.

## License

AGPL-3.0-only.
