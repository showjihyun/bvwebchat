# Release runbook

The GitHub workflow verifies a deployable Docker artifact. An internal deployment owner carries out this controlled production release.

1. Record the commit SHA that passed `deploy.yml`; build from that exact checkout and tag the image `bvwebchat:<SHA>`.
2. On the internal Docker host, run the candidate image on a temporary port.
3. Execute `bash scripts/smoke.sh http://localhost:<temporary-port>` against that candidate.
4. Replace the production container only after the smoke check passes. Keep the prior image tag until the release is accepted.
5. Run the same smoke command against the production URL, confirming health, room isolation, and global broadcast.
6. If verification fails, start the previous image tag again and retain the failed container logs for investigation.

Before the first production release, the deployment owner must supply the internal host, exposed port, reverse-proxy/TLS owner, and image transfer method. These environment-specific values must not be committed to the repository.
