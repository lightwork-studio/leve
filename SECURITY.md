# Reporting a vulnerability

Open the repository's **Security** tab and choose **Report a vulnerability**. Include the affected
version, the conditions needed to reproduce the issue, and its impact. Use synthetic records in
reproductions. Keep keys, credentials, and personal workout data out of the report.

The sync servers in `apps/sync-node` and `apps/sync-cloudflare` are benchmarking prototypes.
Use them with disposable data in an environment you control. Production use requires account-level
authentication and authorization for both sync and administrative operations.
