const { execSync, execFileSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { pipeline } = require("stream/promises");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const isWin = os.platform() === "win32";
const isCI = process.env.GITHUB_ACTIONS === "true";
const installerDir = process.cwd();
const GENERATED_VIDEO_BG_URL = "https://data.breakeventx.com:64444/content-cache/updates/beta/video-bg.mp4?response-content-disposition=attachment%3B%20filename%3D%22video-bg.mp4%22&response-content-type=application%2Foctet-stream&AWSAccessKeyId=content_manager&Signature=oKUFy9l4TRfyhim9j5lNUAtljbs%3D&Expires=1776005006";
const GENERATED_TEMPLATE_URLS = {
  "exe": "https://data.breakeventx.com:64444/content-cache/updates/beta/dashboard_dist/windows-latest/exe_BreakEvenClient_Template.zip?response-content-disposition=attachment%3B%20filename%3D%22exe_BreakEvenClient_Template.zip%22&response-content-type=application%2Foctet-stream&AWSAccessKeyId=content_manager&Signature=kJt2VNnPUxydOd5q08tA6K2dioc%3D&Expires=1776005009",
  "dmg": "https://data.breakeventx.com:64444/content-cache/updates/beta/dashboard_dist/macos-latest/dmg_BreakEvenClient_Template.zip?response-content-disposition=attachment%3B%20filename%3D%22dmg_BreakEvenClient_Template.zip%22&response-content-type=application%2Foctet-stream&AWSAccessKeyId=content_manager&Signature=TDKMxOkJtFWRd6DmYZ%2BsOdMb7dE%3D&Expires=1776005033",
  "deb": "https://data.breakeventx.com:64444/content-cache/updates/beta/dashboard_dist/ubuntu-latest/deb_BreakEvenClient_Template.zip?response-content-disposition=attachment%3B%20filename%3D%22deb_BreakEvenClient_Template.zip%22&response-content-type=application%2Foctet-stream&AWSAccessKeyId=content_manager&Signature=Yq7df6MgMgmY2v54k2xYQ%2FW7eI8%3D&Expires=1776005053",
  "rpm": "https://data.breakeventx.com:64444/content-cache/updates/beta/dashboard_dist/ubuntu-latest/rpm_BreakEvenClient_Template.zip?response-content-disposition=attachment%3B%20filename%3D%22rpm_BreakEvenClient_Template.zip%22&response-content-type=application%2Foctet-stream&AWSAccessKeyId=content_manager&Signature=zMbhLV1I6DUdPwdq7e3hsH3Kjpw%3D&Expires=1776005073"
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
const DOWNLOAD_ATTEMPTS_PER_URL = 2;
const DOWNLOAD_RETRY_DELAY_MS = 3_000;

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

function finalizeDownloadedFile(tempDest, dest, label) {
  console.log(`📦 ${label || path.basename(dest)}: promoting ${tempDest} -> ${dest}`);
  fs.renameSync(tempDest, dest);

  const size = fs.statSync(dest).size;
  if (size < MIN_VALID_ASSET_BYTES) {
    throw new Error(`${label || path.basename(dest)} downloaded but size ${size} bytes is below minimum valid threshold ${MIN_VALID_ASSET_BYTES}`);
  }

  console.log(`✅ Saved ${label || path.basename(dest)} to ${dest} [${(size / 1024 / 1024).toFixed(2)} MB]`);
}

function downloadFileWithCurl(url, tempDest, label) {
  const curlBinary = isWin ? "curl.exe" : "curl";
  const resumeDownload =
    fs.existsSync(tempDest) && fs.statSync(tempDest).size >= MIN_VALID_ASSET_BYTES;
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
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network timeout|timed out|timeout|aborted|transfer closed with|empty reply from server|curl:s*((18|28|52|55|56))/i.test(message);
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
  if (fs.existsSync(tempDest)) {
    const partialSize = fs.statSync(tempDest).size;
    if (curlFirst && partialSize >= MIN_VALID_ASSET_BYTES) {
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
    downloadFileWithCurl(url, tempDest, targetLabel);
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
      if (fs.existsSync(tempDest)) {
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
    if (fs.existsSync(tempDest)) {
      fs.unlinkSync(tempDest);
    }
    throw err;
  }
}

async function downloadAssetWithFallbacks(asset) {
  const { resolvedUrl, candidateUrls } = await resolveDownloadUrl(asset);
  console.log(`📥 ${asset.name}: resolved source ${truncateForLog(resolvedUrl)}`);

  const attemptErrors = [];
  for (const candidateUrl of candidateUrls) {
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
          attemptErrors.push(`${truncateForLog(candidateUrl)} :: ${message}`);
        console.warn(
          `⚠️ ${asset.name}: attempt ${attempt} failed for ${truncateForLog(candidateUrl)} (${retryable ? "retryable" : "non-retryable"}): ${message}`,
        );
        if (attempt < DOWNLOAD_ATTEMPTS_PER_URL && retryable) {
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
      destination: templateDest,
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
    cleanPackagerTempDir();
    const isolatedTempDir = createIsolatedTempDir(platform, ext);

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
    console.log(`✅ Finished build for extension: ${ext}, maker: ${maker}`);
  }
}

runBuild().catch(err => {
  console.error("❌ Build failed:", err.message);
  process.exit(1);
});
