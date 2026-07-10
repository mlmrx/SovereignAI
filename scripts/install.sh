#!/usr/bin/env sh
# SovereignAI installer for macOS/Linux.
#   curl -fsSL https://raw.githubusercontent.com/mlmrx/SovereignAI/main/scripts/install.sh | sh
set -eu

REPO="mlmrx/SovereignAI"
DEST="${SOVEREIGN_INSTALL_DIR:-$HOME/.sovereignai}"
BIN_DIR="${SOVEREIGN_BIN_DIR:-$HOME/.local/bin}"

printf '\n  ⬡ SovereignAI installer\n\n'

# 1. Node 22.5+
if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js not found. Install Node 22+ from https://nodejs.org first." >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "  Node $(node --version) found, but 22.5+ is required." >&2
  exit 1
fi

# 2. Fetch source
if [ -d "$DEST/.git" ]; then
  echo "  Updating existing install at $DEST"
  git -C "$DEST" pull --quiet
elif command -v git >/dev/null 2>&1; then
  git clone --quiet "https://github.com/$REPO" "$DEST"
else
  TMP=$(mktemp -d)
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$TMP"
  mkdir -p "$DEST"
  cp -R "$TMP/SovereignAI-main/." "$DEST/"
  rm -rf "$TMP"
fi

# 3. Launcher on PATH
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/sovereign" <<EOF
#!/usr/bin/env sh
exec node --no-warnings "$DEST/bin/sovereign.js" "\$@"
EOF
chmod +x "$BIN_DIR/sovereign"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  NOTE: add $BIN_DIR to your PATH (e.g. in ~/.bashrc or ~/.zshrc)" ;;
esac

cat <<EOF

  Installed to $DEST

  Start your AI:     sovereign start
  Then open:         http://127.0.0.1:4321
  Local models:      install Ollama from https://ollama.com and 'ollama pull llama3.1'

  Your models. Your memory. Your machine.
EOF
