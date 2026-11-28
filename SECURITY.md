# Reporting a vulnerability

Open the repository's **Security** tab and choose **Report a vulnerability**. Include the affected
version, the conditions needed to reproduce the issue, and its impact. Use synthetic records in
reproductions. Keep keys, credentials, and personal workout data out of the report.

The sync servers in `apps/sync-cloudflare` (the managed server) and `apps/sync-node` (the one people
host themselves) sign phones in per account and keep administration separate from it. Reports
about either are in scope, as are reports about the iPhone app.
