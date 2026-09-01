#!/bin/bash
# Build dsh-preset-zombie-guard: compile src/ → lib/ with tsc.
#
# DSH_CHECKOUT resolution (first hit wins):
#   1. $DSH_CHECKOUT environment variable (validated below)
#   2. default candidate: D:/DSH-Portable/profile/profiles/web
#      (this deployment's web profile — its node_modules carries the published
#       @deepseek-ai/* packages used for type resolution)
#   3. $HOME/dsh-harness, $HOME/dsh, $HOME/.dsh/dsh-harness
#      (dsh source checkouts — packages/ + vendor/ layout)
#
# The checkout may be either a SOURCE checkout (packages/core/tools +
# vendor/cordis exist) or a PROFILE install (node_modules/@deepseek-ai/cordis
# exists). Dependency junction links are created under ./node_modules for tsc
# module resolution; tsc itself is resolved from $CHECKOUT/node_modules/.bin
# or ./node_modules/.bin (offline devDependency install, see README).
#
# NOTE (Windows): PATH `bash` may be WSL bash, which cannot run Windows node.
# Use a Git Bash, e.g.: "D:/SoftWare/Git/bin/bash.exe" scripts/build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ---- locate the checkout -----------------------------------------------------
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "D:/DSH-Portable/profile/profiles/web" "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then
      CHECKOUT="$candidate"
      break
    fi
  done
fi
if [ -z "$CHECKOUT" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi

# ---- detect the checkout layout ----------------------------------------------
LAYOUT=""
if [ -d "$CHECKOUT/packages/core/tools" ] && [ -d "$CHECKOUT/vendor/cordis" ]; then
  LAYOUT="source"
elif [ -d "$CHECKOUT/node_modules/@deepseek-ai/cordis" ]; then
  LAYOUT="profile"
fi
if [ -z "$LAYOUT" ]; then
  echo "build: $CHECKOUT is neither a dsh source checkout (packages/ + vendor/) nor a profile install (node_modules/@deepseek-ai/cordis)" >&2
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo "build: node not found on PATH" >&2; exit 1; }

# ---- dependency junction links under ./node_modules --------------------------
link_pkg() {
  # link_pkg <node_modules-relative-name> <target-under-checkout> [required]
  local name="$1" target="$CHECKOUT/$2" required="${3:-required}"
  if [ ! -e "$target" ]; then
    if [ "$required" = "required" ]; then
      echo "build: dependency target missing: $target" >&2
      exit 1
    fi
    echo "build: skip optional dependency $name (target missing: $target)"
    return 0
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$name" "$target"
}

echo "=== Linking build dependencies (checkout: $CHECKOUT, layout: $LAYOUT) ==="
mkdir -p node_modules

if [ "$LAYOUT" = "source" ]; then
  # dsh source checkout: repository.directory mapping of each package
  link_pkg @deepseek-ai/cordis vendor/cordis
  link_pkg @deepseek-ai/cosmokit vendor/cosmokit
  link_pkg @deepseek-ai/schemastery vendor/schemastery
  link_pkg @deepseek-ai/dsh-tools packages/core/tools
  link_pkg @deepseek-ai/dsh-scope packages/core/scope
  link_pkg @deepseek-ai/dsh-llm packages/llm/llm
  link_pkg @deepseek-ai/dsh-agent packages/core/agent
  link_pkg @deepseek-ai/dsh-session packages/core/session
  link_pkg @deepseek-ai/dsh-system-prompt packages/core/system-prompt
  link_pkg @deepseek-ai/dsh-brand packages/util/brand
  link_pkg @deepseek-ai/dsh-attachment packages/attachment/attachment
  link_pkg @deepseek-ai/dsh-typert-protocol packages/typert/protocol
  link_pkg @deepseek-ai/dsh-code-runtime packages/code-runtime/code-runtime
  STD_SCHEMA=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1)
  if [ -n "$STD_SCHEMA" ]; then
    node -e "
      const fs = require('fs');
      const path = require('path');
      fs.rmSync('node_modules/@standard-schema', { recursive: true, force: true });
      fs.mkdirSync('node_modules/@standard-schema', { recursive: true });
      fs.symlinkSync(path.resolve(process.argv[1]), path.resolve('node_modules/@standard-schema/spec'), process.platform === 'win32' ? 'junction' : 'dir');
    " "$STD_SCHEMA/node_modules/@standard-schema/spec"
  else
    echo "build: @standard-schema/spec not found in checkout store; skipLibCheck should cover it" >&2
  fi
else
  # profile install: published packages under the profile's node_modules
  link_pkg @deepseek-ai/cordis node_modules/@deepseek-ai/cordis
  link_pkg @deepseek-ai/cosmokit node_modules/@deepseek-ai/cosmokit
  link_pkg @deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery
  link_pkg @deepseek-ai/dsh-tools node_modules/@deepseek-ai/dsh-tools
  link_pkg @deepseek-ai/dsh-scope node_modules/@deepseek-ai/dsh-scope
  link_pkg @deepseek-ai/dsh-llm node_modules/@deepseek-ai/dsh-llm
  link_pkg @deepseek-ai/dsh-agent node_modules/@deepseek-ai/dsh-agent
  link_pkg @deepseek-ai/dsh-session node_modules/@deepseek-ai/dsh-session
  link_pkg @deepseek-ai/dsh-system-prompt node_modules/@deepseek-ai/dsh-system-prompt
  link_pkg @deepseek-ai/dsh-brand node_modules/@deepseek-ai/dsh-brand
  link_pkg @deepseek-ai/dsh-attachment node_modules/@deepseek-ai/dsh-attachment
  link_pkg @deepseek-ai/dsh-typert-protocol node_modules/@deepseek-ai/dsh-typert-protocol
  link_pkg @deepseek-ai/dsh-code-runtime node_modules/@deepseek-ai/dsh-code-runtime
  node -e "
    const fs = require('fs');
    const path = require('path');
    const target = path.resolve(process.argv[1], 'node_modules/@standard-schema/spec');
    fs.rmSync('node_modules/@standard-schema', { recursive: true, force: true });
    if (fs.existsSync(target)) {
      fs.mkdirSync('node_modules/@standard-schema', { recursive: true });
      fs.symlinkSync(target, path.resolve('node_modules/@standard-schema/spec'), process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      console.error('build: @standard-schema/spec not found in profile node_modules; skipLibCheck should cover it');
    }
  " "$CHECKOUT"
fi
# @types/node (compile-time types; both layouts keep it in node_modules)
link_pkg @types/node node_modules/@types/node optional

# ---- resolve tsc --------------------------------------------------------------
TSC=""
for candidate in "$CHECKOUT/node_modules/.bin/tsc" "$ROOT/node_modules/.bin/tsc"; do
  if [ -x "$candidate" ] || [ -f "$candidate" ] || [ -f "$candidate.cmd" ] || [ -f "$candidate.CMD" ]; then
    TSC="$candidate"
    break
  fi
done
if [ -z "$TSC" ]; then
  echo "build: tsc not found (looked in \$DSH_CHECKOUT/node_modules/.bin and ./node_modules/.bin)" >&2
  echo "build: install the devDependency offline from the local pnpm store:" >&2
  echo "build:   node <pnpm.mjs> install --store-dir=D:/DSH-Portable/.pnpm-store --prefer-offline --config.node-linker=hoisted --config.auto-install-peers=false" >&2
  exit 1
fi

echo "=== Compiling src → lib (tsc $("$TSC" --version)) ==="
"$TSC" -p tsconfig.json

echo "=== Build complete ==="
ls -la lib/ lib/types/ 2>/dev/null || ls -la lib/
