# Automatic Compose File Assignment

For existing stacks on a local Docker Unix socket, enable **Trust Compose path labels** in **Settings > Environments**. This setting is off by default and applies only to the selected environment.

When a user with stack creation permission opens or refreshes the Stacks page, Dockhand attempts to register unassigned stacks using `com.docker.compose.project.config_files`. Registration does not edit files, deploy stacks, or restart containers. Disabling the setting stops future automatic assignments without removing existing ones.

## Requirements

- The Compose file is available at the same absolute path inside Dockhand as in the container label (a 1:1 mount).
- The file is under the configured `STACKS_DIR` or `DATA_DIR/stacks/<environment-name>` (the default `DATA_DIR` is `./data`). A mount by itself, or an entry in Recent locations, does not grant trust.
- Every container advertises the same single `.yaml` or `.yml` file. Multiple files, stdin (`-`), and relative paths are not supported.
- The file is a readable regular file. Symlinks cannot escape the allowed root, and protected filesystem locations are rejected.
- If `com.docker.compose.project.working_dir` is present, it resolves to the Compose file's directory. Custom project directories are not supported.
- No container opts out with `dockhand.adopt=false`.

For example, mount `/srv/stacks:/srv/stacks` into Dockhand and set `STACKS_DIR=/srv/stacks`. A label pointing to `/srv/stacks/web/compose.yaml` can then be adopted without browsing for it manually.

Only enable this setting for a Docker environment whose containers and stack files you trust. The checks run at assignment time; assigned files remain trusted afterward, just like manually selected files. Existing manual, internal, and Git assignments are never replaced. Once assigned, normal Dockhand Compose operations use the file, including the existing handling of sibling `.env` and override files.

## Rejected Paths

Rejected stacks remain unassigned. The **Not adopted** badge on the Stacks page explains the reason; manual file selection remains available. After correcting the path or mount, refresh the page to retry.

Remote Docker TCP connections and Hawser are not supported by this initial implementation. Dockhand does not translate mount paths or fetch files from a remote host.

API clients can trigger the same operation with `POST /api/stacks/auto-adopt?env=<id>`. It requires `stacks:create` and access to the target environment; the opt-in and connection type are checked on the server.
