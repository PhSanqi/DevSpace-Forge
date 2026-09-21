#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-0.3.0}"
RUNTIME_PACKAGE="${2:?usage: package-release-linux.sh VERSION RUNTIME_PACKAGE}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"
NAME="DevSpace-Forge-v${VERSION}-linux-x64"
STAGE_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/devspace-control-release.XXXXXX")"
STAGE="$STAGE_PARENT/$NAME"
NODE_VERSION="22.22.3"
NODE_SHA256="2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f"
CLOUDFLARED_VERSION="2026.9.1"
CLOUDFLARED_SHA256="03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc"

trap 'rm -rf "$STAGE_PARENT"' EXIT
rm -f "$DIST/$NAME.tar.gz" "$DIST/$NAME.tar.gz.sha256.txt"
mkdir -p "$STAGE/runtime/devspace" "$STAGE/ops" "$DIST/.offline-cache/linux"

cp "$ROOT/setup-linux.sh" "$STAGE/setup-linux.sh"
cp "$ROOT/ops/runtime-console.sh" "$STAGE/ops/runtime-console.sh"
cp "$ROOT/README.md" "$ROOT/README.zh-CN.md" "$ROOT/LICENSE" "$STAGE/"
chmod 0755 "$STAGE/setup-linux.sh" "$STAGE/ops/runtime-console.sh"

NODE_ARCHIVE="$DIST/.offline-cache/linux/node-v${NODE_VERSION}-linux-x64.tar.xz"
if [[ ! -f "$NODE_ARCHIVE" ]] || [[ "$(sha256sum "$NODE_ARCHIVE" | awk '{print $1}')" != "$NODE_SHA256" ]]; then
  curl -fL --retry 8 --retry-delay 2 -o "$NODE_ARCHIVE.partial" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
  [[ "$(sha256sum "$NODE_ARCHIVE.partial" | awk '{print $1}')" == "$NODE_SHA256" ]] || { echo 'Node SHA256 mismatch' >&2; exit 1; }
  mv -f "$NODE_ARCHIVE.partial" "$NODE_ARCHIVE"
fi
mkdir -p "$STAGE/runtime/.node-extract"
tar -xJf "$NODE_ARCHIVE" -C "$STAGE/runtime/.node-extract"
mv "$STAGE/runtime/.node-extract/node-v${NODE_VERSION}-linux-x64" "$STAGE/runtime/node"
rm -rf "$STAGE/runtime/.node-extract"

cp "$RUNTIME_PACKAGE" "$STAGE/runtime/devspace/devspace-runtime.tgz"
cat > "$STAGE/runtime/devspace/package.json" <<'EOF'
{
  "private": true,
  "name": "devspace-control-platform-linux-offline-runtime",
  "dependencies": {
    "@waishnav/devspace": "file:devspace-runtime.tgz"
  }
}
EOF
PATH="$STAGE/runtime/node/bin:$PATH" \
  "$STAGE/runtime/node/bin/node" \
  "$STAGE/runtime/node/lib/node_modules/npm/bin/npm-cli.js" \
  install --omit=dev --no-fund --no-audit --prefix "$STAGE/runtime/devspace"

# Keep the Linux bundle aligned with the Windows Control runtime. Subagents are
# disabled in the current product scope, so the Claude Agent SDK payload is not
# needed. Type declarations, source maps, and PDBs are build/debug metadata and
# are also unnecessary at runtime. pi-coding-agent stays because core
# workspace/skills code imports it directly.
NODE_MODULES="$STAGE/runtime/devspace/node_modules"
find "$NODE_MODULES" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.pdb' \) -delete
rm -rf "$NODE_MODULES"/@anthropic-ai/claude-agent-sdk*

CLOUDFLARED_CACHE="$DIST/.offline-cache/linux/cloudflared-${CLOUDFLARED_VERSION}-linux-amd64"
if [[ ! -f "$CLOUDFLARED_CACHE" ]] || [[ "$(sha256sum "$CLOUDFLARED_CACHE" | awk '{print $1}')" != "$CLOUDFLARED_SHA256" ]]; then
  curl -fL --retry 8 --retry-delay 2 -o "$CLOUDFLARED_CACHE.partial" "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64"
  [[ "$(sha256sum "$CLOUDFLARED_CACHE.partial" | awk '{print $1}')" == "$CLOUDFLARED_SHA256" ]] || { echo 'cloudflared SHA256 mismatch' >&2; exit 1; }
  mv -f "$CLOUDFLARED_CACHE.partial" "$CLOUDFLARED_CACHE"
fi
cp "$CLOUDFLARED_CACHE" "$STAGE/cloudflared"
chmod 0755 "$STAGE/cloudflared" "$STAGE/runtime/node/bin/node"

DEVSPACE_VERSION="$($STAGE/runtime/node/bin/node -p "require(process.argv[1]).version" "$STAGE/runtime/devspace/node_modules/@waishnav/devspace/package.json")"
echo "Linux bundle runtime: $DEVSPACE_VERSION"
RUNTIME_FILE_COUNT="$(find "$STAGE/runtime" -type f | wc -l | tr -d ' ')"
RUNTIME_SIZE_MIB="$(du -sm "$STAGE/runtime" | awk '{print $1}')"
echo "Pruned Linux runtime: ${RUNTIME_SIZE_MIB} MiB / ${RUNTIME_FILE_COUNT} files"
"$STAGE/runtime/node/bin/node" --version
"$STAGE/cloudflared" --version

tar -C "$STAGE_PARENT" -czf "$DIST/$NAME.tar.gz" "$NAME"
(cd "$DIST" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256.txt")
echo "Created $DIST/$NAME.tar.gz"
