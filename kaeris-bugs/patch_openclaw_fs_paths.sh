#!/bin/bash
set -e

# Script to backup and patch OpenClaw sandbox FS path resolution bug.
# Requires Python 3.

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PYTHON_SCRIPT="${SCRIPT_DIR}/patch_openclaw_fs_paths.py"

usage() {
    cat <<EOF
Usage: $0 [OPTIONS] [DIST_DIR]

Backup and patch OpenClaw sandbox FS path resolution bug.
Target files: sandbox-D2wbSKUX.js, sandbox-BTk3jOUP.js,
              pi-embedded-helpers-DvNaskDY.js, pi-embedded-helpers-iGV05m9S.js.

Options:
  --dry-run          Do not modify files, just show what would be done.
  --backup-dir DIR   Directory to store backups (default: ./backups).
  --help             Show this message.

If DIST_DIR is not provided, the script will attempt to locate the OpenClaw
installation in common locations:
  - /usr/lib/node_modules/openclaw/dist
  - /home/openclaw/.openclaw/node_modules/openclaw/dist
  - /usr/local/lib/node_modules/openclaw/dist

EOF
}

dry_run=""
backup_dir="./backups"
dist_dir=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            dry_run="--dry-run"
            shift
            ;;
        --backup-dir)
            backup_dir="$2"
            shift 2
            ;;
        --help)
            usage
            exit 0
            ;;
        -*)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
        *)
            dist_dir="$1"
            shift
            ;;
    esac
done

if [[ -z "$dist_dir" ]]; then
    # Try to auto‑detect
    candidates=(
        "/usr/lib/node_modules/openclaw/dist"
        "/home/openclaw/.openclaw/node_modules/openclaw/dist"
        "/usr/local/lib/node_modules/openclaw/dist"
    )
    for cand in "${candidates[@]}"; do
        if [[ -d "$cand" ]]; then
            dist_dir="$cand"
            echo "Found OpenClaw dist directory: $dist_dir"
            break
        fi
    done
    if [[ -z "$dist_dir" ]]; then
        echo "ERROR: Could not locate OpenClaw dist directory." >&2
        echo "Please provide the path manually." >&2
        usage >&2
        exit 1
    fi
fi

if [[ ! -d "$dist_dir" ]]; then
    echo "ERROR: dist directory not found: $dist_dir" >&2
    exit 1
fi

# Ensure Python script exists
if [[ ! -f "$PYTHON_SCRIPT" ]]; then
    echo "ERROR: Python script not found at $PYTHON_SCRIPT" >&2
    exit 1
fi

# Run the Python patcher
python3 "$PYTHON_SCRIPT" $dry_run --backup-dir "$backup_dir" "$dist_dir"

echo ""
echo "If the patch succeeded, restart the OpenClaw gateway:"
echo "  sudo systemctl restart openclaw-gateway"
echo "or"
echo "  openclaw gateway restart"