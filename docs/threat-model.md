# Threat Model

This project manages physical access credentials through a local MCP server. The main security boundary is the local machine account running the server and the MCP client allowed to invoke it.

## Assets

- Eufy account credentials in `.env`
- Lock serial numbers and property mappings in `config/*.local.*`
- Pending plan secrets under `data/pending-plan-secrets/`
- Plaintext escrow for locally created or updated passcodes under `data/lock-code-escrow.local.json`
- Redacted audit logs and live verification backups under `data/`

All of these paths are ignored by git.

## Trust Boundaries

- The MCP server is intended for local stdio use, not exposure as a network service.
- Any MCP client that can call `execute_plan` is trusted to execute access-control changes after a dry-run plan is reviewed.
- Eufy cloud and device acknowledgements are treated as external signals and are followed by a user-list verification pass.
- The unofficial Eufy client and raw password-list endpoint are adapter details; they should not leak into tool consumers.

## Controls

- Writes require a dry-run plan and a confirmation token.
- Plan claiming is atomic: once `execute_plan` claims a token, concurrent callers cannot execute the same pending plan.
- Stored plan files contain masked operations only. Plaintext passcodes needed for pending execution are stored separately, removed as soon as a plan is claimed, and cleaned up when expired plans are detected during normal tool activity.
- Each write waits for a Eufy acknowledgement and then verifies final user-list state.
- If a later operation fails after new users were created, the executor attempts to delete those newly created users to avoid leaving extra active access.
- If a plan stays in `executing` too long after a process crash, normal maintenance marks it `interrupted` with `remediationRequired` so the operator can reconcile lock state from fresh reads.
- Public tool responses and audit logs redact passcodes and tokens. Error/audit redaction also scrubs serial-like and email-like values when they appear inside free-text messages.
- Serial numbers are still returned as operational identifiers by tools that need to target locks. Treat MCP responses as sensitive local output.
- Discovery omits location metadata unless the caller explicitly asks for it.

## Known Residual Risk

- Eufy does not always return plaintext passcodes after creation or update, so passcode value verification is limited to acknowledgement plus final user presence and local escrow.
- Rollback is only possible for newly created users. Updates and deletes cannot be fully reversed unless the previous code is already known through local escrow or another private source.
- A lost acknowledgement can still require reconciliation if Eufy applied a write but later read/cleanup attempts cannot confirm the final state.
- The Eufy API surface is unofficial and can drift. Backend changes require local live verification before release.
- The server should not be exposed to untrusted MCP clients or multi-user hosts without an additional authorization layer.
