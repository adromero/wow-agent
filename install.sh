#!/bin/bash
# Symlinks the WoWAgent addon into a WoW AddOns directory.
# The addon's TOC lists all supported interface versions, so the same
# folder works in any WoW version.
#
# Usage:
#   ./install.sh                     # Auto-detect all WoW installs
#   ./install.sh retail              # Install to Retail only
#   ./install.sh classic             # Install to Classic Era only
#   ./install.sh tbc                 # Install to Classic (_classic_)
#   ./install.sh mop                 # Install to Classic (_classic_)
#   ./install.sh /path/to/AddOns     # Explicit path

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADDON_SRC="$SCRIPT_DIR/addon/WoWAgent"

# Map short names to folder names
version_to_folder() {
    case "$1" in
        retail)           echo "_retail_" ;;
        tbc|tbc_anniversary|classic_tbc) echo "_anniversary_" ;;
        mop|mop_classic)  echo "_classic_" ;;
        classic|classic_era) echo "_classic_era_" ;;
        *)                echo "" ;;
    esac
}

install_to() {
    local addons_dir="$1"
    local target="$addons_dir/WoWAgent"

    mkdir -p "$addons_dir"

    if [ -L "$target" ]; then
        rm "$target"
        echo "  Removed existing symlink."
    elif [ -d "$target" ]; then
        echo "  Warning: $target exists as a directory (not a symlink)."
        echo "  Remove it manually if you want to use the symlink instead."
        return 1
    fi

    ln -s "$ADDON_SRC" "$target"
    echo "  Symlinked: $target -> $ADDON_SRC"
}

# Collect WoW base paths per platform
find_wow_bases() {
    if [ "$(uname)" = "Darwin" ]; then
        for base in \
            "$HOME/Applications/World of Warcraft" \
            "/Applications/World of Warcraft"; do
            [ -d "$base" ] && echo "$base"
        done
    else
        for base in \
            "/mnt/c/Program Files (x86)/World of Warcraft" \
            "/c/Program Files (x86)/World of Warcraft" \
            "/mnt/c/Program Files/World of Warcraft" \
            "/c/Program Files/World of Warcraft"; do
            [ -d "$base" ] && echo "$base"
        done
    fi
}

# If an explicit path is provided (starts with / or contains a path separator)
if [ -n "$1" ] && [[ "$1" == /* || "$1" == */* ]]; then
    echo "Installing WoWAgent addon to: $1"
    install_to "$1"
    echo "Done!"
    exit 0
fi

# If a version keyword is given, restrict to that folder
FILTER_FOLDER=""
if [ -n "$1" ]; then
    FILTER_FOLDER=$(version_to_folder "$1")
    if [ -z "$FILTER_FOLDER" ]; then
        echo "Unknown version: $1"
        echo "Supported: retail, tbc, mop, classic"
        echo "Or provide an explicit AddOns path."
        exit 1
    fi
fi

ALL_FOLDERS="_retail_ _classic_ _classic_era_ _anniversary_"
if [ -n "$FILTER_FOLDER" ]; then
    ALL_FOLDERS="$FILTER_FOLDER"
fi

installed=0

while IFS= read -r base; do
    for folder in $ALL_FOLDERS; do
        interface_dir="$base/$folder/Interface"
        if [ -d "$interface_dir" ] || [ -d "$base/$folder" ]; then
            addons_dir="$base/$folder/Interface/AddOns"
            echo "Found: $base/$folder"
            if install_to "$addons_dir"; then
                installed=$((installed + 1))
            fi
        fi
    done
done < <(find_wow_bases)

if [ "$installed" -eq 0 ]; then
    echo "Error: Could not find any WoW installation."
    echo ""
    echo "Usage:"
    echo "  $0                        # Auto-detect"
    echo "  $0 retail                 # Retail only"
    echo "  $0 tbc                    # TBC Classic Anniversary"
    echo "  $0 mop                    # MoP Classic"
    echo "  $0 classic                # Classic Era"
    echo "  $0 /path/to/Interface/AddOns  # Explicit path"
    exit 1
fi

echo ""
echo "WoWAgent addon installed to $installed location(s)."
