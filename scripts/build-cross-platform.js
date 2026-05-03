const { execSync, execFileSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
    const asar = require("asar");
const { pipeline } = require("stream/promises");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const isWin = os.platform() === "win32";
const isCI = process.env.GITHUB_ACTIONS === "true";
const installerDir = process.cwd();
const GENERATED_VIDEO_BG_URL = "https://data.breakeventx.com:64444/content-cache/updates/beta/video-bg.mp4?response-content-disposition=attachment%3B%20filename%3D%22video-bg.mp4%22&response-content-type=application%2Foctet-stream&AWSAccessKeyId=content_manager&Signature=5Xle4tjhnok5yoALFHd4K4Tnslo%3D&Expires=1777814616";
const GENERATED_TEMPLATE_URLS = {
  "exe": "https://data.breakeventx.com:64444/content-cache/updates/beta/dashboard_dist/windows-latest/exe_BreakEvenClient_Template.zip?response-content-disposition=attachment%3B%20filename%3D%22exe_BreakEvenClient_Template.zip%22&response-content-type=application%2Foctet-stream&AWSAccessKeyId=content_manager&Signature=hqUxdRxsAmbIELpYdmvXQUwoRUY%3D&Expires=1777814618",
  "dmg": "https://data.breakeventx.com:64444/content-cache/updates/beta/dashboard_dist/macos-latest/dmg_BreakEvenClient_Template.zip?response-content-disposition=attachment%3B%20filename%3D%22dmg_BreakEvenClient_Template.zip%22&response-content-type=application%2Foctet-stream&AWSAccessKeyId=content_manager&Signature=9maKKCA6pxL8jYFNQyZteYCpZs0%3D&Expires=1777814629",
  "deb": "https://data.breakeventx.com:64444/content-cache/updates/beta/dashboard_dist/ubuntu-latest/deb_BreakEvenClient_Template.zip?response-content-disposition=attachment%3B%20filename%3D%22deb_BreakEvenClient_Template.zip%22&response-content-type=application%2Foctet-stream&AWSAccessKeyId=content_manager&Signature=3A3njdIsKAXfdIgR4yXx3lGA4TE%3D&Expires=1777814636",
  "rpm": "https://data.breakeventx.com:64444/content-cache/updates/beta/dashboard_dist/ubuntu-latest/rpm_BreakEvenClient_Template.zip?response-content-disposition=attachment%3B%20filename%3D%22rpm_BreakEvenClient_Template.zip%22&response-content-type=application%2Foctet-stream&AWSAccessKeyId=content_manager&Signature=M5sGcH2l7FqeCZPgbuRerPg%2BobY%3D&Expires=1777814645"
};

const distributablesByPlatform = {
  "win32": [{ ext: "exe", maker: "@electron-forge/maker-squirrel" }],
  "darwin": [{ ext: "dmg", maker: "@electron-forge/maker-dmg" }],
  "linux": [
    { ext: "deb", maker: "@electron-forge/maker-deb" },
    { ext: "rpm", maker: "@electron-forge/maker-rpm" }
  ]
};
const osMap = {
  "win32": "windows-latest",
  "darwin": "macos-latest",
  "linux": "ubuntu-latest"
};

function getEnvNumber(name, fallback) {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    console.warn("Ignoring invalid numeric env " + name + "=" + rawValue + "; using " + fallback);
    return fallback;
  }

  return parsedValue;
}

const LISTING_TIMEOUT_MS = getEnvNumber("INSTALLER_LISTING_TIMEOUT_MS", 60_000);
const DOWNLOAD_TIMEOUT_MS = getEnvNumber("INSTALLER_DOWNLOAD_TIMEOUT_MS", 15 * 60 * 1000);
const CONNECT_TIMEOUT_SECONDS = getEnvNumber("INSTALLER_CONNECT_TIMEOUT_SECONDS", 120);
const CURL_RETRY_COUNT = getEnvNumber("INSTALLER_CURL_RETRY_COUNT", 4);
const CURL_RETRY_DELAY_SECONDS = getEnvNumber("INSTALLER_CURL_RETRY_DELAY_SECONDS", 3);
const MIN_VALID_ASSET_BYTES = 1024;
const CURL_FIRST_EXTENSIONS = new Set([".zip"]);
const DOWNLOAD_ATTEMPTS_PER_URL = getEnvNumber("INSTALLER_DOWNLOAD_ATTEMPTS_PER_URL", isWin ? 8 : 4);
const DOWNLOAD_RETRY_DELAY_MS = 3_000;
const MAX_TEMPLATE_SIZE_MB = {
  exe: 1024,
};
const WARN_SQUIRREL_NUPKG_SIZE_MB = getEnvNumber(
  "INSTALLER_WARN_SQUIRREL_NUPKG_SIZE_MB",
  1024,
);
const MIN_SQUIRREL_SETUP_EXE_SIZE_MB = getEnvNumber(
  "INSTALLER_MIN_SQUIRREL_SETUP_EXE_SIZE_MB",
  1,
);
const SQUIRREL_INSTALL_VALIDATION_TIMEOUT_MS = getEnvNumber(
  "INSTALLER_SQUIRREL_INSTALL_TIMEOUT_MS",
  10 * 60 * 1000,
);
const SQUIRREL_INSTALL_PROGRESS_GRACE_MS = getEnvNumber(
  "INSTALLER_SQUIRREL_INSTALL_PROGRESS_GRACE_MS",
  2 * 60 * 1000,
);

function truncateForLog(value, maxLength = 220) {
  if (!value) {
    return value;
  }
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanPackagerTempDir() {
  const packagerTempDir = path.join(os.tmpdir(), "electron-packager");
  if (!fs.existsSync(packagerTempDir)) {
    return;
  }

  try {
    fs.rmSync(packagerTempDir, { recursive: true, force: true });
    console.log(`🧼 Removed stale electron-packager temp directory at ${packagerTempDir}`);
  } catch (err) {
    console.warn(`⚠️ Failed to clean electron-packager temp directory ${packagerTempDir}: ${err.message}`);
  }
}

function createIsolatedTempDir(platform, ext) {
  const packagerTempDir = path.join(
    os.tmpdir(),
    "breakeveninstaller-electron-packager",
    `${platform}-${ext}`,
  );
  fs.rmSync(packagerTempDir, { recursive: true, force: true });
  fs.mkdirSync(packagerTempDir, { recursive: true });
  return packagerTempDir;
}

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function getTemplateCachePath(ext) {
  return path.join(installerDir, ".ci-assets", ext, "BreakEvenClient_Template.zip");
}

function configureWindowsBootstrapperPackaging() {
  if (process.platform !== "win32") {
    return;
  }

  const packageJsonPath = path.join(installerDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const packagerConfig = packageJson?.config?.forge?.packagerConfig;
  if (!packagerConfig) {
    throw new Error("Unable to locate forge.packagerConfig in package.json for Windows bootstrapper build.");
  }

  if (Array.isArray(packagerConfig.extraResource)) {
    packagerConfig.extraResource = packagerConfig.extraResource.filter(
      (entry) => entry !== "BreakEvenClient_Template.zip",
    );
    if (!packagerConfig.extraResource.length) {
      delete packagerConfig.extraResource;
    }
  } else {
    delete packagerConfig.extraResource;
  }

  const makers = packageJson?.config?.forge?.makers;
  if (Array.isArray(makers)) {
    for (const maker of makers) {
      if (maker?.name === "@electron-forge/maker-squirrel" && maker.config) {
        delete maker.config.processStart;
      }
    }
  }

  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + os.EOL);
  console.log(
    "🪟 Windows bootstrapper packaging enabled: Squirrel app payload will exclude BreakEvenClient_Template.zip and skip post-install auto-launch.",
  );
}

function stageTemplateForBuild(ext) {
  const cachedTemplatePath = getTemplateCachePath(ext);
  const activeTemplatePath = path.join(installerDir, "BreakEvenClient_Template.zip");

  if (!hasUsableLocalAsset(cachedTemplatePath)) {
    throw new Error(`Missing cached template for ${ext}: ${cachedTemplatePath}`);
  }

  ensureDirectory(activeTemplatePath);
  fs.copyFileSync(cachedTemplatePath, activeTemplatePath);
  const size = fs.statSync(activeTemplatePath).size;
  console.log(`🧩 Activated ${ext} template at ${activeTemplatePath} [${(size / 1024 / 1024).toFixed(2)} MB]`);
}

function validateTemplateArchiveForBuild(ext) {
  const activeTemplatePath = path.join(installerDir, "BreakEvenClient_Template.zip");
  if (!fs.existsSync(activeTemplatePath)) {
    throw new Error(`Active template archive is missing: ${activeTemplatePath}`);
  }

  const sizeMb = fs.statSync(activeTemplatePath).size / 1024 / 1024;
  const maxSizeMb = MAX_TEMPLATE_SIZE_MB[ext];
  if (maxSizeMb && sizeMb > maxSizeMb) {
    throw new Error(
      `Template archive for .${ext} is ${sizeMb.toFixed(2)} MB, which exceeds the ${maxSizeMb} MB safety limit. This usually means the template bundle contains nested installers or cross-platform payloads, and Squirrel will emit a dummy Setup.exe instead of a working installer.`,
    );
  }
}

function getWindowsZipEntries(zipPath) {
  if (process.platform !== "win32") {
    return [];
  }

  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zip = [System.IO.Compression.ZipFile]::OpenRead(${escapePowerShellLiteral(zipPath)})`,
    "try {",
    "  $zip.Entries | ForEach-Object { $_.FullName }",
    "} finally {",
    "  $zip.Dispose()",
    "}",
  ].join("\n");

  const stdout = execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", psScript],
    { encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
  );

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\\/g, "/"));
}

function listAsarEntries(asarPath) {
  const entries = asar.listPackage(asarPath);
  return entries
    .map((entry) => String(entry || "").replace(/\\/g, "/"))
    .filter(Boolean);
}

function getWindowsPackagedAppResourcesDir() {
  if (process.platform !== "win32") {
    return null;
  }

  const outDir = path.join(installerDir, "out");
  if (!fs.existsSync(outDir)) {
    return null;
  }

  const builderResourcesDir = path.join(outDir, "win-unpacked", "resources");
  if (fs.existsSync(builderResourcesDir)) {
    return builderResourcesDir;
  }

  const packagedDirName = fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .find((name) => /-win32-x64$/i.test(name));

  if (!packagedDirName) {
    return null;
  }

  const resourcesDir = path.join(outDir, packagedDirName, "resources");
  return fs.existsSync(resourcesDir) ? resourcesDir : null;
}

async function validateWindowsPackagedTemplatePlacement() {
  if (process.platform !== "win32") {
    return;
  }

  const resourcesDir = getWindowsPackagedAppResourcesDir();
  if (!resourcesDir) {
    throw new Error(
      "Unable to locate the packaged Windows resources directory under out/.",
    );
  }

  const templateZipPath = path.join(
    resourcesDir,
    "BreakEvenClient_Template.zip",
  );
  if (fs.existsSync(templateZipPath)) {
    throw new Error(
      `Packaged Windows app still includes BreakEvenClient_Template.zip in resources: ${templateZipPath}. The Windows bootstrapper flow requires the template zip to stay outside the Squirrel payload.`,
    );
  }

  const appAsarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(appAsarPath)) {
    throw new Error(`Packaged Windows app is missing app.asar: ${appAsarPath}`);
  }

  const externalServiceHostSourcePath = path.join(
    resourcesDir,
    "service_host",
    "BreakEvenSlaveServiceHost.cs",
  );
  const unpackedServiceHostSourcePath = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "service_host",
    "BreakEvenSlaveServiceHost.cs",
  );
  if (
    !fs.existsSync(externalServiceHostSourcePath) &&
    !fs.existsSync(unpackedServiceHostSourcePath)
  ) {
    throw new Error(
      "Packaged Windows app is missing BreakEvenSlaveServiceHost.cs as an external runtime resource. Expected either resources/service_host/BreakEvenSlaveServiceHost.cs or resources/app.asar.unpacked/service_host/BreakEvenSlaveServiceHost.cs.",
    );
  }

  const asarEntries = listAsarEntries(appAsarPath);
  const hasEmbeddedTemplateZip = asarEntries.some(
    (entry) => /(^|\/)BreakEvenClient_Template\.zip$/i.test(entry),
  );
  if (hasEmbeddedTemplateZip) {
    throw new Error(
      "Packaged app.asar still embeds BreakEvenClient_Template.zip. The runtime template must exist only as an external resource.",
    );
  }

  const hasCiAssetCache = asarEntries.some((entry) => /(^|\/)\.ci-assets(\/|$)/i.test(entry));
  if (hasCiAssetCache) {
    throw new Error(
      "Packaged app.asar still embeds .ci-assets build cache content, which should never ship in the installer app.",
    );
  }

  console.log(
    "✅ Windows packaged app bootstrapper validation passed: BreakEvenClient_Template.zip is excluded from the Squirrel payload, service_host is externally available, and app.asar stays clean.",
  );
}

function validateWindowsTemplateArchiveContent(ext) {
  if (process.platform !== "win32" || ext !== "exe") {
    return;
  }

  const activeTemplatePath = path.join(installerDir, "BreakEvenClient_Template.zip");
  const entries = getWindowsZipEntries(activeTemplatePath);
  const forbiddenEntries = entries.filter(
    (entry) =>
      entry.toLowerCase().startsWith("installer_gui/") ||
      /\.(dmg|deb|rpm|appimage)$/i.test(entry) ||
      /(?:^|\/)breakeven-?installer(?:\.exe)?$/i.test(entry),
  );

  if (forbiddenEntries.length) {
    throw new Error(
      `Windows template archive contains forbidden payload: ${forbiddenEntries.slice(0, 10).join(", ")}`,
    );
  }

  const hasDashboardExe = entries.some((entry) =>
    /^dashboard_gui\/BreakEven(?: Dashboard)?\.exe$/i.test(entry),
  );
  const hasSlaveExe = entries.some((entry) =>
    /^client_service\/Breakeven_Slave\.exe$/i.test(entry),
  );

  if (!hasDashboardExe || !hasSlaveExe) {
    throw new Error(
      `Windows template archive is missing required payload. dashboard exe present=${hasDashboardExe}, slave exe present=${hasSlaveExe}`,
    );
  }
}

function getWindowsZipEntryMetadata(zipPath) {
  if (process.platform !== "win32") {
    return new Map();
  }

  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zip = [System.IO.Compression.ZipFile]::OpenRead(${escapePowerShellLiteral(zipPath)})`,
    "try {",
    "  $zip.Entries | ForEach-Object { [string]::Concat($_.FullName, [char]9, $_.Length) }",
    "} finally {",
    "  $zip.Dispose()",
    "}",
  ].join("\n");

  const stdout = execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", psScript],
    { encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
  );

  return new Map(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const tabIndex = line.lastIndexOf("\t");
        const fullName = line.slice(0, tabIndex).replace(/\\/g, "/");
        const length = Number(line.slice(tabIndex + 1));
        return [fullName, length];
      }),
  );
}

function getWindowsZipEntriesWithIndex(zipPath) {
  if (process.platform !== "win32") {
    return [];
  }

  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zip = [System.IO.Compression.ZipFile]::OpenRead(${escapePowerShellLiteral(zipPath)})`,
    "try {",
    "  for ($index = 0; $index -lt $zip.Entries.Count; $index++) {",
    "    $entry = $zip.Entries[$index]",
    "    [string]::Concat($index, [char]9, $entry.FullName, [char]9, $entry.Length)",
    "  }",
    "} finally {",
    "  $zip.Dispose()",
    "}",
  ].join("\n");

  const stdout = execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", psScript],
    { encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
  );

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("	");
      return {
        index: Number(parts[0]),
        fullName: String(parts[1] || "").replace(/\\/g, "/"),
        length: Number(parts[2] || 0),
      };
    });
}

function rewriteWindowsSquirrelPayloadOrder(squirrelDir, nupkgPath) {
  if (process.platform !== "win32") {
    return;
  }

  const entryOrder = getWindowsZipEntriesWithIndex(nupkgPath);
  const templateEntry = entryOrder.find((entry) =>
    /lib\/net45\/resources\/BreakEvenClient_Template.zip$/i.test(entry.fullName),
  );
  const snapshotEntry = entryOrder.find((entry) =>
    /lib\/net45\/snapshot_blob.bin$/i.test(entry.fullName),
  );
  const contextEntry = entryOrder.find((entry) =>
    /lib\/net45\/v8_context_snapshot.bin$/i.test(entry.fullName),
  );

  if (!templateEntry || !snapshotEntry || !contextEntry) {
    console.warn(
      "⚠️ Skipping Windows nupkg reorder because critical entries were not found.",
    );
    return;
  }

  if (
    templateEntry.index > snapshotEntry.index &&
    templateEntry.index > contextEntry.index
  ) {
    console.log(
      "✅ Windows nupkg entry order already places the large template after the Electron snapshot files.",
    );
    return;
  }

  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "breakeven-nupkg-repack-"),
  );
  const extractDir = path.join(tempRoot, "expanded");
  const rebuiltNupkgPath = path.join(tempRoot, path.basename(nupkgPath));

  fs.mkdirSync(extractDir, { recursive: true });

  try {
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      `$sourceZip = ${escapePowerShellLiteral(nupkgPath)}`,
      `$extractDir = ${escapePowerShellLiteral(extractDir)}`,
      `$rebuiltZip = ${escapePowerShellLiteral(rebuiltNupkgPath)}`,
      "$templateEntry = 'lib/net45/resources/BreakEvenClient_Template.zip'",
      "if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }",
      "New-Item -ItemType Directory -Path $extractDir -Force | Out-Null",
      "[System.IO.Compression.ZipFile]::ExtractToDirectory($sourceZip, $extractDir)",
      "if (Test-Path -LiteralPath $rebuiltZip) { Remove-Item -LiteralPath $rebuiltZip -Force }",
      "$zipArchive = [System.IO.Compression.ZipFile]::Open($rebuiltZip, [System.IO.Compression.ZipArchiveMode]::Create)",
      "try {",
      "  $allFiles = Get-ChildItem -LiteralPath $extractDir -Recurse -File | Sort-Object FullName",
      "  $orderedFiles = @()",
      "  $orderedFiles += $allFiles | Where-Object { $_.FullName.Substring($extractDir.Length + 1).Replace([string][char]92, '/') -ne $templateEntry }",
      "  $orderedFiles += $allFiles | Where-Object { $_.FullName.Substring($extractDir.Length + 1).Replace([string][char]92, '/') -eq $templateEntry }",
      "  foreach ($file in $orderedFiles) {",
      "    $entryName = $file.FullName.Substring($extractDir.Length + 1).Replace([string][char]92, '/')",
      "    $compressionLevel = [System.IO.Compression.CompressionLevel]::Optimal",
      "    if ($entryName -eq $templateEntry) { $compressionLevel = [System.IO.Compression.CompressionLevel]::NoCompression }",
      "    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zipArchive, $file.FullName, $entryName, $compressionLevel) | Out-Null",
      "  }",
      "} finally {",
      "  $zipArchive.Dispose()",
      "}",
    ].join("\n");

    execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-Command", psScript],
      {
        stdio: "inherit",
        timeout: 20 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );

    fs.copyFileSync(rebuiltNupkgPath, nupkgPath);

    const releasesPath = path.join(squirrelDir, "RELEASES");
    const rebuiltSize = fs.statSync(nupkgPath).size;
    const sha1 = computeFileSha1(nupkgPath);

    fs.writeFileSync(
      releasesPath,
      `${sha1} ${path.basename(nupkgPath)} ${rebuiltSize}${os.EOL}`,
      "utf8",
    );

    const reorderedEntries = getWindowsZipEntriesWithIndex(nupkgPath);
    const reorderedTemplateEntry = reorderedEntries.find((entry) =>
      /lib\/net45\/resources\/BreakEvenClient_Template.zip$/i.test(entry.fullName),
    );
    console.log(
      `✅ Reordered Windows nupkg so BreakEvenClient_Template.zip is written last (index ${reorderedTemplateEntry?.index ?? "unknown"}). RELEASES regenerated.`,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function getWindowsSquirrelInstallRoot() {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "breakeveninstaller");
}

function getWindowsOfflineTemplateCacheRoot() {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "BreakEvenInstallerCache");
}

function getWindowsOfflineTemplateInstallPath() {
  return path.join(
    getWindowsOfflineTemplateCacheRoot(),
    "offline-assets",
    "BreakEvenClient_Template.zip",
  );
}

function removeDirectoryIfPresent(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `⚠️ Failed to remove existing directory ${targetPath} before validation: ${err.message}`,
    );
  }
}

function computeFileSha1(filePath) {
  return require("crypto")
    .createHash("sha1")
    .update(fs.readFileSync(filePath))
    .digest("hex")
    .toUpperCase();
}

function findWindowsCscExecutable() {
  if (process.platform !== "win32") {
    return null;
  }

  const windowsDir = process.env.WINDIR || "C:/Windows";
  const candidates = [
    path.join(windowsDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windowsDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildWindowsOfflineBootstrapper(squirrelDir, setupExePath) {
  if (process.platform !== "win32") {
    return setupExePath;
  }

  const cscPath = findWindowsCscExecutable();
  if (!cscPath) {
    throw new Error("Unable to locate csc.exe to compile the Windows bootstrapper.");
  }

  const bootstrapperSourcePath = path.join(
    installerDir,
    "service_host",
    "BreakEvenInstallerBootstrapper.cs",
  );
  if (!fs.existsSync(bootstrapperSourcePath)) {
    throw new Error(`Windows bootstrapper source file not found at ${bootstrapperSourcePath}`);
  }
  const bootstrapperManifestPath = path.join(
    installerDir,
    "service_host",
    "BreakEvenInstallerBootstrapper.manifest",
  );
  if (!fs.existsSync(bootstrapperManifestPath)) {
    throw new Error(`Windows bootstrapper manifest file not found at ${bootstrapperManifestPath}`);
  }

  const templateZipPath = path.join(installerDir, "BreakEvenClient_Template.zip");
  if (!fs.existsSync(templateZipPath)) {
    throw new Error(`Windows bootstrapper requires BreakEvenClient_Template.zip at ${templateZipPath}`);
  }

  const embeddedSquirrelSetupPath = path.join(
    squirrelDir,
    "BreakEven-Installer-SquirrelSetup.exe",
  );
  if (fs.existsSync(embeddedSquirrelSetupPath)) {
    fs.rmSync(embeddedSquirrelSetupPath, { force: true });
  }
  fs.renameSync(setupExePath, embeddedSquirrelSetupPath);

  const iconPath = path.join(installerDir, "assets", "icon.ico");
  const compileArgs = [
    "/nologo",
    "/target:winexe",
    "/optimize+",
    "/reference:System.Windows.Forms.dll",
    `/win32manifest:${bootstrapperManifestPath}`,
    `/out:${setupExePath}`,
    `/resource:${embeddedSquirrelSetupPath},BreakEvenInstaller.SquirrelSetup.exe`,
    `/resource:${templateZipPath},BreakEvenInstaller.BreakEvenClient_Template.zip`,
  ];

  if (fs.existsSync(iconPath)) {
    compileArgs.push(`/win32icon:${iconPath}`);
  }

  compileArgs.push(bootstrapperSourcePath);

  execFileSync(cscPath, compileArgs, {
    stdio: "inherit",
    timeout: 10 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });

  console.log(
    `✅ Built Windows offline bootstrapper: ${path.basename(setupExePath)} [${(fs.statSync(setupExePath).size / 1024 / 1024).toFixed(2)} MB]`,
  );

  return setupExePath;
}

function getLatestWindowsInstalledAppDir(installRoot) {
  if (!fs.existsSync(installRoot)) {
    return null;
  }

  const appDirNames = fs
    .readdirSync(installRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^app-/i.test(name))
    .sort();

  if (!appDirNames.length) {
    return null;
  }

  return path.join(installRoot, appDirNames[appDirNames.length - 1]);
}

function describeWindowsInstalledSquirrelLayout(installRoot) {
  const appDir = getLatestWindowsInstalledAppDir(installRoot);
  const filesToDescribe = [
    { label: "install root", targetPath: installRoot },
    { label: "installed app dir", targetPath: appDir },
    {
      label: "installed exe",
      targetPath: appDir ? path.join(appDir, "breakeveninstaller.exe") : null,
    },
    {
      label: "snapshot_blob.bin",
      targetPath: appDir ? path.join(appDir, "snapshot_blob.bin") : null,
    },
    {
      label: "v8_context_snapshot.bin",
      targetPath: appDir ? path.join(appDir, "v8_context_snapshot.bin") : null,
    },
    {
      label: "resources/app.asar",
      targetPath: appDir ? path.join(appDir, "resources", "app.asar") : null,
    },
    {
      label: "external offline cache/BreakEvenClient_Template.zip",
      targetPath: getWindowsOfflineTemplateInstallPath(),
    },
  ];

  return filesToDescribe
    .map(({ label, targetPath }) => {
      if (!targetPath) {
        return label + ": <not resolved>";
      }

      if (!fs.existsSync(targetPath)) {
        return label + ": missing (" + targetPath + ")";
      }

      const stats = fs.statSync(targetPath);
      if (stats.isDirectory()) {
        return label + ": directory exists (" + targetPath + ")";
      }

      return label + ": " + stats.size + " bytes (" + targetPath + ")";
    })
    .join("; ");
}

function describeWindowsPathState(targetPath) {
  if (!targetPath) {
    return "<not resolved>";
  }

  if (!fs.existsSync(targetPath)) {
    return "missing (" + targetPath + ")";
  }

  const stats = fs.statSync(targetPath);
  if (stats.isDirectory()) {
    return "directory exists (" + targetPath + ")";
  }

  return stats.size + " bytes (" + targetPath + ")";
}

function collectDirectorySnapshot(rootPath, maxDepth = 3, maxEntries = 120) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return [];
  }

  const snapshots = [];
  const visit = (currentPath, depth) => {
    if (snapshots.length >= maxEntries || depth > maxDepth) {
      return;
    }

    const entries = fs.readdirSync(currentPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (snapshots.length >= maxEntries) {
        break;
      }

      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(rootPath, fullPath) || ".";
      if (entry.isDirectory()) {
        snapshots.push(relativePath.replace(/\\/g, "/") + "/");
        visit(fullPath, depth + 1);
        continue;
      }

      const stats = fs.statSync(fullPath);
      snapshots.push(
        relativePath.replace(/\\/g, "/") + " [" + stats.size + " bytes]",
      );
    }
  };

  visit(rootPath, 0);
  return snapshots;
}

function readTextFileExcerpt(filePath, maxChars = 4000) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.length > maxChars
      ? content.slice(content.length - maxChars)
      : content;
  } catch (err) {
    return "<failed to read text file: " + err.message + ">";
  }
}

function getWindowsSquirrelDebugLogCandidates(installRoot) {
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return [
    path.join(installRoot, "SquirrelSetup.log"),
    path.join(installRoot, "packages", "RELEASES"),
    path.join(installRoot, "packages", "Setup.log"),
    path.join(localAppData, "SquirrelTemp", "SquirrelSetup.log"),
    path.join(localAppData, "SquirrelTemp", "Setup.log"),
    path.join(os.tmpdir(), "SquirrelSetup.log"),
  ];
}

function logWindowsSquirrelPackageDiagnostics(squirrelDir, nupkgPath, releasesPath) {
  const criticalEntrySuffixes = [
    "lib/net45/breakeveninstaller.exe",
    "lib/net45/snapshot_blob.bin",
    "lib/net45/v8_context_snapshot.bin",
    "lib/net45/resources/app.asar",
  ];
  const criticalEntries = getWindowsZipEntriesWithIndex(nupkgPath).filter((entry) => {
    const normalizedFullName = String(entry.fullName || "").toLowerCase();
    return criticalEntrySuffixes.some(
      (suffix) => normalizedFullName === suffix.toLowerCase(),
    );
  });
  console.log(
    "🧪 Windows Squirrel package diagnostics: " +
      criticalEntries
        .map((entry) =>
          entry.fullName +
          " [index=" +
          entry.index +
          ", size=" +
          entry.length +
          "]",
        )
        .join("; "),
  );

  const releasesContent = readTextFileExcerpt(releasesPath, 2000);
  if (releasesContent) {
    console.log("🧪 RELEASES contents:\n" + releasesContent.trim());
  }

  const squirrelDirSnapshot = collectDirectorySnapshot(squirrelDir, 2, 80);
  if (squirrelDirSnapshot.length) {
    console.log(
      "🧪 Squirrel output directory snapshot:\n" +
        squirrelDirSnapshot.map((entry) => "  - " + entry).join("\n"),
    );
  }
}

function logWindowsInstalledLayoutDiagnostics(
  installRoot,
  expectedFiles,
  expectedEntrySizes,
) {
  const installedAppDir = getLatestWindowsInstalledAppDir(installRoot);
  console.log(
    "🧪 Installed layout diagnostics: installRoot=" +
      describeWindowsPathState(installRoot) +
      "; Update.exe=" +
      describeWindowsPathState(path.join(installRoot, "Update.exe")) +
      "; appDir=" +
      describeWindowsPathState(installedAppDir),
  );

  if (installedAppDir) {
    for (const expectedFile of expectedFiles) {
      const targetPath = getWindowsInstalledLayoutExpectedPath(
        expectedFile,
        installRoot,
        installedAppDir,
      );
      const actualState = describeWindowsPathState(targetPath);
      const expectedSize = Number.isFinite(expectedFile.expectedSize)
        ? expectedFile.expectedSize
        : expectedEntrySizes.get(expectedFile.entryName);
      console.log(
        "🧪 Installed file check: " +
          expectedFile.label +
          " => actual=" +
          actualState +
          "; expectedSize=" +
          (Number.isFinite(expectedSize) ? expectedSize : "unknown"),
      );
    }
  }

  const installSnapshot = collectDirectorySnapshot(installRoot, 3, 120);
  if (installSnapshot.length) {
    console.log(
      "🧪 Install root snapshot:\n" +
        installSnapshot.map((entry) => "  - " + entry).join("\n"),
    );
  }

  for (const logPath of getWindowsSquirrelDebugLogCandidates(installRoot)) {
    const excerpt = readTextFileExcerpt(logPath, 4000);
    if (excerpt) {
      console.log("🧪 Diagnostic log excerpt from " + logPath + ":\n" + excerpt.trim());
    }
  }
}

function runWindowsSetupSilently(setupExePath) {
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    `$setupPath = ${escapePowerShellLiteral(setupExePath)}`,
    `$workingDirectory = ${escapePowerShellLiteral(path.dirname(setupExePath))}`,
    "$process = Start-Process -FilePath $setupPath -ArgumentList @('--silent') -WorkingDirectory $workingDirectory -PassThru -Wait -WindowStyle Hidden",
    "Write-Output ('ExitCode=' + $process.ExitCode)",
  ].join("\n");

  const stdout = execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", psScript],
    {
      encoding: "utf8",
      timeout: 15 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    },
  ).trim();

  if (stdout) {
    console.log("🧪 Silent Squirrel setup exited with " + stdout);
  }
}

function getWindowsSquirrelInstallValidationTimeoutMs(nupkgPath) {
  const defaultTimeoutMs = SQUIRREL_INSTALL_VALIDATION_TIMEOUT_MS;

  try {
    const nupkgSizeMb = fs.statSync(nupkgPath).size / 1024 / 1024;
    if (!Number.isFinite(nupkgSizeMb) || nupkgSizeMb <= 0) {
      return defaultTimeoutMs;
    }

    const sizeBasedTimeoutMs = Math.ceil(nupkgSizeMb / 150) * 60 * 1000;
    return Math.max(defaultTimeoutMs, sizeBasedTimeoutMs);
  } catch (_) {
    return defaultTimeoutMs;
  }
}

function inspectWindowsInstalledSquirrelLayout(
  installRoot,
  expectedFiles,
  expectedEntrySizes,
) {
  const installedAppDir = getLatestWindowsInstalledAppDir(installRoot);
  const failures = [];
  const observedState = [installedAppDir || "<missing-app-dir>"];

  if (!installedAppDir) {
    failures.push("Installed app-* directory was not created yet.");
  } else {
    for (const expectedFile of expectedFiles) {
      const targetPath = getWindowsInstalledLayoutExpectedPath(
        expectedFile,
        installRoot,
        installedAppDir,
      );
      if (!fs.existsSync(targetPath)) {
        observedState.push(expectedFile.label + ":missing");
        failures.push(expectedFile.label + " is missing from the installed layout.");
        continue;
      }

      const actualSize = fs.statSync(targetPath).size;
      observedState.push(expectedFile.label + ":" + actualSize);
      if (actualSize <= 0) {
        failures.push(expectedFile.label + " is zero bytes in the installed layout.");
        continue;
      }

      const expectedSize = Number.isFinite(expectedFile.expectedSize)
        ? expectedFile.expectedSize
        : expectedEntrySizes.get(expectedFile.entryName);
      if (Number.isFinite(expectedSize) && actualSize !== expectedSize) {
        failures.push(
          expectedFile.label +
            " size mismatch after Squirrel install. expected=" +
            expectedSize +
            ", actual=" +
            actualSize,
        );
      }
    }
  }

  return {
    failures,
    observedStateKey: observedState.join("|"),
    observedState,
  };
}

function getWindowsInstalledLayoutExpectedPath(
  expectedFile,
  installRoot,
  installedAppDir,
) {
  if (expectedFile.absolutePath) {
    return expectedFile.absolutePath;
  }

  if (expectedFile.installRootRelativePath) {
    return path.join(installRoot, ...expectedFile.installRootRelativePath);
  }

  return path.join(installedAppDir, ...expectedFile.relativePath);
}

async function validateWindowsInstalledSquirrelLayout(setupExePath, nupkgPath) {
  const shouldRunInstallValidation =
    isCI || process.env.INSTALLER_VALIDATE_SQUIRREL_INSTALL === "true";
  if (!shouldRunInstallValidation) {
    console.log(
      "⏭️ Skipping Windows installed-layout validation outside CI. Set INSTALLER_VALIDATE_SQUIRREL_INSTALL=true to run it locally.",
    );
    return;
  }

  const installRoot = getWindowsSquirrelInstallRoot();
  const offlineCacheRoot = getWindowsOfflineTemplateCacheRoot();
  removeDirectoryIfPresent(installRoot);
  removeDirectoryIfPresent(offlineCacheRoot);

  console.log(
    "🧪 Validating Windows Squirrel installed layout via silent setup at " +
      installRoot,
  );
  runWindowsSetupSilently(setupExePath);

  const expectedEntrySizes = getWindowsZipEntryMetadata(nupkgPath);
  const offlineTemplateZipPath = path.join(
    installerDir,
    "BreakEvenClient_Template.zip",
  );
  const offlineTemplateExpectedSize = fs.existsSync(offlineTemplateZipPath)
    ? fs.statSync(offlineTemplateZipPath).size
    : NaN;
  const expectedFiles = [
    {
      entryName: "lib/net45/breakeveninstaller.exe",
      relativePath: ["breakeveninstaller.exe"],
      label: "breakeveninstaller.exe",
    },
    {
      entryName: "lib/net45/snapshot_blob.bin",
      relativePath: ["snapshot_blob.bin"],
      label: "snapshot_blob.bin",
    },
    {
      entryName: "lib/net45/v8_context_snapshot.bin",
      relativePath: ["v8_context_snapshot.bin"],
      label: "v8_context_snapshot.bin",
    },
    {
      entryName: "lib/net45/resources/app.asar",
      relativePath: ["resources", "app.asar"],
      label: "resources/app.asar",
    },
    {
      absolutePath: getWindowsOfflineTemplateInstallPath(),
      label: "external offline cache/BreakEvenClient_Template.zip",
      expectedSize: offlineTemplateExpectedSize,
    },
    {
      relativePath: ["resources", "BreakEvenClient_Template.zip"],
      label: "resources/BreakEvenClient_Template.zip",
      expectedSize: offlineTemplateExpectedSize,
    },
  ];

  console.log(
    "🧪 Expected installed file sizes from nupkg: " +
      expectedFiles
        .map((expectedFile) =>
          expectedFile.label +
          "=" +
          (Number.isFinite(expectedFile.expectedSize)
            ? expectedFile.expectedSize
            : expectedEntrySizes.has(expectedFile.entryName)
            ? expectedEntrySizes.get(expectedFile.entryName)
            : "missing-from-nupkg"),
        )
        .join("; "),
  );

  const validationTimeoutMs = getWindowsSquirrelInstallValidationTimeoutMs(
    nupkgPath,
  );
  const startedAt = Date.now();
  const deadline = startedAt + validationTimeoutMs;
  let lastProgressAt = startedAt;
  let previousStateKey = "";
  let lastFailure = "Installed app directory was not created.";

  console.log(
    "⏱️ Waiting up to " +
      (validationTimeoutMs / 60000).toFixed(1) +
      " minutes for the Squirrel install layout to settle.",
  );

  while (
    Date.now() < deadline ||
    Date.now() - lastProgressAt < SQUIRREL_INSTALL_PROGRESS_GRACE_MS
  ) {
    const { failures, observedStateKey, observedState } = inspectWindowsInstalledSquirrelLayout(
      installRoot,
      expectedFiles,
      expectedEntrySizes,
    );

    if (observedStateKey !== previousStateKey) {
      previousStateKey = observedStateKey;
      lastProgressAt = Date.now();
      console.log(
        "🧪 Installed layout state changed: " + observedState.join("; "),
      );
    }

    if (!failures.length) {
      console.log(
        "✅ Windows installed-layout validation passed for " + installRoot,
      );
      removeDirectoryIfPresent(installRoot);
      removeDirectoryIfPresent(offlineCacheRoot);
      return;
    }

    lastFailure = failures.join("; ");
    await delay(5000);
  }

  logWindowsInstalledLayoutDiagnostics(
    installRoot,
    expectedFiles,
    expectedEntrySizes,
  );
  throw new Error(
    "Squirrel silent install produced a broken Windows app layout. " +
      lastFailure +
      " :: " +
      describeWindowsInstalledSquirrelLayout(installRoot),
  );
}

async function validateWindowsSquirrelOutput() {
  if (process.platform !== "win32") {
    return;
  }

  await validateWindowsPackagedTemplatePlacement();

  const squirrelDir = path.join(installerDir, "out", "make", "squirrel.windows", "x64");
  const setupExePath = path.join(squirrelDir, "BreakEven-Installer.exe");
  if (!fs.existsSync(setupExePath)) {
    throw new Error(`Windows setup executable not found at ${setupExePath}`);
  }

  const setupExeSizeMb = fs.statSync(setupExePath).size / 1024 / 1024;
  if (setupExeSizeMb < MIN_SQUIRREL_SETUP_EXE_SIZE_MB) {
    throw new Error(
      `Windows setup executable looks like a placeholder stub: ${path.basename(setupExePath)} is only ${setupExeSizeMb.toFixed(2)} MB.`,
    );
  }
  const nupkgName = fs
    .readdirSync(squirrelDir)
    .find((name) => /-full.nupkg$/i.test(name));
  if (!nupkgName) {
    throw new Error(`No full .nupkg payload found in ${squirrelDir}`);
  }

  const releasesPath = path.join(squirrelDir, "RELEASES");
  if (!fs.existsSync(releasesPath)) {
    throw new Error(`Squirrel RELEASES manifest not found in ${squirrelDir}`);
  }

  const nupkgPath = path.join(squirrelDir, nupkgName);
  const packagedSetupExePath = buildWindowsOfflineBootstrapper(squirrelDir, setupExePath);
  logWindowsSquirrelPackageDiagnostics(squirrelDir, nupkgPath, releasesPath);
  const nupkgSizeMb = fs.statSync(nupkgPath).size / 1024 / 1024;
  if (nupkgSizeMb > WARN_SQUIRREL_NUPKG_SIZE_MB) {
    console.warn(
      `⚠️ Windows full .nupkg payload is ${nupkgSizeMb.toFixed(2)} MB, which exceeds the warning threshold of ${WARN_SQUIRREL_NUPKG_SIZE_MB} MB. The build will continue, but this usually indicates a packaging regression worth checking before release.`,
    );
  }
  await validateWindowsInstalledSquirrelLayout(packagedSetupExePath, nupkgPath);
  console.log(
    `✅ Windows Squirrel output validated: ${path.basename(packagedSetupExePath)} [${(fs.statSync(packagedSetupExePath).size / 1024 / 1024).toFixed(2)} MB], ${nupkgName} [${nupkgSizeMb.toFixed(2)} MB], RELEASES present.`,
  );
}

function finalizeDownloadedFile(tempDest, dest, label) {
  console.log(`📦 ${label || path.basename(dest)}: promoting ${tempDest} -> ${dest}`);
  fs.renameSync(tempDest, dest);

  const size = fs.statSync(dest).size;
  if (size < MIN_VALID_ASSET_BYTES) {
    throw new Error(`${label || path.basename(dest)} downloaded but size ${size} bytes is below minimum valid threshold ${MIN_VALID_ASSET_BYTES}`);
  }

  console.log(`✅ Saved ${label || path.basename(dest)} to ${dest} [${(size / 1024 / 1024).toFixed(2)} MB]`);
}

function getPartialDownloadSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function escapePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function downloadFileWithCurl(url, tempDest, label) {
  const curlBinary = isWin ? "curl.exe" : "curl";
  ensureDirectory(tempDest);
  const resumeBytes = getPartialDownloadSize(tempDest);
  const resumeDownload = resumeBytes > 0;
  const curlArgs = [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--connect-timeout",
    String(CONNECT_TIMEOUT_SECONDS),
    "--max-time",
    String(Math.floor(DOWNLOAD_TIMEOUT_MS / 1000)),
    "--retry",
    String(CURL_RETRY_COUNT),
    "--retry-delay",
    String(CURL_RETRY_DELAY_SECONDS),
    "--retry-all-errors",
    "--retry-connrefused",
  ];

  if (isWin) {
    curlArgs.push("--http1.1");
  }

  if (resumeDownload) {
    curlArgs.push("--continue-at", "-");
  }

  curlArgs.push("--output", tempDest, url);

  console.warn(
    `🛟 ${label || path.basename(tempDest)}: ${resumeDownload ? "resuming" : "retrying with"} ${curlBinary} for ${truncateForLog(url)}`,
  );

  execFileSync(curlBinary, curlArgs, {
    stdio: "inherit",
    timeout: DOWNLOAD_TIMEOUT_MS,
  });
}

async function downloadFileWithFetchResume(url, tempDest, label) {
  const targetLabel = label || path.basename(tempDest);
  ensureDirectory(tempDest);
  const existingBytes = getPartialDownloadSize(tempDest);
  const requestHeaders = existingBytes > 0
    ? { Range: `bytes=${existingBytes}-` }
    : {};

  if (existingBytes > 0) {
    console.warn(`🛟 ${targetLabel}: resuming with fetch from byte ${existingBytes}`);
  } else {
    console.warn(`🛟 ${targetLabel}: retrying with fetch stream fallback`);
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: "follow",
    headers: requestHeaders,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const appendMode = existingBytes > 0 && response.status === 206;
  if (existingBytes > 0 && !appendMode) {
    console.warn(
      `⚠️ ${targetLabel}: server ignored resume request (status ${response.status}); restarting stream from byte 0`,
    );
  }

  const fileStream = fs.createWriteStream(tempDest, {
    flags: appendMode ? "a" : "w",
  });
  await pipeline(response.body, fileStream);
}

function normalizeCandidateUrl(rawHref, listingUrl) {
  try {
    return new URL(rawHref, listingUrl).href;
  } catch {
    return null;
  }
}

function isDownloadButtonUrl(url) {
  return url.includes("/download?kind=file") || url.includes("/download?kind=folder");
}

function candidateMatchesAsset(url, assetName) {
  const lowerAssetName = assetName.toLowerCase();
  return url.toLowerCase().includes(lowerAssetName) ||
    decodeURIComponent(url).toLowerCase().includes(lowerAssetName);
}

function hasUsableLocalAsset(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() && stats.size >= MIN_VALID_ASSET_BYTES;
  } catch {
    return false;
  }
}

function shouldUseCurlFirst(destPath) {
  return CURL_FIRST_EXTENSIONS.has(path.extname(destPath).toLowerCase());
}

function shouldPreferDownloadButton(asset) {
  return asset?.preferDownloadButton === true;
}

function shouldUseDownloadButtonFallback(asset) {
  return asset?.allowDownloadButtonFallback !== false;
}

function resolveAssetEnvOverride(asset) {
  const envVars = Array.isArray(asset.envVars)
    ? asset.envVars
    : asset.envVar
      ? [asset.envVar]
      : [];

  for (const envVar of envVars) {
    if (envVar && process.env[envVar]) {
      console.log(`🧭 ${asset.name}: using URL from env var ${envVar}`);
      return process.env[envVar];
    }
  }

  return null;
}

async function resolveRedirectTarget(url, label) {
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
      redirect: "manual"
    });

    const location = response.headers.get("location");
    if (!location || response.status < 300 || response.status >= 400) {
      return null;
    }

    const resolvedUrl = new URL(location, url).href;
    console.log(
      "[redirect-resolve] " + label + ": " + truncateForLog(url) + " -> " + truncateForLog(resolvedUrl),
    );
    return resolvedUrl;
  } catch (err) {
    console.warn(
      "[redirect-resolve] " + label + ": failed to pre-resolve " + truncateForLog(url) + ": " + err.message,
    );
    return null;
  }
}

async function resolveDownloadUrl(asset) {
  const envOverride = resolveAssetEnvOverride(asset);
  if (envOverride) {
    return {
      resolvedUrl: envOverride,
      candidateUrls: [envOverride]
    };
  }

  const candidates = [];

  if (asset.downloadButtonUrl && shouldUseDownloadButtonFallback(asset)) {
    console.log(`🧭 ${asset.name}: adding explicit download button URL ${asset.downloadButtonUrl}`);
    candidates.push(asset.downloadButtonUrl);
  }

  if (Array.isArray(asset.staticUrls)) {
    console.log(
      `🧭 ${asset.name}: adding static fallback URLs -> ${asset.staticUrls.map((url) => truncateForLog(url)).join(" | ")}`,
    );
    candidates.push(...asset.staticUrls);
  }

  const redirectDerivedCandidates = [];
  for (const candidateUrl of candidates) {
    if (!isDownloadButtonUrl(candidateUrl)) {
      continue;
    }

    const redirectTarget = await resolveRedirectTarget(candidateUrl, asset.name);
    if (redirectTarget) {
      redirectDerivedCandidates.push(redirectTarget);
    }
  }

  if (redirectDerivedCandidates.length) {
    console.log(
      "[redirect-resolve] " + asset.name + ": adding redirect-derived URLs -> " + redirectDerivedCandidates.map((url) => truncateForLog(url)).join(" | "),
    );
    candidates.push(...redirectDerivedCandidates);
  }

  let listingError = null;
  if (asset.listingUrl && asset.useListingLookup !== false) {
    console.log(`🔍 ${asset.name}: requesting listing ${asset.listingUrl}`);
    let response;
    try {
      response = await fetch(asset.listingUrl, {
        signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
        redirect: "follow"
      });

      console.log(
        `📡 ${asset.name}: listing response status=${response.status} redirectedUrl=${response.url}`,
      );
      if (!response.ok) {
        throw new Error(`Listing request failed (${response.status} ${response.statusText})`);
      }
      const html = await response.text();
      const hrefPattern = /href=["']([^"']+)["']/gi;
      const rawHrefs = [];
      const listingCandidates = [];
      let hrefMatch;
      while ((hrefMatch = hrefPattern.exec(html)) !== null) {
        rawHrefs.push(hrefMatch[1]);
        const normalized = normalizeCandidateUrl(hrefMatch[1], asset.listingUrl);
        if (normalized && candidateMatchesAsset(normalized, asset.name)) {
          listingCandidates.push(normalized);
        }
      }

      console.log(
        `🧾 ${asset.name}: parsed ${rawHrefs.length} hrefs from listing, matched ${listingCandidates.length} href candidates`,
      );
      if (listingCandidates.length) {
        console.log(
          `🧾 ${asset.name}: matched listing candidates -> ${listingCandidates.map((url) => truncateForLog(url)).join(" | ")}`,
        );
      }

      candidates.push(...listingCandidates);
    } catch (err) {
      listingError = err;
      console.warn(`⚠️ ${asset.name}: listing lookup failed, continuing with explicit fallback URLs: ${err.message}`);
    }
  }

  const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
  console.log(`🧮 ${asset.name}: ${uniqueCandidates.length} unique candidate URLs after merge/dedupe`);
  if (uniqueCandidates.length) {
    uniqueCandidates.forEach((url, index) => {
      const kind = isDownloadButtonUrl(url)
        ? "download-button"
        : /[?&](AWSAccessKeyId|Signature|Expires|X-Amz-Algorithm|X-Amz-Signature)=/i.test(url) &&
          !isDownloadButtonUrl(url)
          ? "presigned"
          : "direct";
      console.log(`   [${index + 1}] type=${kind} url=${truncateForLog(url)}`);
    });
  }
  if (!uniqueCandidates.length) {
    if (listingError) {
      throw new Error(`No usable fallback URLs for ${asset.name} after listing failed: ${listingError.message}`);
    }
    throw new Error(`No listing links found for ${asset.name}.`);
  }

  const presigned = uniqueCandidates.find(
    (url) => /[?&](AWSAccessKeyId|Signature|Expires|X-Amz-Algorithm|X-Amz-Signature)=/i.test(url) &&
      !isDownloadButtonUrl(url)
  );
  const fallback = uniqueCandidates.find((url) => isDownloadButtonUrl(url));
  const directFile = uniqueCandidates.find((url) => !isDownloadButtonUrl(url));
  const preferDownloadButton = shouldPreferDownloadButton(asset);
  const resolvedUrl = preferDownloadButton
    ? (fallback || presigned || directFile)
    : (presigned || fallback || directFile);
  const prioritizedUrls = [
    ...(preferDownloadButton
      ? (fallback ? [fallback] : [])
      : (presigned ? [presigned] : [])),
    ...(preferDownloadButton
      ? (presigned && presigned !== fallback ? [presigned] : [])
      : (fallback && fallback !== presigned ? [fallback] : [])),
    ...(directFile && directFile !== presigned && directFile !== fallback ? [directFile] : []),
    ...uniqueCandidates.filter(
      (url) => url !== presigned && url !== fallback && url !== directFile,
    )
  ];

  if (!resolvedUrl) {
    throw new Error(`Unable to resolve download URL for ${asset.name}.`);
  }

  console.log(`🔗 ${asset.name}: selected download URL ${truncateForLog(resolvedUrl)}`);
  return {
    resolvedUrl,
    candidateUrls: prioritizedUrls
  };
}

function isRetryableDownloadError(err) {
  const message = String(err?.message || err || "");
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNABORTED|socket hang up|network timeout|timed out|timeout|aborted|terminated|premature close|ERR_STREAM_PREMATURE_CLOSE|transfer closed with|empty reply from server|curl:s*((18|28|52|55|56))/i.test(message);
}

async function logDownloadResponseProbe(url, label) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(Math.min(LISTING_TIMEOUT_MS, 30_000)),
      redirect: "follow"
    });

    console.log(
      `📡 ${label}: response status=${response.status} redirectedUrl=${response.url} contentType=${response.headers.get("content-type") || "unknown"} contentLength=${response.headers.get("content-length") || "unknown"}`,
    );

    if (response.body && typeof response.body.destroy === "function") {
      response.body.destroy();
    }
  } catch (err) {
    console.warn(
      `⚠️ ${label}: response probe failed before curl download: ${err.message}`,
    );
  }
}

async function downloadFile(url, dest, label) {
  const tempDest = `${dest}.partial`;
  const targetLabel = label || path.basename(dest);
  const curlFirst = shouldUseCurlFirst(dest);
  ensureDirectory(tempDest);
  if (fs.existsSync(tempDest)) {
    const partialSize = getPartialDownloadSize(tempDest);
    if (partialSize > 0) {
      console.log(`♻️ ${targetLabel}: reusing partial download ${tempDest} (${partialSize} bytes)`);
    } else {
      console.log(`🧹 Removing stale partial file ${tempDest}`);
      fs.unlinkSync(tempDest);
    }
  }

  if (curlFirst) {
    console.log(
      "🛟 " + targetLabel + ": using curl-first strategy for large archive download",
    );
    await logDownloadResponseProbe(url, targetLabel);
    try {
      downloadFileWithCurl(url, tempDest, targetLabel);
    } catch (err) {
      console.warn(
        `⚠️ ${targetLabel}: curl download failed${isWin ? " on Windows" : ""}, falling back to fetch downloader: ${err.message}`,
      );
      await downloadFileWithFetchResume(url, tempDest, targetLabel);
    }
    finalizeDownloadedFile(tempDest, dest, targetLabel);
    return;
  }

  console.log(`📥 ${targetLabel}: starting download from ${truncateForLog(url)}`);
  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      redirect: "follow"
    });
  } catch (err) {
    console.error(`❌ ${targetLabel}: request failed before response: ${err.message}`);
    try {
      downloadFileWithCurl(url, tempDest, targetLabel);
      finalizeDownloadedFile(tempDest, dest, targetLabel);
      return;
    } catch (fallbackErr) {
      if (fs.existsSync(tempDest) && getPartialDownloadSize(tempDest) === 0) {
        fs.unlinkSync(tempDest);
      }
      throw new Error(`${err.message}; curl fallback failed: ${fallbackErr.message}`);
    }
  }

  console.log(
    `📡 ${targetLabel}: response status=${res.status} redirectedUrl=${res.url} contentType=${res.headers.get("content-type") || "unknown"} contentLength=${res.headers.get("content-length") || "unknown"}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const fileStream = fs.createWriteStream(tempDest);
  try {
    console.log(`💾 ${targetLabel}: streaming to temporary file ${tempDest}`);
    await pipeline(res.body, fileStream);
    finalizeDownloadedFile(tempDest, dest, targetLabel);
  } catch (err) {
    console.error(`❌ ${targetLabel}: stream/write failed: ${err.message}`);
    if (fs.existsSync(tempDest) && getPartialDownloadSize(tempDest) === 0) {
      fs.unlinkSync(tempDest);
    } else if (fs.existsSync(tempDest)) {
      console.warn(`⚠️ ${targetLabel}: keeping partial file for resume (${getPartialDownloadSize(tempDest)} bytes)`);
    }
    throw err;
  }
}

async function downloadAssetWithFallbacks(asset) {
  const { resolvedUrl, candidateUrls } = await resolveDownloadUrl(asset);
  console.log(`📥 ${asset.name}: resolved source ${truncateForLog(resolvedUrl)}`);

  const attemptErrors = [];
  for (const candidateUrl of candidateUrls) {
    let largestPartialBytes = 0;
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS_PER_URL; attempt += 1) {
      console.log(
        `🌐 ${asset.name}: download attempt ${attempt}/${DOWNLOAD_ATTEMPTS_PER_URL} using ${truncateForLog(candidateUrl)}`,
      );
      try {
        await downloadFile(candidateUrl, asset.destination, path.basename(asset.destination));
        return;
      } catch (err) {
        const retryable = isRetryableDownloadError(err);
        const message = err?.message || String(err);
        const partialPath = `${asset.destination}.partial`;
        let partialBytes = 0;

        if (fs.existsSync(partialPath)) {
          partialBytes = fs.statSync(partialPath).size;
        }

        const madeProgress = partialBytes > largestPartialBytes;
        if (madeProgress) {
          largestPartialBytes = partialBytes;
          console.warn(`⚠️ ${asset.name}: partial download progressed to ${partialBytes} bytes; retrying resume path`);
        }

        attemptErrors.push(`${truncateForLog(candidateUrl)} :: ${message}`);
        console.warn(
          `⚠️ ${asset.name}: attempt ${attempt} failed for ${truncateForLog(candidateUrl)} (${retryable ? "retryable" : "non-retryable"}): ${message}`,
        );
        if (attempt < DOWNLOAD_ATTEMPTS_PER_URL && (retryable || madeProgress)) {
          await delay(DOWNLOAD_RETRY_DELAY_MS);
          continue;
        }
        break;
      }
    }
  }

  throw new Error(
    `All download attempts failed for ${asset.name}. Tried ${candidateUrls.length} URL(s): ${attemptErrors.join(" | ")}`,
  );
}

async function downloadLargeAssetsIfCI(ext) {
  if (!isCI) {
    console.log("💻 Local environment detected. Skipping asset download.");
    return;
  } else {
    console.log(`💻 GIT CI environment detected. Proceeding with asset download for extension: ${ext}`);
  }

  const videoBgDest = path.join(installerDir, "video-bg.mp4");
  const platform = process.platform;
  const osTag = osMap[platform];
  if (!osTag) {
    throw new Error("Unsupported platform for installer asset download: " + platform);
  }
  const templateDest = path.join(installerDir, "BreakEvenClient_Template.zip");
  const cachedTemplateDest = getTemplateCachePath(ext);
  const templateAssetPath =
    "beta/dashboard_dist/" + osTag + "/" + ext + "_BreakEvenClient_Template.zip";

  const assets = [
    {
      name: "video-bg.mp4",
      destination: videoBgDest,
      listingUrl: "https://socket.breakeventx.com/?prefix=beta/",
      useListingLookup: false,
      downloadButtonUrl:
        "https://socket.breakeventx.com/download?kind=file&path=beta%2Fvideo-bg.mp4",
      staticUrls: GENERATED_VIDEO_BG_URL ? [GENERATED_VIDEO_BG_URL] : [],
      envVars: ["INSTALLER_VIDEO_BG_URL"]
    },
    {
      name: `${ext}_BreakEvenClient_Template.zip`,
      destination: cachedTemplateDest,
      listingUrl: `https://socket.breakeventx.com/?prefix=beta/dashboard_dist/${osTag}/`,
      useListingLookup: false,
      allowDownloadButtonFallback: false,
      downloadButtonUrl:
        `https://socket.breakeventx.com/download?kind=file&path=${encodeURIComponent(templateAssetPath)}`,
      staticUrls: GENERATED_TEMPLATE_URLS[ext]
        ? [GENERATED_TEMPLATE_URLS[ext]]
        : [],
      envVars: [`INSTALLER_TEMPLATE_URL_${ext.toUpperCase()}`, "INSTALLER_TEMPLATE_URL"]
    }
  ];

  for (const asset of assets) {
    console.log(`🧱 Asset step start: ${asset.name} -> ${asset.destination}`);
    if (hasUsableLocalAsset(asset.destination)) {
      const size = fs.statSync(asset.destination).size;
      console.log(`✅ ${path.basename(asset.destination)} already exists locally (${size} bytes). Skipping download.`);
      continue;
    }

    try {
      await downloadAssetWithFallbacks(asset);
      console.log(`✅ Asset step complete: ${asset.name}`);
    } catch (err) {
      console.error(`❌ Asset step failed: ${asset.name}: ${err.message}`);
      throw err;
    }
  }

  stageTemplateForBuild(ext);

  // Presence and size check
  const files = [
    { path: videoBgDest, label: "video-bg.mp4" },
    { path: templateDest, label: "BreakEvenClient_Template.zip" },
    { path: cachedTemplateDest, label: `${ext}_BreakEvenClient_Template.zip (cache)` }
  ];
  files.forEach(f => {
    if (fs.existsSync(f.path)) {
      const size = fs.statSync(f.path).size;
      console.log(`🟢 File found: ${f.label} (${f.path}) [${(size / 1024 / 1024).toFixed(2)} MB]`);
    } else {
      console.error(`🔴 MISSING: ${f.label} (${f.path})`);
    }
  });
}

async function runBuild() {
  const platform = process.platform;
  console.log("🖥️ Detected platform:", platform);

  const distributables = distributablesByPlatform[platform] || [];

  for (const { ext, maker } of distributables) {
    console.log(`🔨 Starting build step for distributable extension: ${ext}, using maker: ${maker}`);
    // Download extension-specific BreakEvenClient_Template.zip and video-bg.mp4
    await downloadLargeAssetsIfCI(ext);
    validateTemplateArchiveForBuild(ext);
    validateWindowsTemplateArchiveContent(ext);
    if (platform === "win32" && ext === "exe") {
      configureWindowsBootstrapperPackaging();
    }
    cleanPackagerTempDir();
    const isolatedTempDir = createIsolatedTempDir(platform, ext);

    let forgeCmd = `npx electron-forge make --platform ${platform}`;
    if (platform === "linux") forgeCmd += " --arch x64";
    if (platform === "darwin") forgeCmd += " --arch arm64";
    forgeCmd += ` --targets=${maker}`;
    console.log(`🚀 Running: ${forgeCmd}`);
    try {
      execSync(forgeCmd, {
        cwd: installerDir,
        env: {
          ...process.env,
          TEMP: isolatedTempDir,
          TMP: isolatedTempDir,
          TMPDIR: isolatedTempDir,
        },
        stdio: "inherit",
        shell: true
      });
    } catch (err) {
      console.error(`❌ electron-forge make failed for .${ext}:`, err.message);
      process.exit(1);
    }
    await validateWindowsSquirrelOutput();
    console.log(`✅ Finished build for extension: ${ext}, maker: ${maker}`);
  }
}

runBuild().catch(err => {
  console.error("❌ Build failed:", err.message);
  process.exit(1);
});
