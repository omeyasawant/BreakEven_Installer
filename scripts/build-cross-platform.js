const { execSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const isWin = os.platform() === "win32";
const isCI = process.env.GITHUB_ACTIONS === "true";
const installerDir = process.cwd();

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

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const buffer = await res.buffer();
  fs.writeFileSync(dest, buffer);
  console.log(`✅ Saved ${path.basename(dest)} to ${dest} [${(buffer.length / 1024 / 1024).toFixed(2)} MB]`);
}

async function downloadLargeAssetsIfCI(ext) {
  if (!isCI) {
    console.log("💻 Local environment detected. Skipping asset download.");
    return;
  } else {
    console.log(`💻 GIT CI environment detected. Proceeding with asset download for extension: ${ext}`);
  }

  // Always download video-bg.mp4 if not present
  const videoBgUrl = "https://socket.breakeventx.com/beta/video-bg.mp4";
  const videoBgDest = path.join(installerDir, "video-bg.mp4");
  if (!fs.existsSync(videoBgDest)) {
    console.log(`📥 Downloading ${videoBgUrl}...`);
    await downloadFile(videoBgUrl, videoBgDest);
  }

  // Fetch the extension-specific BreakEvenClient_Template.zip
  const platform = process.platform;
  const osTag = osMap[platform];
  const templateUrl = `https://socket.breakeventx.com/beta/dashboard_dist/${osTag}/${ext}_BreakEvenClient_Template.zip`;
  const templateDest = path.join(installerDir, "BreakEvenClient_Template.zip");
  console.log(`📥 Downloading ${templateUrl} as BreakEvenClient_Template.zip for extension: ${ext}`);
  await downloadFile(templateUrl, templateDest);

  // Presence and size check
  const files = [
    { path: videoBgDest, label: "video-bg.mp4" },
    { path: templateDest, label: "BreakEvenClient_Template.zip" }
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

    // Build only the distributable for this extension
    let forgeCmd = `npx electron-forge make --platform ${platform}`;
    if (platform === "win32") forgeCmd += " --arch x64";
    if (platform === "linux") forgeCmd += " --arch x64";
    if (platform === "darwin") forgeCmd += " --arch arm64";
    forgeCmd += ` --makers=${maker}`;
    console.log(`🚀 Running: ${forgeCmd}`);
    try {
      execSync(forgeCmd, {
        cwd: installerDir,
        stdio: "inherit",
        shell: true
      });
    } catch (err) {
      console.error(`❌ electron-forge make failed for .${ext}:`, err.message);
      process.exit(1);
    }
    console.log(`✅ Finished build for extension: ${ext}, maker: ${maker}`);
  }
}

runBuild().catch(err => {
  console.error("❌ Build failed:", err.message);
  process.exit(1);
});
