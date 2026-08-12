# FUSE Dependencies for Linux Distributions

This folder contains FUSE library packages that will be bundled with the installer for offline installation support.

## Required Files

### Ubuntu/Debian (.deb)

Download from: https://packages.ubuntu.com/search?keywords=libfuse2

```bash
# For Ubuntu 22.04 (Jammy)
wget http://archive.ubuntu.com/ubuntu/pool/main/f/fuse/libfuse2_2.9.9-5ubuntu3_amd64.deb

# For Ubuntu 20.04 (Focal)
wget http://archive.ubuntu.com/ubuntu/pool/main/f/fuse/libfuse2_2.9.9-4_amd64.deb
```

Place the downloaded `.deb` file in this directory as:

- `libfuse2_amd64.deb` (will work across Ubuntu versions)

### RedHat/Fedora/CentOS (.rpm)

Download from: https://rpmfind.net/linux/rpm2html/search.php?query=fuse-libs

```bash
# For RHEL/CentOS 8/9
wget https://download.fedoraproject.org/pub/epel/8/Everything/x86_64/Packages/f/fuse-libs-2.9.9-15.el8.x86_64.rpm

# For Fedora
wget https://download.fedoraproject.org/pub/fedora/linux/releases/39/Everything/x86_64/os/Packages/f/fuse-libs-2.9.9-16.fc39.x86_64.rpm
```

Place the downloaded `.rpm` file in this directory as:

- `fuse-libs_x86_64.rpm` (will work across RHEL/Fedora versions)

## Current Files

- `README.md` - This file
- `libfuse2_amd64.deb` - **REQUIRED** - Ubuntu/Debian FUSE package
- `fuse-libs_x86_64.rpm` - **REQUIRED** - RedHat/Fedora FUSE package

## Build Process

The `build-installer.js` script will:

1. Check if these files exist
2. Copy them to `installer_gui/dependencies/`
3. Include them in the ASAR unpack list
4. Bundle them with the distributable

During installation, the `electron.js` will:

1. Detect Linux distribution
2. Attempt to install FUSE from bundled package
3. Fall back to extract-and-run mode if installation fails

## File Size Reference

- libfuse2: ~150KB
- fuse-libs: ~100KB
  Total: ~250KB added to installer size

## Testing

Test with bundled packages:

```bash
# Build installer with dependencies
cd ../../scripts
node build-installer.js

# Check if dependencies are bundled
cd ../installer_gui
ls -lh dependencies/

# Test installation (will use bundled FUSE)
sudo dpkg -i out/make/deb/x64/breakeveninstaller_1.0.0_amd64.deb
```

Test without bundled packages (fallback mode):

```bash
# Remove bundled dependencies
rm installer_gui/dependencies/*

# Rebuild
npm run make

# Test installation (will use extract-and-run mode)
sudo dpkg -i out/make/deb/x64/breakeveninstaller_1.0.0_amd64.deb
```

## Notes

- ✅ FUSE bundling is **optional** - installer works without it
- ✅ If packages missing, build will warn but continue
- ✅ Services automatically fall back to extract-and-run mode if FUSE unavailable
- ⚠️ Download packages manually before building for offline installation support
- 💡 Package manager dependencies (in package.json) will still try online installation first
