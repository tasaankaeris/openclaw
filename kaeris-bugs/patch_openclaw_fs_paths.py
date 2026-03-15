#!/usr/bin/env python3
"""
Backup and patch OpenClaw sandbox FS path resolution bug.

Target files (in the OpenClaw dist directory):
- sandbox-D2wbSKUX.js
- sandbox-BTk3jOUP.js
- pi-embedded-helpers-DvNaskDY.js
- pi-embedded-helpers-iGV05m9S.js

The bug: resolveSandboxFsPathWithMounts incorrectly rejects individually mounted
files inside /workspace (USER.md, .workspace.manifest, workflow files, shared/).
The fix adds logic to choose the more specific container-side mount.

Usage:
    python3 patch_openclaw_fs_paths.py [--dry-run] [--backup-dir BACKUP_DIR] DIST_DIR

Example:
    python3 patch_openclaw_fs_paths.py /usr/lib/node_modules/openclaw/dist
"""
import re, os, sys, shutil, argparse
from pathlib import Path

# Pattern matches the block from 'const hostResolved = ...' to the closing brace before 'resolveSandboxPath'
# Uses DOTALL to match across lines, expects exact indentation (tabs).
PATTERN = r'(\s*const hostResolved = resolveSandboxInputPath\(input, params\.cwd\);\s*\n\s*const hostMount = findMountByHostPath\(mountsByHost, hostResolved\);\s*\n\s*if \(hostMount\) {\s*\n\s*const relHost = path\.relative\(hostMount\.hostRoot, hostResolved\);\s*\n\s*const relPosix = relHost \? relHost\.split\(path\.sep\)\.join\(path\.posix\.sep\) : "";\s*\n\s*const containerPath = relPosix \? path\.posix\.join\(hostMount\.containerRoot, relPosix\) : hostMount\.containerRoot;\s*\n\s*return {\s*\n\s*hostPath: hostResolved,\s*\n\s*containerPath,\s*\n\s*relativePath: toDisplayRelative\({\s*\n\s*containerPath,\s*\n\s*defaultContainerRoot: params\.defaultContainerRoot\s*\n\s*}\),\s*\n\s*writable: hostMount\.writable\s*\n\s*};\s*\n\s*})'

REPLACEMENT = '''\tconst hostResolved = resolveSandboxInputPath(input, params.cwd);
\tconst hostMount = findMountByHostPath(mountsByHost, hostResolved);
\tif (hostMount) {
\t\tconst relHost = path.relative(hostMount.hostRoot, hostResolved);
\t\tconst relPosix = relHost ? relHost.split(path.sep).join(path.posix.sep) : "";
\t\tconst containerPath = relPosix ? path.posix.join(hostMount.containerRoot, relPosix) : hostMount.containerRoot;
\t\t// If a more specific mount shadows this path in the container, use it so resolution and safety agree.
\t\tconst containerMount = findMountByContainerPath(mountsByContainer, containerPath);
\t\tconst mount = containerMount && containerMount !== hostMount ? containerMount : hostMount;
\t\tconst hostPath =
\t\t\tmount === hostMount
\t\t\t\t? hostResolved
\t\t\t\t: path.resolve(
\t\t\t\t\tmount.hostRoot,
\t\t\t\t\t...toHostSegments(path.posix.relative(mount.containerRoot, containerPath)),
\t\t\t\t);
\t\treturn {
\t\t\thostPath,
\t\t\tcontainerPath,
\t\t\trelativePath: toDisplayRelative({
\t\t\t\tcontainerPath,
\t\t\t\tdefaultContainerRoot: params.defaultContainerRoot
\t\t\t}),
\t\t\twritable: hostMount.writable
\t\t};
\t}'''

TARGETS = [
    "sandbox-D2wbSKUX.js",
    "sandbox-BTk3jOUP.js",
    "pi-embedded-helpers-DvNaskDY.js",
    "pi-embedded-helpers-iGV05m9S.js",
]

def backup_file(path: Path, backup_dir: Path) -> Path:
    """Copy file to backup_dir with timestamp suffix."""
    timestamp = os.path.getmtime(path)
    backup_name = f"{path.name}.backup-{int(timestamp)}"
    backup_path = backup_dir / backup_name
    shutil.copy2(path, backup_path)
    return backup_path

def patch_file(file_path: Path, dry_run: bool = False) -> bool:
    """Apply the regex substitution to a single file."""
    try:
        with open(file_path, 'r') as f:
            content = f.read()
    except Exception as e:
        print(f"  ERROR reading {file_path}: {e}", file=sys.stderr)
        return False

    new_content = re.sub(PATTERN, REPLACEMENT, content, flags=re.DOTALL)
    if new_content == content:
        print(f"  WARNING: pattern not found in {file_path}")
        return False

    if dry_run:
        print(f"  DRY-RUN: would patch {file_path}")
        return True

    try:
        with open(file_path, 'w') as f:
            f.write(new_content)
    except Exception as e:
        print(f"  ERROR writing {file_path}: {e}", file=sys.stderr)
        return False

    print(f"  Patched {file_path}")
    return True

def main():
    parser = argparse.ArgumentParser(description="Patch OpenClaw sandbox FS path bug.")
    parser.add_argument("dist_dir", help="Path to OpenClaw dist directory")
    parser.add_argument("--dry-run", action="store_true", help="Do not modify files")
    parser.add_argument("--backup-dir", default="./backups", help="Directory to store backups (default ./backups)")
    args = parser.parse_args()

    dist_dir = Path(args.dist_dir).resolve()
    if not dist_dir.is_dir():
        print(f"ERROR: dist directory not found: {dist_dir}", file=sys.stderr)
        sys.exit(1)

    backup_dir = Path(args.backup_dir).resolve()
    if not args.dry_run:
        backup_dir.mkdir(parents=True, exist_ok=True)
        print(f"Backups will be saved to {backup_dir}")

    print(f"Patching files in {dist_dir}")
    success = True
    for name in TARGETS:
        path = dist_dir / name
        if not path.is_file():
            print(f"  SKIP: {name} not found")
            continue
        print(f"  Processing {name}...")
        if not args.dry_run:
            backup_path = backup_file(path, backup_dir)
            print(f"    Backup saved to {backup_path}")
        if not patch_file(path, dry_run=args.dry_run):
            success = False

    if success:
        print("\nAll targets processed successfully.")
        if args.dry_run:
            print("Dry run completed – no files changed.")
        else:
            print("Patch applied. Restart OpenClaw gateway to activate.")
    else:
        print("\nSome targets failed.", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()