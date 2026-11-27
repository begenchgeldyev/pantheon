# Keep runtime packaging, private backups and activation separate

The deployment repo can recreate the pinned OpenClaw and CLIProxyAPI runtimes, but it is public and cannot hold a copy of the running instance. A private encrypted recovery capture preserves agent history and saved job definitions; credentials come from a separate store or are reissued. CI runs only fixtures rather than installing onto a live host. The trade-off is that recovery requires all three inputs and an explicit cutover, but neither a Git merge nor a successful restore can start another production consumer.

On a live instance, a successful file copy or a separate SQLite backup for each database cannot establish one consistent point across databases and workspace files. Admit only a verified point-in-time capture or a capture made with all writers quiesced in an approved window. Rejecting an unproven capture delays the backup rather than presenting a corrupt or mixed-generation copy as recoverable.
