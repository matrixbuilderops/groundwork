#!/bin/sh
# run-local.sh — run THIS repo copy of package-telemetry with zero registry impact.
#
#   ./run-local.sh --runs --no-save
#
# Why this exists: every `npx package-telemetry` downloads the tarball, which
# counts as +1 download on your own stats. Running the local file with node
# makes no tarball request, so your self-checks never inflate your numbers.
#
# The tool's own API calls (registry metadata, PyPI JSON, api.npmjs.org,
# data.jsdelivr.com stats) are metadata/stats reads, not tarball pulls, so
# they increment nothing on either registry. Only fetching the package
# itself (npx / npm install) counts — and this script never does that.
#
# This file is repo-side only: it is NOT shipped in the npm tarball (see the
# "files" allowlist in package.json). Run it from a groundwork clone.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/bin/cli.mjs" "$@"
