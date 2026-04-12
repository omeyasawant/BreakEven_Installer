const { app, BrowserWindow, ipcMain, dialog } = require("electron");
// handle all the common Squirrel events and quit early if one fired
/*
if (require('electron-squirrel-startup')) {
    app.quit();
    return;
}
*/
try {
  if (require("electron-squirrel-startup")) {
    app.quit();
    return;
  }
} catch (_) {
  // module not found in packaged builds — safe to ignore
  console.log("[Electron] electron-squirrel-startup catch case");
}

const path = require("path");
const fs = require("fs");
const fsExtra = require("fs-extra");
const os = require("os");
const crypto = require("crypto");
const https = require("https");
const unzipper = require("unzipper");
const { pipeline } = require("stream/promises");
//const childProcess = require('child_process');
const { execFile, spawn } = require("child_process");

const TERMS_FILE_NAME = "terms-and-conditions.txt";
const acceptanceReceipts = new Map();

//let logStream;

// Logging File Functions
//const logPath = path.join(app.getPath('userData'), 'squirrel-events.log');
//const logStream = fs.createWriteStream(logPath, { flags: 'a' });
/*
function log(message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    logStream.write(line);
    console.log(message);  // still log to stdout if attached
}
*/
// ✅ Prevent silent Squirrel update-only launches from showing a window
/*
if (require("electron-squirrel-startup")) {
    console.log("🟡 Squirrel startup event detected, exiting.");
    //app.quit();
    //return;
}
*/

/*
function handleSquirrelEvent() {
    if (process.platform !== 'win32') return false;
    log(`Full process.argv: ${process.argv.join(' | ')}`);
    const squirrelEvent = process.argv[1];
    const exeDir = path.dirname(process.execPath); // net45/
    const updateExe = path.resolve(exeDir, '..', '..', '..', 'Update.exe');
    //const appExe = path.basename(process.execPath);  // e.g., BreakEvenInstaller.exe
    const appExe = "breakeveninstaller.exe";  // e.g., BreakEvenInstaller.exe
    //const appExe = `${app.getName()}.exe`; // dynamically picks the name

    log(`🐿️ Squirrel event detected: ${squirrelEvent}`);
    log(`process.execPath = ${process.execPath}`);
    log(`🔧 Using update executable: ${updateExe}`);
    log(`🔧 App executable assumed: ${appExe}`);

    function runUpdateCommand(args) {
        try {
            spawn(updateExe, args, {
                detached: true,
                stdio: 'ignore'
            });
            return true;
        } catch (e) {
            log(`❌ Failed to run Update.exe with args ${args.join(" ")}: ${e.message}`);
            return false;
        }
    }

    switch (squirrelEvent) {
        case '--squirrel-install':
            log('[SQUIRREL] Install event detected');
            //runUpdateCommand(['--createShortcut', appExe]);
            log('✅ Shortcut created. Launching app...');
            //runUpdateCommand(['--processStart', appExe]);
            //app.quit();
            return true;

        case '--squirrel-updated':
            log('[SQUIRREL] Update event detected');
            //runUpdateCommand(['--createShortcut', appExe]);
            log('✅ Shortcut created. Launching app...');
            //runUpdateCommand(['--processStart', appExe]);
            //app.quit();
            return true;

        case '--squirrel-uninstall':
            log('[SQUIRREL] Uninstall event detected');
            //runUpdateCommand(['--removeShortcut', appExe]);
            //app.quit();
            return true;

        case '--squirrel-obsolete':
            log('[SQUIRREL] Obsolete event detected');
            //app.quit();
            return true;

        default:
            log('[SQUIRREL] No recognized event');
            return false;
            
    }
}

*/

// Call this at the top of main process
/*
try {
    if (handleSquirrelEvent()) {
        // 🛑 Squirrel event handled, quitting app
        return;
    } else {
        console.log("[SQUIRREL] No Squirrel event, launching app...");
    }
} catch (err) {
    console.error('❌ Failed to handle Squirrel event:', err.message);
    console.error('⚠️ Proceeding with normal launch in case of unexpected Squirrel error...');
}
*/

function createWindow() {
  // ✅ Append launch log
  //const launchLogPath = path.join(app.getPath('userData'), 'launch.log');
  //fs.appendFileSync(launchLogPath, `App launched at ${new Date().toISOString()}\n`);

  const { screen } = require("electron");
  const primaryDisplay = screen.getPrimaryDisplay();
  const width = Math.floor(primaryDisplay.size.width * 0.75);
  const height = Math.floor(primaryDisplay.size.height * 0.75);

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 700,
    minHeight: 620,
    resizable: true,
    frame: false,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.loadURL("http://localhost:3969");
  win.removeMenu();
  console.log("[Electron] Installer window launched in development mode");
}

function escapePowerShellString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

async function relaunchInstallerElevated() {
  if (process.platform !== "win32") {
    return false;
  }

  const filePath = process.execPath;
  const argumentList = process.argv.slice(1);
  const quotedArguments = argumentList
    .map((arg) => escapePowerShellString(arg))
    .join(", ");
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    `$filePath = ${escapePowerShellString(filePath)}`,
    `$workingDirectory = ${escapePowerShellString(process.cwd())}`,
    `$argumentList = @(${quotedArguments})`,
    "Start-Process -FilePath $filePath -ArgumentList $argumentList -WorkingDirectory $workingDirectory -Verb RunAs | Out-Null",
  ].join("\n");

  await new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-Command", psScript],
      { windowsHide: true },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });

  return true;
}

app.whenReady().then(async () => {
  if (process.platform === "win32") {
    const elevated = await isWindowsAdministrator();
    if (!elevated) {
      try {
        console.log(
          "[Electron] Relaunching installer with Administrator privileges",
        );
        await relaunchInstallerElevated();
        app.quit();
        return;
      } catch (error) {
        console.error(
          "[Electron] Failed to relaunch installer elevated:",
          error.message,
        );
      }
    }
  }

  createWindow();
});
/*
app.whenReady().then(() => {
    //const logPath = path.join(app.getPath('userData'), 'squirrel-events.log');
    //logStream = fs.createWriteStream(logPath, { flags: 'a' });

    //createWindow();
    if (!handleSquirrelEvent()) {
        createWindow();
    }
    else {
        createWindow();
    }
});
*/

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function getNearestExistingDirectory(targetPath) {
  let currentPath = path.resolve(String(targetPath || "."));

  while (!fs.existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    currentPath = parentPath;
  }

  try {
    const stats = fs.statSync(currentPath);
    return stats.isDirectory() ? currentPath : path.dirname(currentPath);
  } catch (_) {
    return null;
  }
}

function validateInstallPathInput(inputPath) {
  const candidate = String(inputPath || "").trim();
  if (!candidate) {
    return { valid: false, error: "Installation path is required." };
  }

  if (candidate.includes("\0")) {
    return {
      valid: false,
      error: "Installation path contains invalid characters.",
    };
  }

  const normalizedPath = path.normalize(candidate);
  if (!path.isAbsolute(normalizedPath)) {
    return { valid: false, error: "Enter an absolute installation path." };
  }

  if (process.platform === "win32") {
    const parsed = path.win32.parse(normalizedPath);
    const segments = normalizedPath
      .slice(parsed.root.length)
      .split(/[\\/]+/)
      .filter(Boolean);

    const hasInvalidSegment = segments.some(
      (segment) => /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment),
    );
    if (hasInvalidSegment) {
      return {
        valid: false,
        error: "Installation path contains invalid Windows path characters.",
      };
    }
  }

  if (fs.existsSync(normalizedPath)) {
    try {
      const stats = fs.statSync(normalizedPath);
      if (!stats.isDirectory()) {
        return {
          valid: false,
          error: "Installation path must point to a directory.",
        };
      }
    } catch (err) {
      return {
        valid: false,
        error: err.message || "Unable to inspect the installation path.",
      };
    }
  }

  const nearestExistingDirectory = getNearestExistingDirectory(normalizedPath);
  if (!nearestExistingDirectory) {
    return {
      valid: false,
      error: "Installation path must have an existing parent directory.",
    };
  }

  return {
    valid: true,
    normalizedPath,
    existingParent: nearestExistingDirectory,
  };
}

ipcMain.handle("select-folder", async (_event, currentPath) => {
  const validated = validateInstallPathInput(currentPath);
  const defaultPath = validated.valid
    ? validated.normalizedPath
    : getNearestExistingDirectory(currentPath);
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    defaultPath: defaultPath || undefined,
  });
  return result.filePaths[0];
});

ipcMain.handle("validate-install-path", async (_event, inputPath) => {
  return validateInstallPathInput(inputPath);
});

function sendLog(event, message) {
  console.log(message);
  event.sender.send("install-log", message);
}
function sendProgress(event, percent) {
  event.sender.send("install-progress", percent);
}

function resolveExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getTermsFilePath() {
  const appPath = app.getAppPath();
  return resolveExistingPath([
    path.join(appPath, TERMS_FILE_NAME),
    path.join(appPath, "public", TERMS_FILE_NAME),
    path.join(__dirname, TERMS_FILE_NAME),
    path.join(__dirname, "public", TERMS_FILE_NAME),
    path.join(process.resourcesPath || "", TERMS_FILE_NAME),
    path.join(
      process.resourcesPath || "",
      "app.asar.unpacked",
      TERMS_FILE_NAME,
    ),
  ]);
}

function getTemplateZipPath() {
  const appPath = app.getAppPath();
  return resolveExistingPath([
    path.join(process.resourcesPath || "", "BreakEvenClient_Template.zip"),
    path.join(
      process.resourcesPath || "",
      "app.asar.unpacked",
      "BreakEvenClient_Template.zip",
    ),
    path.join(appPath, "BreakEvenClient_Template.zip"),
    path.join(__dirname, "BreakEvenClient_Template.zip"),
  ]);
}

function loadTermsDocument() {
  const filePath = getTermsFilePath();
  if (!filePath) {
    throw new Error("Unable to locate terms-and-conditions.txt");
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lastUpdatedMatch = content.match(/^Last Updated:\s*(.+)$/im);
  const lastUpdated = lastUpdatedMatch ? lastUpdatedMatch[1].trim() : "";
  const termsHash = crypto.createHash("sha256").update(content).digest("hex");

  return {
    filePath,
    content,
    lastUpdated,
    termsHash,
    termsVersion: lastUpdated || `sha256:${termsHash.slice(0, 12)}`,
  };
}

function getFallbackIpDetails() {
  const interfaces = os.networkInterfaces();
  for (const networkInfo of Object.values(interfaces)) {
    for (const details of networkInfo || []) {
      if (details && details.family === "IPv4" && !details.internal) {
        return {
          ipAddress: details.address,
          ipSource: "local-network",
        };
      }
    }
  }

  return {
    ipAddress: "unavailable",
    ipSource: "unavailable",
  };
}

function getIpDetails() {
  return new Promise((resolve) => {
    const request = https.get("https://api.ipify.org?format=json", {
      timeout: 4000,
    });

    request.on("response", (response) => {
      let body = "";

      response.on("data", (chunk) => {
        body += chunk;
      });

      response.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.ip) {
            resolve({
              ipAddress: parsed.ip,
              ipSource: "public",
            });
            return;
          }
        } catch (_) {}

        resolve(getFallbackIpDetails());
      });
    });

    request.on("timeout", () => {
      request.destroy();
      resolve(getFallbackIpDetails());
    });

    request.on("error", () => {
      resolve(getFallbackIpDetails());
    });
  });
}

function persistAcceptanceRecord(record) {
  const logPath = path.join(
    app.getPath("userData"),
    "terms-acceptance-log.jsonl",
  );
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(record)}${os.EOL}`, "utf8");
  return logPath;
}

ipcMain.handle("get-terms-document", async () => {
  const termsDocument = loadTermsDocument();
  return {
    content: termsDocument.content,
    termsHash: termsDocument.termsHash,
    termsVersion: termsDocument.termsVersion,
    lastUpdated: termsDocument.lastUpdated,
  };
});

ipcMain.handle("record-terms-acceptance", async (_event, payload = {}) => {
  const acceptedName = String(payload.name || "").trim();
  const acceptedEmail = String(payload.email || "").trim();

  if (!acceptedName) {
    return {
      success: false,
      error: "Name is required before accepting the Terms & Conditions.",
    };
  }

  const termsDocument = loadTermsDocument();
  const ipDetails = await getIpDetails();
  const acceptedAt = new Date().toISOString();
  const acceptanceId = crypto.randomUUID();
  const buttonLabel =
    payload.buttonLabel || `I, ${acceptedName}, Accept the Terms & Conditions`;
  const installerVersion = app.getVersion();
  const acceptanceRecord = {
    acceptanceId,
    acceptedAt,
    name: acceptedName,
    email: acceptedEmail || null,
    buttonLabel,
    acceptanceStatement:
      payload.acceptanceStatement ||
      `${acceptedName} accepted the BreakEven Terms & Conditions through the installer clickwrap flow.`,
    termsVersion: termsDocument.termsVersion,
    termsHash: termsDocument.termsHash,
    lastUpdated: termsDocument.lastUpdated || null,
    installerVersion,
    ipAddress: ipDetails.ipAddress,
    ipSource: ipDetails.ipSource,
  };

  const logPath = persistAcceptanceRecord(acceptanceRecord);
  acceptanceReceipts.set(acceptanceId, {
    acceptanceId,
    acceptedAt,
    name: acceptedName,
    email: acceptedEmail,
    termsHash: termsDocument.termsHash,
    termsVersion: termsDocument.termsVersion,
    installerVersion,
  });

  return {
    success: true,
    acceptance: {
      acceptanceId,
      acceptedAt,
      name: acceptedName,
      email: acceptedEmail,
      termsHash: termsDocument.termsHash,
      termsVersion: termsDocument.termsVersion,
      installerVersion,
      ipAddress: ipDetails.ipAddress,
      ipSource: ipDetails.ipSource,
      logPath,
    },
  };
});

function makeAutoStartScript(scriptPath, name, targetDir) {
  const platform = os.platform();
  if (platform === "win32") {
    const startupPath = path.join(
      process.env.APPDATA,
      "Microsoft\\Windows\\Start Menu\\Programs\\Startup",
    );
    const batPath = path.join(startupPath, `${name}.bat`);
    fs.writeFileSync(
      batPath,
      `@echo off\ncd /d "${targetDir}"\nstart "" python "${scriptPath}"\n`,
    );
  } else {
    const autostartDir = path.join(os.homedir(), ".config", "autostart");
    if (!fs.existsSync(autostartDir))
      fs.mkdirSync(autostartDir, { recursive: true });
    const desktopPath = path.join(autostartDir, `${name}.desktop`);
    const content = `[Desktop Entry]
                        Type=Application
                        Exec=python3 "${scriptPath}"
                        Hidden=false
                        NoDisplay=false
                        X-GNOME-Autostart-enabled=true
                        Name=${name}
                        Comment=Autostart ${name}
                        `;
    fs.writeFileSync(desktopPath, content);
  }
}

function launchDashboardAfterInstall(event, destinationPath) {
  const dashboardDir = path.join(destinationPath, "dashboard_gui");
  if (!fs.existsSync(dashboardDir)) {
    sendLog(event, `❌ Dashboard folder not found at ${dashboardDir}`);
    return false;
  }

  const launchDetached = (command, args, cwd = dashboardDir) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: process.platform === "win32",
    });
    child.unref();
  };

  try {
    if (process.platform === "win32") {
      const winCandidates = ["BreakEven.exe", "BreakEven Dashboard.exe"];
      const exePath = winCandidates
        .map((name) => path.join(dashboardDir, name))
        .find((candidate) => fs.existsSync(candidate));

      if (!exePath) {
        sendLog(
          event,
          `❌ No Windows dashboard executable found in ${dashboardDir}`,
        );
        return false;
      }

      sendLog(event, `🚀 Launching Dashboard from ${exePath}`);
      launchDetached(exePath, []);
      return true;
    }

    if (process.platform === "darwin") {
      const appPath = path.join(dashboardDir, "BreakEven.app");
      const dmgPath = path.join(dashboardDir, "BreakEven.dmg");

      if (fs.existsSync(appPath)) {
        sendLog(event, `🚀 Launching Dashboard app bundle ${appPath}`);
        launchDetached("open", [appPath]);
        return true;
      }

      if (fs.existsSync(dmgPath)) {
        sendLog(event, `🚀 Opening Dashboard disk image ${dmgPath}`);
        launchDetached("open", [dmgPath]);
        return true;
      }

      sendLog(
        event,
        `❌ No macOS dashboard artifact (.app/.dmg) found in ${dashboardDir}`,
      );
      return false;
    }

    if (process.platform === "linux") {
      const executableCandidates = [
        "BreakEven",
        "BreakEven.AppImage",
        "BreakEven-x86_64.AppImage",
      ]
        .map((name) => path.join(dashboardDir, name))
        .filter((candidate) => fs.existsSync(candidate));

      if (executableCandidates.length > 0) {
        const launchPath = executableCandidates[0];
        try {
          fs.chmodSync(launchPath, 0o755);
        } catch (_) {}
        sendLog(event, `🚀 Launching Dashboard from ${launchPath}`);
        launchDetached(launchPath, []);
        return true;
      }

      const debPath = path.join(dashboardDir, "BreakEven.deb");
      if (fs.existsSync(debPath)) {
        sendLog(event, `🚀 Opening Dashboard package ${debPath}`);
        launchDetached("xdg-open", [debPath]);
        return true;
      }

      const rpmPath = path.join(dashboardDir, "BreakEven.rpm");
      if (fs.existsSync(rpmPath)) {
        sendLog(event, `🚀 Opening Dashboard package ${rpmPath}`);
        launchDetached("xdg-open", [rpmPath]);
        return true;
      }

      sendLog(event, `❌ No Linux dashboard artifact found in ${dashboardDir}`);
      return false;
    }

    sendLog(
      event,
      `⚠️ Dashboard auto-open is not supported on platform ${process.platform}`,
    );
    return false;
  } catch (err) {
    sendLog(event, `❌ Failed to launch dashboard: ${err.message}`);
    return false;
  }
}

async function cleanupCondaEnv(destinationPath, envName, event) {
  const condaPath = path.join(
    destinationPath,
    "Miniconda3",
    "Scripts",
    "conda.exe",
  );
  sendLog(event, `🧹 Cleaning up Conda env: ${envName}`);
  await new Promise((resolve) => {
    execFile(condaPath, ["env", "remove", "-y", "-n", envName], (err) => {
      if (err) {
        sendLog(event, `⚠️ Failed to remove Conda env: ${err.message}`);
      } else {
        sendLog(event, `✅ Conda env ${envName} removed`);
      }
      resolve();
    });
  });
}

async function LaunchService(event, label, script, destinationPath) {
  return new Promise((resolve, reject) => {
    const minicondaDir = path.join(destinationPath, "Miniconda3");
    const condaRunPath = path.join(minicondaDir, "Scripts", "conda.exe");
    const envName = "breakeven_env";

    // Paths to Python inside the conda env
    const pythonwWin = path.join(minicondaDir, "envs", envName, "pythonw.exe");
    const pythonNix = path.join(minicondaDir, "envs", envName, "bin", "python");

    let pythonExe;

    if (process.platform === "win32" && fs.existsSync(pythonwWin)) {
      // ✅ This is the key change: use pythonw.exe → no console window
      pythonExe = pythonwWin;
    } else if (fs.existsSync(pythonNix)) {
      // Linux/macOS env Python
      pythonExe = pythonNix;
    } else {
      // Fallback (shouldn’t normally happen if env is created correctly)
      pythonExe = "python";
    }

    sendLog(event, `🟡 Launching ${label} using conda env ${envName}...`);
    //sendLog(event, `📄 Command: ${condaRunPath} run -n ${envName} python ${script}`);
    sendLog(event, `📄 Command: "${pythonExe}" "${script}"`);

    // Optional: "ready" handshake file
    const readyFile = path.join(
      destinationPath,
      `${label.toLowerCase()}_ready.txt`,
    );
    try {
      if (fs.existsSync(readyFile)) fs.unlinkSync(readyFile);
    } catch (_) {}

    /*
        const proc = spawn(condaRunPath, ['run', '-n', envName, 'python', script], {
            cwd: destinationPath,
            windowsHide: true,
            detached: true,
            stdio:false,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        */

    const proc = spawn(pythonExe, [script], {
      cwd: destinationPath,
      windowsHide: process.platform === "win32", // hide any associated window
      detached: true, // make it a daemon
      shell: false,
      stdio: ["ignore", "ignore", "ignore"], // no pipes, fully detached
    });

    // Fully detach from the parent process (daemonize)
    proc.unref();

    const pidPath = path.join(
      destinationPath,
      `${label.toLowerCase()}_pid.txt`,
    );
    try {
      fs.writeFileSync(pidPath, String(proc.pid));
      sendLog(event, `📄 PID file written for ${label}: ${proc.pid}`);
    } catch (err) {
      sendLog(
        event,
        `⚠️ Failed to write PID file for ${label}: ${err.message}`,
      );
    }

    let exited = false;
    let resolved = false;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    proc.on("error", (err) => {
      exited = true;
      sendLog(event, `❌ ${label} process failed to start: ${err.message}`);
      finish({ success: false, error: err.message });
    });

    proc.on("exit", (code) => {
      exited = true;
      if (!resolved) {
        sendLog(event, `❌ ${label} exited immediately with code ${code}`);
        finish({ success: false, error: `exited with code ${code}` });
      }
    });

    // Poll for "ready" or assume OK if still alive after timeout
    const timeoutMs = 15000;
    const intervalMs = 500;
    let elapsed = 0;

    const intervalId = setInterval(() => {
      if (resolved) {
        clearInterval(intervalId);
        return;
      }

      // Best case: Python script creates the ready file when fully initialized
      if (fs.existsSync(readyFile)) {
        clearInterval(intervalId);
        sendLog(
          event,
          `✅ ${label} signaled ready via ${path.basename(readyFile)}`,
        );
        finish({ success: true, pid: proc.pid, readyFile: true });
        return;
      }

      elapsed += intervalMs;
      if (elapsed >= timeoutMs) {
        clearInterval(intervalId);
        if (!exited) {
          // Didn’t crash, didn’t signal ready – assume OK but warn
          sendLog(
            event,
            `⚠️ ${label} did not signal ready but is still running; assuming OK`,
          );
          finish({ success: true, pid: proc.pid, readyFile: false });
        }
        // If it already exited, the 'exit' handler handled finish()
      }
    }, intervalMs);
  });
}

function execCommandLogged(command, args, event, options = {}) {
  const { ignoreFailure, ...execOptions } = options;
  sendLog(event, `⚙️ ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { windowsHide: process.platform === "win32", ...execOptions },
      (error, stdout, stderr) => {
        if (stdout && stdout.toString().trim()) {
          sendLog(event, stdout.toString().trim());
        }
        if (stderr && stderr.toString().trim()) {
          sendLog(event, stderr.toString().trim());
        }
        if (error && !ignoreFailure) {
          return reject(error);
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function isWindowsAdministrator() {
  if (process.platform !== "win32") {
    return false;
  }

  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "[bool](([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))",
      ],
      { windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        resolve(
          String(stdout || "")
            .trim()
            .toLowerCase() === "true",
        );
      },
    );
  });
}

function normalizeManifestPath(base, target) {
  if (!target) return null;
  const relative = path.relative(base, target);
  if (relative.startsWith("..")) {
    return target.replace(/\\/g, "/");
  }
  return relative.replace(/\\/g, "/");
}

function normalizeZipEntryPath(entryPath) {
  return String(entryPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function isSafeZipEntryPath(entryPath) {
  if (!entryPath) return false;
  const segments = entryPath.split("/").filter(Boolean);
  return segments.length > 0 && !segments.some((segment) => segment === "..");
}

function resolveZipOutputPath(destinationPath, relativePath) {
  const outputPath = path.resolve(destinationPath, ...relativePath.split("/"));
  const relative = path.relative(path.resolve(destinationPath), outputPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Archive entry resolves outside destination: ${relativePath}`,
    );
  }
  return outputPath;
}

function getZipPrefixToStrip(entryPaths) {
  const segmentedPaths = entryPaths
    .map((entryPath) => entryPath.split("/").filter(Boolean))
    .filter((segments) => segments.length > 0);

  const nestedPaths = segmentedPaths.filter((segments) => segments.length > 1);

  if (!nestedPaths.length) {
    return "";
  }

  const sharedSegments = [];
  let segmentIndex = 0;

  while (true) {
    const candidate = nestedPaths[0][segmentIndex];
    if (!candidate) {
      break;
    }

    const allMatch = nestedPaths.every(
      (segments) =>
        segments.length > segmentIndex + 1 &&
        segments[segmentIndex] === candidate,
    );

    if (!allMatch) {
      break;
    }

    sharedSegments.push(candidate);
    segmentIndex += 1;
  }

  if (!sharedSegments.length) {
    return "";
  }

  const sharedPrefix = sharedSegments.join("/");
  const matchesAllPaths = segmentedPaths.every((segments) => {
    const currentPrefix = segments.slice(0, sharedSegments.length).join("/");
    return (
      currentPrefix === sharedPrefix &&
      (segments.length === sharedSegments.length ||
        segments.length > sharedSegments.length)
    );
  });

  if (!matchesAllPaths) {
    return "";
  }

  return sharedSegments.length ? `${sharedSegments.join("/")}/` : "";
}

async function flattenExtractedTemplateRoot(destinationPath) {
  const wrapperPath = path.join(destinationPath, "BreakEvenClient_Template");
  if (!fs.existsSync(wrapperPath)) {
    return;
  }

  const wrapperStats = await fs.promises.stat(wrapperPath);
  if (!wrapperStats.isDirectory()) {
    return;
  }

  const children = await fs.promises.readdir(wrapperPath);
  for (const child of children) {
    const sourcePath = path.join(wrapperPath, child);
    const targetPath = path.join(destinationPath, child);
    await fsExtra.copy(sourcePath, targetPath, { overwrite: true });
  }

  await fsExtra.remove(wrapperPath);
}

async function extractZipToDirectory(
  zipPath,
  destinationPath,
  { stripSingleTopLevelFolder = false, event } = {},
) {
  const directory = await unzipper.Open.file(zipPath);
  const entryPaths = directory.files
    .map((entry) => normalizeZipEntryPath(entry.path))
    .filter(Boolean);

  let prefixToStrip = "";
  if (stripSingleTopLevelFolder && entryPaths.length > 0) {
    prefixToStrip = getZipPrefixToStrip(entryPaths);
    if (prefixToStrip && event) {
      sendLog(
        event,
        `📂 Detected wrapper path: ${prefixToStrip.slice(0, -1)}, extracting contents...`,
      );
    }
  }

  for (const entry of directory.files) {
    const rawEntryPath = normalizeZipEntryPath(entry.path);
    if (!rawEntryPath) {
      continue;
    }
    if (!isSafeZipEntryPath(rawEntryPath)) {
      throw new Error(`Archive contains unsafe path: ${rawEntryPath}`);
    }

    let relativePath = rawEntryPath;
    if (prefixToStrip) {
      if (!relativePath.startsWith(prefixToStrip)) {
        continue;
      }
      relativePath = relativePath.slice(prefixToStrip.length);
      if (!relativePath) {
        continue;
      }
    }

    const outputPath = resolveZipOutputPath(destinationPath, relativePath);
    if (entry.type === "Directory") {
      await fs.promises.mkdir(outputPath, { recursive: true });
      continue;
    }

    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await pipeline(entry.stream(), fs.createWriteStream(outputPath));
  }
}

async function ensureMacAppBundle(clientServiceDir, event) {
  const appPath = path.join(clientServiceDir, "Breakeven_Slave.app");
  if (fs.existsSync(appPath)) return appPath;
  const zipPath = path.join(clientServiceDir, "Breakeven_Slave.app.zip");
  if (!fs.existsSync(zipPath)) return null;
  sendLog(event, "📦 Unpacking macOS BreakEven Slave bundle");
  await extractZipToDirectory(zipPath, clientServiceDir);
  if (!fs.existsSync(appPath)) {
    throw new Error("Failed to unpack Breakeven_Slave.app");
  }
  return appPath;
}

function getMacExecutablePath(appPath) {
  const macOsDir = path.join(appPath, "Contents", "MacOS");
  if (!fs.existsSync(macOsDir)) {
    throw new Error("Invalid macOS bundle: missing Contents/MacOS");
  }
  const preferred = path.join(macOsDir, "Breakeven_Slave");
  if (fs.existsSync(preferred)) {
    try {
      fs.chmodSync(preferred, 0o755);
    } catch (_) {}
    return preferred;
  }
  const candidates = fs.readdirSync(macOsDir);
  if (!candidates.length) {
    throw new Error("Breakeven_Slave.app has no executable payload");
  }
  const fallback = path.join(macOsDir, candidates[0]);
  try {
    fs.chmodSync(fallback, 0o755);
  } catch (_) {}
  return fallback;
}

async function resolveSlaveBinary(platform, clientServiceDir, event) {
  if (platform === "win32") {
    const exePath = path.join(clientServiceDir, "Breakeven_Slave.exe");
    if (fs.existsSync(exePath)) {
      return { binaryPath: exePath };
    }
    return null;
  }

  if (platform === "linux") {
    const appImagePath = path.join(
      clientServiceDir,
      "Breakeven_Slave-x86_64.AppImage",
    );
    if (fs.existsSync(appImagePath)) {
      try {
        fs.chmodSync(appImagePath, 0o755);
      } catch (_) {}
      return { binaryPath: appImagePath };
    }
    return null;
  }

  if (platform === "darwin") {
    const appPath = await ensureMacAppBundle(clientServiceDir, event);
    if (!appPath) return null;
    const executablePath = getMacExecutablePath(appPath);
    return { binaryPath: executablePath };
  }

  return null;
}

function createRunnerScript(platform, clientServiceDir, binaryPath, logFile) {
  if (platform === "win32") {
    return binaryPath;
  }

  const runnerName = "breakeven_slave_service_runner.sh";
  const runnerPath = path.join(clientServiceDir, runnerName);
  const escapedBinary = binaryPath.replace(/"/g, '\\"');
  const escapedLog = logFile.replace(/"/g, '\\"');
  const content = [
    "#!/bin/bash",
    "set -e",
    `BINARY=\"${escapedBinary}\"`,
    `LOG_FILE=\"${escapedLog}\"`,
    'echo "$(date -Iseconds) BreakEven Slave starting" >> "$LOG_FILE"',
    '"$BINARY" >> "$LOG_FILE" 2>&1',
    "EXITCODE=$?",
    'echo "$(date -Iseconds) BreakEven Slave stopped with $EXITCODE" >> "$LOG_FILE"',
    "exit $EXITCODE",
  ].join("\n");
  fs.writeFileSync(runnerPath, content, { mode: 0o755 });

  return runnerPath;
}

function findCscExecutable() {
  if (process.platform !== "win32") {
    return null;
  }
  const base = process.env.WINDIR || "C:/Windows";
  const candidates = [
    path.join(base, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(base, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function ensureWindowsServiceHost(event, clientServiceDir) {
  const hostExePath = path.join(
    clientServiceDir,
    "BreakEvenSlaveServiceHost.exe",
  );
  if (fs.existsSync(hostExePath)) {
    return hostExePath;
  }
  const sourcePath = path.join(
    __dirname,
    "service_host",
    "BreakEvenSlaveServiceHost.cs",
  );
  if (!fs.existsSync(sourcePath)) {
    throw new Error("Missing BreakEven slave service host source file.");
  }
  const cscPath = findCscExecutable();
  if (!cscPath) {
    throw new Error(
      "Unable to locate csc.exe to compile the BreakEven service host.",
    );
  }
  fs.mkdirSync(clientServiceDir, { recursive: true });
  const compileArgs = [
    "/nologo",
    "/target:exe",
    `/out:${hostExePath}`,
    "/optimize+",
    "/reference:System.ServiceProcess.dll",
    sourcePath,
  ];
  await execCommandLogged(cscPath, compileArgs, event);
  return hostExePath;
}

async function registerWindowsService(
  event,
  hostExePath,
  binaryPath,
  logFile,
  options = {},
) {
  const serviceName = options.serviceName || "BreakEvenSlave";
  const displayName = options.displayName || "BreakEven Slave";
  const serviceDescription =
    options.description || "BreakEven background worker";
  const startupType = options.autoStart ? "Automatic" : "Manual";
  const enableRecovery = options.autoStart !== false;
  const startImmediately = options.startImmediately !== false;
  const runAsLocalSystem = options.runAsLocalSystem === true;
  const hostEscaped = hostExePath.replace(/'/g, "''");
  const binaryEscaped = binaryPath.replace(/'/g, "''");
  const logEscaped = logFile.replace(/'/g, "''");
  const serviceNameEscaped = serviceName.replace(/'/g, "''");
  const displayNameEscaped = displayName.replace(/'/g, "''");
  const descriptionEscaped = serviceDescription.replace(/'/g, "''");
  const psScript = `
  $ErrorActionPreference = 'Stop'
  $serviceName = '${serviceNameEscaped}'
  $hostExe = '${hostEscaped}'
  $binary = '${binaryEscaped}'
  $logFile = '${logEscaped}'
  $cmd = '"{0}" --binary "{1}" --log "{2}" --serviceName "{3}"' -f $hostExe, $binary, $logFile, $serviceName
  $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($existing) {
    try { Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue } catch {}
    sc.exe delete $serviceName | Out-Null
    Start-Sleep -Milliseconds 800
  }
  New-Service -Name $serviceName -BinaryPathName $cmd -DisplayName '${displayNameEscaped}' -Description '${descriptionEscaped}' -StartupType ${startupType} | Out-Null
  ${runAsLocalSystem ? "sc.exe config $serviceName obj= LocalSystem | Out-Null" : ""}
  ${enableRecovery ? "sc.exe failure $serviceName reset= 60 actions= restart/5000 | Out-Null" : ""}
  ${startImmediately ? "Start-Service -Name $serviceName | Out-Null" : ""}
  `;
  await execCommandLogged(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", psScript],
    event,
  );
  return {
    type: "windows-service",
    identifier: serviceName,
    commands: {
      start: [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `Start-Service -Name '${serviceName}'`,
      ],
      stop: [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `Stop-Service -Name '${serviceName}'`,
      ],
      restart: [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `Restart-Service -Name '${serviceName}'`,
      ],
      status: [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `(Get-Service -Name '${serviceName}').Status`,
      ],
    },
    notes: enableRecovery
      ? "Managed via Windows Service Control Manager with automatic restart."
      : "Managed via Windows Service Control Manager with manual startup.",
  };
}

async function registerLinuxService(
  event,
  runnerPath,
  destinationPath,
  options = {},
) {
  const serviceName = options.serviceName || "breakeven-slave";
  const description =
    options.description || "BreakEven Slave background worker";
  const systemdDir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(systemdDir, { recursive: true });
  const unitPath = path.join(systemdDir, `${serviceName}.service`);
  const escapedRunner = runnerPath.replace(/"/g, '\\"');
  const workingDir = path
    .join(destinationPath, "client_service")
    .replace(/"/g, '\\"');
  const unitContent = `
[Unit]
Description=${description}
After=network-online.target

[Service]
ExecStart="${escapedRunner}"
Restart=on-failure
RestartSec=5
WorkingDirectory="${workingDir}"

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unitContent, "utf8");
  await execCommandLogged("systemctl", ["--user", "daemon-reload"], event);
  await execCommandLogged(
    "systemctl",
    ["--user", "enable", "--now", `${serviceName}.service`],
    event,
  );
  return {
    type: "systemd-user-service",
    identifier: `${serviceName}.service`,
    commands: {
      start: ["systemctl", "--user", "start", `${serviceName}.service`],
      stop: ["systemctl", "--user", "stop", `${serviceName}.service`],
      restart: ["systemctl", "--user", "restart", `${serviceName}.service`],
      status: ["systemctl", "--user", "status", `${serviceName}.service`],
    },
    notes: `Systemd unit written to ${unitPath}`,
  };
}

async function registerMacService(event, runnerPath, logFile, options = {}) {
  const label = options.label || "com.breakeven.slave";
  const agentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const plistPath = path.join(agentsDir, `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${runnerPath}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logFile}</string>
    <key>StandardErrorPath</key>
    <string>${logFile}</string>
</dict>
</plist>`;
  fs.writeFileSync(plistPath, plist, "utf8");
  await execCommandLogged("launchctl", ["unload", plistPath], event, {
    ignoreFailure: true,
  });
  await execCommandLogged("launchctl", ["load", "-w", plistPath], event);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return {
    type: "launch-agent",
    identifier: label,
    commands: {
      start: ["launchctl", "start", label],
      stop: ["launchctl", "stop", label],
      restart: ["launchctl", "kickstart", "-k", `gui/${uid}/${label}`],
      status: ["launchctl", "list", label],
    },
    notes: `LaunchAgent plist stored at ${plistPath}`,
  };
}

function writeServiceManifest(destinationPath, descriptor, options = {}) {
  const manifestName = options.fileName || "service_manifest.json";
  const serviceName = options.name || "breakeven_slave";
  const manifestCommands = { ...descriptor.commands };
  if (descriptor.platform === "win32") {
    manifestCommands.tail = [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Get-Content -Path '${descriptor.logFile.replace(/'/g, "''")}' -Wait`,
    ];
  } else {
    manifestCommands.tail = ["tail", "-f", descriptor.logFile];
  }

  const manifest = {
    name: serviceName,
    generatedAt: new Date().toISOString(),
    platform: descriptor.platform,
    serviceType: descriptor.type,
    identifier: descriptor.identifier,
    binary: normalizeManifestPath(destinationPath, descriptor.binaryPath),
    runner: normalizeManifestPath(destinationPath, descriptor.runnerPath),
    logFile: normalizeManifestPath(destinationPath, descriptor.logFile),
    control: {
      commands: manifestCommands,
    },
    notes: descriptor.notes,
  };

  const manifestPath = path.join(
    destinationPath,
    "client_service",
    manifestName,
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

async function ensureMacTrayAppBundle(clientServiceDir, event) {
  const appPath = path.join(clientServiceDir, "Breakeven_Tray.app");
  if (fs.existsSync(appPath)) return appPath;
  const zipPath = path.join(clientServiceDir, "Breakeven_Tray.app.zip");
  if (!fs.existsSync(zipPath)) return null;
  sendLog(event, "📦 Unpacking macOS BreakEven Tray bundle");
  await extractZipToDirectory(zipPath, clientServiceDir);
  if (!fs.existsSync(appPath)) {
    throw new Error("Failed to unpack Breakeven_Tray.app");
  }
  return appPath;
}

function getMacTrayExecutablePath(appPath) {
  const macOsDir = path.join(appPath, "Contents", "MacOS");
  if (!fs.existsSync(macOsDir)) {
    throw new Error("Invalid macOS tray bundle: missing Contents/MacOS");
  }
  const preferred = path.join(macOsDir, "Breakeven_Tray");
  if (fs.existsSync(preferred)) {
    try {
      fs.chmodSync(preferred, 0o755);
    } catch (_) {}
    return preferred;
  }
  const candidates = fs.readdirSync(macOsDir);
  if (!candidates.length) {
    throw new Error("Breakeven_Tray.app has no executable payload");
  }
  const fallback = path.join(macOsDir, candidates[0]);
  try {
    fs.chmodSync(fallback, 0o755);
  } catch (_) {}
  return fallback;
}

async function resolveTrayBinary(platform, clientServiceDir, event) {
  if (platform === "win32") {
    const exePath = path.join(clientServiceDir, "Breakeven_Tray.exe");
    if (fs.existsSync(exePath)) {
      return { binaryPath: exePath };
    }
    return null;
  }

  if (platform === "linux") {
    const appImagePath = path.join(
      clientServiceDir,
      "Breakeven_Tray-x86_64.AppImage",
    );
    if (fs.existsSync(appImagePath)) {
      try {
        fs.chmodSync(appImagePath, 0o755);
      } catch (_) {}
      return { binaryPath: appImagePath };
    }
    return null;
  }

  if (platform === "darwin") {
    const appPath = await ensureMacTrayAppBundle(clientServiceDir, event);
    if (!appPath) return null;
    const executablePath = getMacTrayExecutablePath(appPath);
    return { binaryPath: executablePath };
  }

  return null;
}

function createTrayRunnerScript(
  platform,
  clientServiceDir,
  binaryPath,
  logFile,
) {
  if (platform === "win32") {
    return binaryPath;
  }

  const runnerName = "breakeven_tray_service_runner.sh";
  const runnerPath = path.join(clientServiceDir, runnerName);
  const escapedBinary = binaryPath.replace(/"/g, '\\"');
  const escapedLog = logFile.replace(/"/g, '\\"');
  const content = [
    "#!/bin/bash",
    "set -e",
    `BINARY=\"${escapedBinary}\"`,
    `LOG_FILE=\"${escapedLog}\"`,
    'echo "$(date -Iseconds) BreakEven Tray starting" >> "$LOG_FILE"',
    '"$BINARY" >> "$LOG_FILE" 2>&1',
    "EXITCODE=$?",
    'echo "$(date -Iseconds) BreakEven Tray stopped with $EXITCODE" >> "$LOG_FILE"',
    "exit $EXITCODE",
  ].join("\n");
  fs.writeFileSync(runnerPath, content, { mode: 0o755 });

  return runnerPath;
}

async function ensureMacUpdaterAppBundle(clientServiceDir, event) {
  const appPath = path.join(clientServiceDir, "Breakeven_Updater.app");
  if (fs.existsSync(appPath)) return appPath;
  const zipPath = path.join(clientServiceDir, "Breakeven_Updater.app.zip");
  if (!fs.existsSync(zipPath)) return null;
  sendLog(event, "📦 Unpacking macOS BreakEven Updater bundle");
  await extractZipToDirectory(zipPath, clientServiceDir);
  if (!fs.existsSync(appPath)) {
    throw new Error("Failed to unpack Breakeven_Updater.app");
  }
  return appPath;
}

function getMacUpdaterExecutablePath(appPath) {
  const macOsDir = path.join(appPath, "Contents", "MacOS");
  if (!fs.existsSync(macOsDir)) {
    throw new Error("Invalid macOS updater bundle: missing Contents/MacOS");
  }
  const preferred = path.join(macOsDir, "Breakeven_Updater");
  if (fs.existsSync(preferred)) {
    try {
      fs.chmodSync(preferred, 0o755);
    } catch (_) {}
    return preferred;
  }
  const candidates = fs.readdirSync(macOsDir);
  if (!candidates.length) {
    throw new Error("Breakeven_Updater.app has no executable payload");
  }
  const fallback = path.join(macOsDir, candidates[0]);
  try {
    fs.chmodSync(fallback, 0o755);
  } catch (_) {}
  return fallback;
}

async function resolveUpdaterBinary(platform, clientServiceDir, event) {
  if (platform === "win32") {
    const exePath = path.join(clientServiceDir, "Breakeven_Updater.exe");
    if (fs.existsSync(exePath)) {
      return { binaryPath: exePath };
    }
    return null;
  }

  if (platform === "linux") {
    const appImagePath = path.join(
      clientServiceDir,
      "Breakeven_Updater-x86_64.AppImage",
    );
    if (fs.existsSync(appImagePath)) {
      try {
        fs.chmodSync(appImagePath, 0o755);
      } catch (_) {}
      return { binaryPath: appImagePath };
    }
    return null;
  }

  if (platform === "darwin") {
    const appPath = await ensureMacUpdaterAppBundle(clientServiceDir, event);
    if (!appPath) return null;
    const executablePath = getMacUpdaterExecutablePath(appPath);
    return { binaryPath: executablePath };
  }

  return null;
}

function createUpdaterRunnerScript(
  platform,
  clientServiceDir,
  binaryPath,
  logFile,
) {
  if (platform === "win32") {
    return binaryPath;
  }

  const runnerName = "breakeven_updater_service_runner.sh";
  const runnerPath = path.join(clientServiceDir, runnerName);
  const escapedBinary = binaryPath.replace(/"/g, '\\"');
  const escapedLog = logFile.replace(/"/g, '\\"');
  const content = [
    "#!/bin/bash",
    "set -e",
    `BINARY=\"${escapedBinary}\"`,
    `LOG_FILE=\"${escapedLog}\"`,
    'echo "$(date -Iseconds) BreakEven Updater starting" >> "$LOG_FILE"',
    '"$BINARY" >> "$LOG_FILE" 2>&1',
    "EXITCODE=$?",
    'echo "$(date -Iseconds) BreakEven Updater stopped with $EXITCODE" >> "$LOG_FILE"',
    "exit $EXITCODE",
  ].join("\n");
  fs.writeFileSync(runnerPath, content, { mode: 0o755 });

  return runnerPath;
}

function getSystemServiceRoot() {
  if (process.platform === "win32") {
    const programData =
      process.env.ProgramData ||
      (process.env.SystemDrive
        ? path.join(process.env.SystemDrive, "ProgramData")
        : "C:/ProgramData");
    return path.join(programData, "BreakEvenClient");
  }
  if (process.platform === "darwin") {
    return path.join("/Library", "Application Support", "BreakEvenClient");
  }
  if (process.platform === "linux") {
    return path.join("/opt", "breakeven-client");
  }
  return null;
}

function buildServicePathPlan(destinationPath) {
  return {
    rootPath: destinationPath,
    manifestRoot: destinationPath,
    clientServiceDir: path.join(destinationPath, "client_service"),
    logsDir: path.join(destinationPath, "logs"),
    relocated: false,
  };
}

function prepareServicePayloadPaths(event, destinationPath) {
  const plan = buildServicePathPlan(destinationPath);
  const systemRoot = getSystemServiceRoot();
  if (!systemRoot) {
    return plan;
  }

  if (path.resolve(systemRoot) === path.resolve(destinationPath)) {
    return plan;
  }

  const targetClientDir = path.join(systemRoot, "client_service");
  const targetLogsDir = path.join(systemRoot, "logs");

  try {
    fs.mkdirSync(systemRoot, { recursive: true });
    fsExtra.copySync(plan.clientServiceDir, targetClientDir, {
      overwrite: true,
      errorOnExist: false,
    });
    fs.mkdirSync(targetLogsDir, { recursive: true });
    sendLog(
      event,
      `📁 Service payload relocated to elevated path ${targetClientDir}`,
    );
    return {
      rootPath: systemRoot,
      manifestRoot: destinationPath,
      clientServiceDir: targetClientDir,
      logsDir: targetLogsDir,
      relocated: true,
    };
  } catch (err) {
    sendLog(
      event,
      `⚠️ Unable to relocate service payload to ${systemRoot}: ${err.message}. Continuing with standard install path.`,
    );
    return plan;
  }
}

async function configureSlaveService(event, paths, options = {}) {
  const { clientServiceDir, logsDir, manifestRoot, rootPath } = paths;
  const platform = process.platform;
  const binaryInfo = await resolveSlaveBinary(
    platform,
    clientServiceDir,
    event,
  );
  if (!binaryInfo) {
    sendLog(
      event,
      `⚠️ No native BreakEven Slave binary found for platform ${platform}. Falling back to Python service.`,
    );
    return { managed: false };
  }

  fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, "breakeven_slave.log");
  const runnerPath = createRunnerScript(
    platform,
    clientServiceDir,
    binaryInfo.binaryPath,
    logFile,
  );
  let serviceHostPath = null;

  let descriptor;
  try {
    if (platform === "win32") {
      serviceHostPath = await ensureWindowsServiceHost(event, clientServiceDir);
      descriptor = await registerWindowsService(
        event,
        serviceHostPath,
        binaryInfo.binaryPath,
        logFile,
        {
          autoStart: options.autoStart,
          startImmediately: options.startImmediately,
        },
      );
    } else if (platform === "linux") {
      descriptor = await registerLinuxService(event, runnerPath, rootPath);
    } else if (platform === "darwin") {
      descriptor = await registerMacService(event, runnerPath, logFile);
    } else {
      sendLog(
        event,
        `⚠️ Native service registration is not available for platform ${platform}`,
      );
      return { managed: false };
    }
  } catch (serviceErr) {
    sendLog(
      event,
      `❌ Failed to register native service: ${serviceErr.message}`,
    );
    return { managed: false };
  }
  descriptor.binaryPath = binaryInfo.binaryPath;
  descriptor.runnerPath =
    platform === "win32" && serviceHostPath ? serviceHostPath : runnerPath;
  descriptor.logFile = logFile;
  descriptor.platform = platform;
  writeServiceManifest(manifestRoot, descriptor);
  sendLog(
    event,
    `✅ Native BreakEven Slave service configured (${descriptor.type})`,
  );
  return { managed: true, descriptor };
}

async function configureTrayService(event, paths, options = {}) {
  const { clientServiceDir, logsDir, manifestRoot, rootPath } = paths;
  const platform = process.platform;
  const binaryInfo = await resolveTrayBinary(platform, clientServiceDir, event);
  if (!binaryInfo) {
    sendLog(
      event,
      `⚠️ No native BreakEven Tray binary found for platform ${platform}. Falling back to script launch.`,
    );
    return { managed: false };
  }

  fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, "breakeven_tray.log");
  const runnerPath = createTrayRunnerScript(
    platform,
    clientServiceDir,
    binaryInfo.binaryPath,
    logFile,
  );
  let serviceHostPath = null;

  let descriptor;
  try {
    if (platform === "win32") {
      serviceHostPath = await ensureWindowsServiceHost(event, clientServiceDir);
      descriptor = await registerWindowsService(
        event,
        serviceHostPath,
        binaryInfo.binaryPath,
        logFile,
        {
          serviceName: "BreakEvenTray",
          displayName: "BreakEven Tray",
          description: "BreakEven tray application",
          autoStart: options.autoStart,
          startImmediately: options.startImmediately,
        },
      );
    } else if (platform === "linux") {
      descriptor = await registerLinuxService(event, runnerPath, rootPath, {
        serviceName: "breakeven-tray",
        description: "BreakEven Tray application",
      });
    } else if (platform === "darwin") {
      descriptor = await registerMacService(event, runnerPath, logFile, {
        label: "com.breakeven.tray",
      });
    } else {
      sendLog(
        event,
        `⚠️ Native tray service registration is not available for platform ${platform}`,
      );
      return { managed: false };
    }
  } catch (serviceErr) {
    sendLog(
      event,
      `❌ Failed to register native tray service: ${serviceErr.message}`,
    );
    return { managed: false };
  }

  descriptor.binaryPath = binaryInfo.binaryPath;
  descriptor.runnerPath =
    platform === "win32" && serviceHostPath ? serviceHostPath : runnerPath;
  descriptor.logFile = logFile;
  descriptor.platform = platform;
  writeServiceManifest(manifestRoot, descriptor, {
    fileName: "tray_service_manifest.json",
    name: "breakeven_tray",
  });
  sendLog(
    event,
    `✅ Native BreakEven Tray service configured (${descriptor.type})`,
  );
  return { managed: true, descriptor };
}

async function configureUpdaterService(event, paths, options = {}) {
  const { clientServiceDir, logsDir, manifestRoot, rootPath } = paths;
  const platform = process.platform;
  const binaryInfo = await resolveUpdaterBinary(
    platform,
    clientServiceDir,
    event,
  );
  if (!binaryInfo) {
    sendLog(
      event,
      `⚠️ No native BreakEven Updater binary found for platform ${platform}. Falling back to script launch.`,
    );
    return { managed: false };
  }

  fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, "breakeven_updater.log");
  const runnerPath = createUpdaterRunnerScript(
    platform,
    clientServiceDir,
    binaryInfo.binaryPath,
    logFile,
  );
  let serviceHostPath = null;

  let descriptor;
  try {
    if (platform === "win32") {
      serviceHostPath = await ensureWindowsServiceHost(event, clientServiceDir);
      descriptor = await registerWindowsService(
        event,
        serviceHostPath,
        binaryInfo.binaryPath,
        logFile,
        {
          serviceName: "BreakEvenUpdater",
          displayName: "BreakEven Updater",
          description: "BreakEven updater service",
          autoStart: options.autoStart,
          startImmediately: options.startImmediately,
          runAsLocalSystem: true,
        },
      );
    } else if (platform === "linux") {
      descriptor = await registerLinuxService(event, runnerPath, rootPath, {
        serviceName: "breakeven-updater",
        description: "BreakEven updater service",
      });
    } else if (platform === "darwin") {
      descriptor = await registerMacService(event, runnerPath, logFile, {
        label: "com.breakeven.updater",
      });
    } else {
      sendLog(
        event,
        `⚠️ Native updater service registration is not available for platform ${platform}`,
      );
      return { managed: false };
    }
  } catch (serviceErr) {
    sendLog(
      event,
      `❌ Failed to register native updater service: ${serviceErr.message}`,
    );
    return { managed: false };
  }

  descriptor.binaryPath = binaryInfo.binaryPath;
  descriptor.runnerPath =
    platform === "win32" && serviceHostPath ? serviceHostPath : runnerPath;
  descriptor.logFile = logFile;
  descriptor.platform = platform;
  writeServiceManifest(manifestRoot, descriptor, {
    fileName: "updater_service_manifest.json",
    name: "breakeven_updater",
  });
  sendLog(
    event,
    `✅ Native BreakEven Updater service configured (${descriptor.type})`,
  );
  return { managed: true, descriptor };
}

ipcMain.handle("start-installation", async (event, installData) => {
  const acceptedTerms = installData.termsAcceptance;
  if (!acceptedTerms || !acceptedTerms.acceptanceId) {
    return {
      success: false,
      error: "Terms & Conditions must be accepted before installation.",
    };
  }

  const recordedAcceptance = acceptanceReceipts.get(acceptedTerms.acceptanceId);
  if (!recordedAcceptance) {
    return {
      success: false,
      error:
        "Terms acceptance could not be verified. Please review and accept the Terms & Conditions again.",
    };
  }

  const currentTerms = loadTermsDocument();
  const normalizedName = String(installData.name || "").trim();
  const normalizedEmail = String(installData.email || "").trim();

  if (recordedAcceptance.name !== normalizedName) {
    return {
      success: false,
      error:
        "The name changed after Terms acceptance. Please accept the Terms & Conditions again.",
    };
  }

  if ((recordedAcceptance.email || "") !== normalizedEmail) {
    return {
      success: false,
      error:
        "The email changed after Terms acceptance. Please accept the Terms & Conditions again.",
    };
  }

  if (recordedAcceptance.termsHash !== currentTerms.termsHash) {
    return {
      success: false,
      error:
        "The Terms & Conditions were updated. Please review and accept the latest version before installing.",
    };
  }

  const selectedPathValidation = validateInstallPathInput(
    installData.installPath,
  );
  if (!selectedPathValidation.valid) {
    return {
      success: false,
      error: selectedPathValidation.error,
    };
  }

  const selectedPath = selectedPathValidation.normalizedPath;
  const normalized = selectedPath.replace(/\\/g, "/");
  const destinationPath = normalized.endsWith("/BreakEvenClient")
    ? selectedPath
    : path.join(selectedPath, "BreakEvenClient");

  const envName = "breakeven_env";
  const clientConfig = {
    version: "0.0.0.0",
    name: installData.name,
    email: installData.email,
    buffer_cores: 6,
    installPath: destinationPath,
    serviceInstallPath: destinationPath,
    runTrayOnStartup: !!installData.runTrayOnStartup,
    runSlaveOnStartup: !!installData.runSlaveOnStartup,
    runAsRoot: !!installData.runAsRoot,
    autoUpdate: !!installData.autoUpdate,
    openDashboard: !!installData.openDashboard,
  };

  const configPathGUI = path.join(
    destinationPath,
    "installer_gui",
    "client_config.json",
  );
  const configPathRoot = path.join(destinationPath, "client_config.json");
  const sourceTemplate = path.join(__dirname, "BreakEvenClient_Template");
  const minicondaExe = path.join(
    destinationPath,
    "miniconda_installer",
    "Miniconda3-latest-Windows-x86_64.exe",
  );
  const minicondaTargetDir = path.join(destinationPath, "Miniconda3");
  const zipPath = getTemplateZipPath();

  let envCreated = false;
  let trayServiceInfo = { managed: false };
  let slaveServiceInfo = { managed: false };
  let updaterServiceInfo = { managed: false };
  let servicePaths = buildServicePathPlan(destinationPath);
  const skipPythonSetup = true; // temporary: skip Miniconda/env provisioning

  try {
    if (!zipPath) {
      throw new Error(
        "Unable to locate BreakEvenClient_Template.zip in the packaged installer resources.",
      );
    }

    sendProgress(event, 0);
    sendLog(
      event,
      `📝 Terms accepted by ${recordedAcceptance.name}${recordedAcceptance.email ? ` <${recordedAcceptance.email}>` : ""} at ${recordedAcceptance.acceptedAt} (version ${recordedAcceptance.termsVersion})`,
    );

    /*
        sendLog(event, `📁 Copying template to ${destinationPath}`);
        await fsExtra.copy(sourceTemplate, destinationPath, {
            filter: src => {
                sendLog(event, `Copying: ${path.relative(sourceTemplate, src)}`);
                return true;
            }
        });
        */

    /*
        const zipPath = path.join(__dirname, 'BreakEvenClient_Template.zip');
        sendLog(event, `📦 Extracting template from ${zipPath} to ${destinationPath}`);

        try {
            const zip = new AdmZip(zipPath);
            zip.extractAllTo(destinationPath, true);
            sendLog(event, `✅ Template extracted successfully.`);
        } catch (zipErr) {
            throw new Error(`❌ Failed to extract template: ${zipErr.message}`);
        }
        */

    //const zipPath = path.join(__dirname, 'BreakEvenClient_Template.zip');
    sendLog(
      event,
      `📦 Extracting template from ${zipPath} to ${destinationPath}`,
    );

    try {
      await extractZipToDirectory(zipPath, destinationPath, {
        stripSingleTopLevelFolder: true,
        event,
      });
      await flattenExtractedTemplateRoot(destinationPath);

      sendLog(event, `✅ Template extracted successfully.`);
    } catch (zipErr) {
      throw new Error(`❌ Failed to extract template: ${zipErr.message}`);
    }

    if (process.platform === "win32") {
      const elevated = await isWindowsAdministrator();
      if (!elevated) {
        throw new Error(
          "Windows service registration requires Administrator privileges. Relaunch the installer with 'Run as Administrator' and retry.",
        );
      }
    }

    sendProgress(event, 20);
    if (
      process.platform === "win32" ||
      clientConfig.runSlaveOnStartup ||
      clientConfig.runTrayOnStartup ||
      clientConfig.autoUpdate
    ) {
      servicePaths = prepareServicePayloadPaths(event, destinationPath);
    }
    clientConfig.serviceInstallPath = servicePaths.rootPath;

    const serializedConfig = JSON.stringify(clientConfig, null, 2);
    fs.mkdirSync(path.dirname(configPathGUI), { recursive: true });
    fs.writeFileSync(configPathGUI, serializedConfig);
    fs.writeFileSync(configPathRoot, serializedConfig);

    if (servicePaths?.rootPath) {
      const elevatedConfigPath = path.join(
        servicePaths.rootPath,
        "client_config.json",
      );
      if (
        path.resolve(elevatedConfigPath) !== path.resolve(configPathRoot) ||
        !fs.existsSync(elevatedConfigPath)
      ) {
        try {
          fs.mkdirSync(servicePaths.rootPath, { recursive: true });
          fs.writeFileSync(elevatedConfigPath, serializedConfig);
          sendLog(
            event,
            `✅ client_config.json copied to elevated path ${elevatedConfigPath}`,
          );
        } catch (cfgErr) {
          sendLog(
            event,
            `⚠️ Failed to copy client_config.json to elevated path ${servicePaths.rootPath}: ${cfgErr.message}`,
          );
        }
      }
    }

    if (process.platform === "win32") {
      const systemTemp = path.join(
        process.env.SystemRoot || "C:/Windows",
        "Temp",
        "client_config.json",
      );
      try {
        fs.mkdirSync(path.dirname(systemTemp), { recursive: true });
        fs.writeFileSync(systemTemp, serializedConfig);
        sendLog(
          event,
          `✅ client_config.json copied to system temp for service access (${systemTemp})`,
        );
      } catch (tempErr) {
        sendLog(
          event,
          `⚠️ Failed to copy client_config.json to system temp: ${tempErr.message}`,
        );
      }
    }

    sendLog(event, `✅ client_config.json saved`);

    if (process.platform === "win32" || clientConfig.runTrayOnStartup) {
      trayServiceInfo = await configureTrayService(event, servicePaths, {
        autoStart: clientConfig.runTrayOnStartup,
        startImmediately: clientConfig.runTrayOnStartup,
      });
    } else {
      sendLog(
        event,
        "ℹ️ Tray auto-start disabled by user; skipping native service registration.",
      );
    }

    if (process.platform === "win32" || clientConfig.runSlaveOnStartup) {
      slaveServiceInfo = await configureSlaveService(event, servicePaths, {
        autoStart: clientConfig.runSlaveOnStartup,
        startImmediately: clientConfig.runSlaveOnStartup,
      });
    } else {
      sendLog(
        event,
        "ℹ️ Slave auto-start disabled by user; skipping native service registration.",
      );
    }

    if (process.platform === "win32" || clientConfig.autoUpdate) {
      updaterServiceInfo = await configureUpdaterService(event, servicePaths, {
        autoStart: clientConfig.autoUpdate,
        startImmediately: clientConfig.autoUpdate,
      });
    } else {
      sendLog(
        event,
        "ℹ️ Updater auto-start disabled by user; skipping native service registration.",
      );
    }

    if (
      trayServiceInfo.managed ||
      slaveServiceInfo.managed ||
      updaterServiceInfo.managed
    ) {
      sendProgress(event, 25);
    }

    if (process.platform === "win32") {
      const failedServices = [];
      if (!trayServiceInfo.managed) failedServices.push("Tray");
      if (!slaveServiceInfo.managed) failedServices.push("Slave");
      if (!updaterServiceInfo.managed) failedServices.push("Updater");

      if (failedServices.length) {
        throw new Error(
          `Required Windows services were not registered: ${failedServices.join(", ")}. Run the installer as Administrator and retry.`,
        );
      }
    }

    if (skipPythonSetup) {
      sendLog(
        event,
        "⏭️ Skipping Miniconda setup and Python requirements (temporarily disabled)",
      );
    } else {
      sendProgress(event, 30);
      const condaExpectedPath = path.join(
        minicondaTargetDir,
        "Scripts",
        "conda.exe",
      );
      if (!fs.existsSync(condaExpectedPath)) {
        sendLog(event, `⚙ Installing Miniconda...`);
        await new Promise((resolve, reject) => {
          const installer = spawn(
            minicondaExe,
            [
              "/S",
              "/InstallationType=JustMe",
              "/AddToPath=0",
              "/RegisterPython=0",
              `/D=${minicondaTargetDir}`,
            ],
            { detached: true, stdio: "ignore", windowsHide: true },
          );

          installer.on("close", (code) => {
            if (code === 0) {
              sendLog(event, `✅ Miniconda installed`);
              resolve();
            } else
              reject(new Error(`Miniconda installer exited with code ${code}`));
          });
          installer.on("error", reject);
        });
      } else sendLog(event, `✅ Miniconda already installed`);

      sendProgress(event, 60);
      const condaPath = path.join(minicondaTargetDir, "Scripts", "conda.exe");
      const requirementsPath = path.join(
        destinationPath,
        "client_service",
        "requirements.txt",
      );

      sendLog(event, `📦 Creating Conda env: ${envName}`);
      await new Promise((resolve, reject) => {
        execFile(
          condaPath,
          ["create", "-y", "-n", envName, "python=3.10"],
          (err) => {
            if (err)
              return reject(new Error("Failed to create Conda env: " + err));
            sendLog(event, `✅ Conda env created`);
            envCreated = true;
            resolve();
          },
        );
      });

      sendProgress(event, 85);
      sendLog(event, `📥 Installing requirements`);
      await new Promise((resolve, reject) => {
        execFile(
          condaPath,
          ["run", "-n", envName, "pip", "install", "-r", requirementsPath],
          (err, stdout, stderr) => {
            if (err) {
              sendLog(
                event,
                `❌ Failed to install Python requirements: ${stderr || err.message}`,
              );
              return reject(
                new Error("Python requirements installation failed."),
              );
            }
            sendLog(event, `✅ Python requirements installed`);
            sendLog(event, `📦 stdout:\n${stdout}`);
            resolve();
          },
        );
      });
    }

    const servicesToLaunch = [];
    if (skipPythonSetup) {
      sendLog(
        event,
        "⏭️ Skipping Tray/Updater launch because Python env is disabled",
      );
    } else {
      if (clientConfig.runTrayOnStartup) {
        if (trayServiceInfo.managed) {
          sendLog(
            event,
            `🟢 Tray managed via native ${trayServiceInfo.descriptor?.type || "service"}; runtime launch delegated to the OS.`,
          );
        } else {
          const trayScript = path.join(
            destinationPath,
            "client_service",
            "tray_app.py",
          );
          if (fs.existsSync(trayScript)) {
            await LaunchService(event, "Tray", trayScript, destinationPath);
            servicesToLaunch.push({ name: "tray_app", script: trayScript });
          } else {
            throw new Error(`Tray script not found at ${trayScript}`);
          }
        }
      }

      if (clientConfig.runSlaveOnStartup) {
        if (slaveServiceInfo.managed) {
          sendLog(
            event,
            `🟢 Slave managed via native ${slaveServiceInfo.descriptor?.type || "service"}; runtime launch delegated to the OS.`,
          );
        } else {
          const slaveScript = path.join(
            destinationPath,
            "client_service",
            "Breakeven_Slave.py",
          );

          if (fs.existsSync(slaveScript)) {
            try {
              await LaunchService(event, "Slave", slaveScript, destinationPath);
              servicesToLaunch.push({ name: "slave_bot", script: slaveScript });
            } catch (err) {
              sendLog(event, `❌ Slave failed to start: ${err.message}`);
              // Not fatal — let the installation proceed
            }
          } else {
            sendLog(event, `❌ Slave script not found at ${slaveScript}`);
          }
        }
      }

      if (clientConfig.autoUpdate) {
        if (updaterServiceInfo.managed) {
          sendLog(
            event,
            `🟢 Updater managed via native ${updaterServiceInfo.descriptor?.type || "service"}; runtime launch delegated to the OS.`,
          );
        } else {
          const updaterScript = path.join(
            destinationPath,
            "client_service",
            "updater.py",
          );
          if (fs.existsSync(updaterScript)) {
            try {
              await LaunchService(
                event,
                "Updater",
                updaterScript,
                destinationPath,
              );
              makeAutoStartScript(
                updaterScript,
                "updater_service",
                destinationPath,
              );
              sendLog(event, `⚙️ AutoStart set for updater_service`);
            } catch (err) {
              sendLog(event, `❌ Updater failed to start: ${err.message}`);
            }
          } else {
            sendLog(event, `❌ Updater script not found at ${updaterScript}`);
          }
        }
      }

      for (const service of servicesToLaunch) {
        makeAutoStartScript(service.script, service.name, destinationPath);
        sendLog(event, `⚙️ AutoStart set for ${service.name}`);
      }
    }

    sendProgress(event, 100);
    sendLog(event, `🎉 Installation completed successfully`);

    /*
        if (clientConfig.openDashboard) {
            const dashboardPath = path.join(destinationPath, 'dashboard_gui');
            const electronBinary = path.join(destinationPath, 'Miniconda3', 'Scripts', 'electron.cmd');

            if (fs.existsSync(path.join(dashboardPath, 'src/index.js'))) {
                sendLog(event, `🚀 Launching Dashboard from ${dashboardPath}`);
                try {
                    spawn(electronBinary, ['.'], {
                        cwd: dashboardPath,
                        detached: true,
                        stdio: 'ignore',
                        windowsHide: true
                    });
                } catch (err) {
                    sendLog(event, `❌ Failed to launch dashboard: ${err.message}`);
                }
            } else {
                sendLog(event, `❌ Dashboard not found at ${dashboardPath}`);
            }
        }
        */
    if (clientConfig.openDashboard) {
      launchDashboardAfterInstall(event, destinationPath);
    }

    return { success: true };
  } catch (err) {
    let errorMessage = err.message;
    if (envCreated) {
      await cleanupCondaEnv(destinationPath, envName, event);
    }
    if (
      errorMessage.includes("EPERM") ||
      errorMessage.includes("permission denied")
    ) {
      errorMessage +=
        "\n⚠️ Access Denied. Run installer as admin or use a writeable folder.";
      sendLog(event, `⚠️ Suggestion: Use 'Run as Administrator'`);
    }
    sendLog(event, `❌ Error: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
});

ipcMain.handle("window-close", () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.close();
});
ipcMain.handle("window-minimize", () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.minimize();
});
