# Reporting a vulnerability

Open the repository's **Security** tab and choose **Report a vulnerability**. Include the affected
version, the conditions needed to reproduce the issue, and its impact. Use synthetic records in
reproductions. Keep keys, credentials, and personal workout data out of the report.

The sync servers in `apps/sync-node` and `apps/sync-cloudflare` are development previews. Both
sign phones in per account and keep administration separate from it, but Leve doesn't keep real
data yet: use them with disposable data in an environment you control.
