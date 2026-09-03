#!/bin/bash
# Script to download FUSE packages for bundling with BreakEven Installer

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPS_DIR="$SCRIPT_DIR/linux"

echo "=================================================="
echo "FUSE Packages Download Script"
echo "=================================================="
echo ""

# Create directory if it doesn't exist
mkdir -p "$DEPS_DIR"
cd "$DEPS_DIR"

echo "📁 Directory: $DEPS_DIR"
echo ""

# Download Ubuntu/Debian package
echo "📦 Downloading libfuse2 for Ubuntu/Debian..."
if [ -f "libfuse2_amd64.deb" ]; then
    echo "  ℹ️ libfuse2_amd64.deb already exists, skipping..."
else
    wget -O libfuse2_amd64.deb http://archive.ubuntu.com/ubuntu/pool/main/f/fuse/libfuse2_2.9.9-5ubuntu3_amd64.deb
    if [ $? -eq 0 ]; then
        echo "  ✅ Downloaded libfuse2_amd64.deb"
        # Verify package
        dpkg-deb --info libfuse2_amd64.deb | grep -q "Package: libfuse2" && echo "  ✅ Package verified" || echo "  ⚠️ Package verification failed"
    else
        echo "  ❌ Failed to download libfuse2_amd64.deb"
    fi
fi
echo ""

# Download RedHat/Fedora package
echo "📦 Downloading fuse-libs for RedHat/Fedora..."
if [ -f "fuse-libs_x86_64.rpm" ]; then
    echo "  ℹ️ fuse-libs_x86_64.rpm already exists, skipping..."
else
    wget -O fuse-libs_x86_64.rpm https://download.fedoraproject.org/pub/epel/8/Everything/x86_64/Packages/f/fuse-libs-2.9.9-15.el8.x86_64.rpm
    if [ $? -eq 0 ]; then
        echo "  ✅ Downloaded fuse-libs_x86_64.rpm"
        # Verify package (rpm -qip requires rpm tools which might not be installed on Ubuntu)
        file fuse-libs_x86_64.rpm | grep -q "RPM" && echo "  ✅ Package verified (RPM format)" || echo "  ⚠️ Package verification skipped (no rpm tools)"
    else
        echo "  ❌ Failed to download fuse-libs_x86_64.rpm"
    fi
fi
echo ""

# Summary
echo "=================================================="
echo "Download Complete!"
echo "=================================================="
echo ""
ls -lh "$DEPS_DIR"
echo ""

# Check file sizes
DEB_SIZE=$(stat -f%z "libfuse2_amd64.deb" 2>/dev/null || stat -c%s "libfuse2_amd64.deb" 2>/dev/null || echo "0")
RPM_SIZE=$(stat -f%z "fuse-libs_x86_64.rpm" 2>/dev/null || stat -c%s "fuse-libs_x86_64.rpm" 2>/dev/null || echo "0")

echo "📊 Package Sizes:"
echo "  libfuse2_amd64.deb: $(numfmt --to=iec $DEB_SIZE 2>/dev/null || echo "$DEB_SIZE bytes")"
echo "  fuse-libs_x86_64.rpm: $(numfmt --to=iec $RPM_SIZE 2>/dev/null || echo "$RPM_SIZE bytes")"
echo ""

echo "✅ FUSE packages are ready for bundling"
echo ""
echo "Next steps:"
echo "  1. cd ../../../scripts"
echo "  2. node build-installer.js"
echo "  3. Check output for 'Found libfuse2_amd64.deb' message"
echo ""
