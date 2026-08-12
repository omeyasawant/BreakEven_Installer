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
    const squirrelArgs = process.argv
      .slice(1)
      .filter(
        (value) => typeof value === "string" && value.startsWith("--squirrel-"),
      );
    const shouldQuitForSquirrelEvent = squirrelArgs.some(
      (value) =>
        value === "--squirrel-uninstall" || value === "--squirrel-obsolete",
    );

    if (shouldQuitForSquirrelEvent) {
      app.quit();
      return;
    }

    if (squirrelArgs.length) {
      console.log(
        `[Electron] continuing startup for Squirrel args: ${squirrelArgs.join(",")}`,
      );
    }
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
const { execFile, spawn } = require("child_process");
const readline = require("readline");
const {
  validateNameAndEmail,
  validateBufferCores,
  validateSolanaWalletAddress,
} = require("./installValidation");

const TERMS_FILE_NAME = "terms-and-conditions.txt";
const ELEVATED_LAUNCH_ARG = "--elevated-launch";
const BOOTSTRAPPER_ELEVATED_LAUNCH_ARG = "--bootstrapper-elevated-launch";
const CLI_FLAG = "--cli";
const CLI_INSTALL_COMMAND = "install";
const CLI_DEFAULT_BUFFER_CORES = 4;
const GUI_DEFAULT_BUFFER_CORES = 6;
const CLI_YES_RESPONSES = new Set(["y", "yes"]);
const CLI_NO_RESPONSES = new Set(["n", "no"]);
const acceptanceReceipts = new Map();
let mainWindow = null;

function parseCliBoolean(optionName, rawValue) {
  if (rawValue === undefined) {
    return { valid: true, value: true };
  }

  const normalized = String(rawValue).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return { valid: true, value: true };
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return { valid: true, value: false };
  }

  return {
    valid: false,
    error: `${optionName} must be true or false.`,
  };
}

function parseCliYesNoResponse(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return null;
  }
  if (CLI_YES_RESPONSES.has(normalized)) {
    return true;
  }
  if (CLI_NO_RESPONSES.has(normalized)) {
    return false;
  }
  return null;
}

function promptCliLine(promptText) {
  return new Promise((resolve, reject) => {
    const cli = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    cli.on("SIGINT", () => {
      cli.close();
      reject(new Error("Terms acceptance prompt cancelled."));
    });

    cli.question(promptText, (answer) => {
      cli.close();
      resolve(answer);
    });
  });
}

async function promptCliYesNo(questionText, defaultValue = false) {
  const promptSuffix = defaultValue ? " [Y/n] " : " [y/N] ";

  while (true) {
    const answer = await promptCliLine(`${questionText}${promptSuffix}`);
    const trimmedAnswer = String(answer || "").trim();
    if (!trimmedAnswer) {
      return defaultValue;
    }

    const parsed = parseCliYesNoResponse(trimmedAnswer);
    if (parsed !== null) {
      return parsed;
    }

    console.log("Please answer yes or no.");
  }
}

function printCliTermsDocument(termsDocument) {
  const content = String(termsDocument?.content || "").trimEnd();
  const lines = [
    "",
    "----- Begin Terms & Conditions -----",
    content,
    "----- End Terms & Conditions -----",
    "",
  ];
  process.stdout.write(`${lines.join(os.EOL)}${os.EOL}`);
}

function buildWalletConfigEntry(address) {
  if (!address) {
    return null;
  }

  return {
    address,
    label: "Wallet",
    source: "manual",
    chain: "solana",
    verified_at: null,
  };
}

function parseCliInvocation(argv) {
  const cliIndex = argv.indexOf(CLI_FLAG);
  if (cliIndex === -1) {
    return { isCliMode: false };
  }

  const tokens = argv.slice(cliIndex + 1);
  if (!tokens.length || tokens[0] === "--help" || tokens[0] === "-h") {
    return { isCliMode: true, usageRequested: true };
  }

  const command = tokens[0];
  if (command !== CLI_INSTALL_COMMAND) {
    return {
      isCliMode: true,
      error: `Unsupported CLI command: ${command}`,
    };
  }

  const options = {};
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      return {
        isCliMode: true,
        command,
        error: `Unexpected argument: ${token}`,
      };
    }

    const nextToken = tokens[index + 1];
    const hasValue = nextToken !== undefined && !nextToken.startsWith("--");
    const rawValue = hasValue ? nextToken : undefined;

    switch (token) {
      case "--help":
      case "-h":
        return { isCliMode: true, usageRequested: true };
      case "--name":
        if (!hasValue) {
          return {
            isCliMode: true,
            command,
            error: "--name requires a value.",
          };
        }
        options.name = rawValue;
        index += 1;
        break;
      case "--email":
        if (!hasValue) {
          return {
            isCliMode: true,
            command,
            error: "--email requires a value.",
          };
        }
        options.email = rawValue;
        index += 1;
        break;
      case "--install-path":
        if (!hasValue) {
          return {
            isCliMode: true,
            command,
            error: "--install-path requires a value.",
          };
        }
        options.installPath = rawValue;
        index += 1;
        break;
      case "--buffer_cores":
      case "--buffer-cores":
        if (!hasValue) {
          return {
            isCliMode: true,
            command,
            error: `${token} requires a value between 0 and 100.`,
          };
        }
        options.bufferCores = rawValue;
        index += 1;
        break;
      case "--default-solana-wallet":
      case "--default-payout-wallet":
        if (!hasValue) {
          return {
            isCliMode: true,
            command,
            error: `${token} requires a Solana public address value.`,
          };
        }
        options.defaultSolanaWallet = rawValue;
        index += 1;
        break;
      case "--accept-terms":
        options.acceptTerms = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--add-shortcuts": {
        const parsed = parseCliBoolean("--add-shortcuts", rawValue);
        if (!parsed.valid) {
          return { isCliMode: true, command, error: parsed.error };
        }
        options.addShortcuts = parsed.value;
        if (hasValue) {
          index += 1;
        }
        break;
      }
      case "--run-tray": {
        const parsed = parseCliBoolean("--run-tray", rawValue);
        if (!parsed.valid) {
          return { isCliMode: true, command, error: parsed.error };
        }
        options.runTrayOnStartup = parsed.value;
        if (hasValue) {
          index += 1;
        }
        break;
      }
      case "--run-slave": {
        const parsed = parseCliBoolean("--run-slave", rawValue);
        if (!parsed.valid) {
          return { isCliMode: true, command, error: parsed.error };
        }
        options.runSlaveOnStartup = parsed.value;
        if (hasValue) {
          index += 1;
        }
        break;
      }
      case "--run-updater": {
        const parsed = parseCliBoolean("--run-updater", rawValue);
        if (!parsed.valid) {
          return { isCliMode: true, command, error: parsed.error };
        }
        options.autoUpdate = parsed.value;
        if (hasValue) {
          index += 1;
        }
        break;
      }
      case "--open-dashboard": {
        const parsed = parseCliBoolean("--open-dashboard", rawValue);
        if (!parsed.valid) {
          return { isCliMode: true, command, error: parsed.error };
        }
        options.openDashboard = parsed.value;
        if (hasValue) {
          index += 1;
        }
        break;
      }
      case "--run-as-root":
      case "--run-as-admin": {
        const parsed = parseCliBoolean(token, rawValue);
        if (!parsed.valid) {
          return { isCliMode: true, command, error: parsed.error };
        }
        options.runAsRoot = parsed.value;
        if (hasValue) {
          index += 1;
        }
        break;
      }
      default:
        return {
          isCliMode: true,
          command,
          error: `Unknown option: ${token}`,
        };
    }
  }

  return { isCliMode: true, command, options };
}

function getCliUsageText() {
  const executableName = path.basename(
    process.execPath || "breakeveninstaller",
  );
  return [
    `Usage: ${executableName} --cli install --name <value> --install-path <absolute-path> [--accept-terms] [options]`,
    "",
    "Required:",
    "  --name <value>                Installer name value.",
    "  --install-path <path>         Absolute installation directory path.",
    "",
    "Optional:",
    "  --accept-terms                Skip the interactive Terms & Conditions prompt.",
    `  --email <value>               Optional email. Default: empty string.`,
    "  --default-solana-wallet <key> Optional Solana payout wallet public address.",
    "  --add-shortcuts [true|false]  Default: true.",
    "  --run-tray [true|false]       Default: true.",
    "  --run-slave [true|false]      Default: true.",
    "  --run-updater [true|false]    Default: true.",
    "  --open-dashboard [true|false] Default: false.",
    "  --run-as-root [true|false]    Default: true.",
    `  --buffer_cores <0-100>        Default: ${CLI_DEFAULT_BUFFER_CORES}.`,
    "  --dry-run                     Validate inputs and resolved paths only.",
  ].join(os.EOL);
}

function buildCliInstallRequest(options = {}) {
  const installPath = String(options.installPath || "").trim();
  const identityValidation = validateNameAndEmail(options.name, options.email);
  if (!identityValidation.valid) {
    return {
      success: false,
      error: identityValidation.nameError || identityValidation.emailError,
    };
  }

  if (!installPath) {
    return {
      success: false,
      error:
        "--install-path is required and must be an absolute installation directory path.",
    };
  }

  const pathValidation = validateInstallPathInput(installPath);
  if (!pathValidation.valid) {
    return { success: false, error: pathValidation.error };
  }

  const bufferValidation = validateBufferCores(
    options.bufferCores,
    CLI_DEFAULT_BUFFER_CORES,
  );
  if (!bufferValidation.valid) {
    return { success: false, error: bufferValidation.error };
  }

  const walletValidation = validateSolanaWalletAddress(
    options.defaultSolanaWallet,
    {
      allowEmpty: true,
      optionName: "--default-solana-wallet",
    },
  );
  if (!walletValidation.valid) {
    return { success: false, error: walletValidation.error };
  }

  return {
    success: true,
    installData: {
      name: identityValidation.normalizedName,
      email: identityValidation.normalizedEmail,
      defaultSolanaWallet: walletValidation.value || "",
      installPath: pathValidation.normalizedPath,
      addShortcuts: options.addShortcuts ?? true,
      runTrayOnStartup: options.runTrayOnStartup ?? true,
      runSlaveOnStartup: options.runSlaveOnStartup ?? true,
      runAsRoot: options.runAsRoot ?? true,
      autoUpdate: options.autoUpdate ?? true,
      openDashboard: options.openDashboard ?? false,
      bufferCores: bufferValidation.value,
    },
    acceptTerms: options.acceptTerms === true,
    dryRun: options.dryRun === true,
  };
}

function resolveDestinationInstallPath(selectedPath) {
  const normalized = String(selectedPath || "").replace(/\\/g, "/");
  return normalized.endsWith("/BreakEvenClient")
    ? selectedPath
    : path.join(selectedPath, "BreakEvenClient");
}

function validateCliTermsAcceptancePreview(
  installData,
  { acceptanceMode = "validated-only", termsDocument = null } = {},
) {
  if (!installData) {
    return {
      success: false,
      error: "CLI install data is required for terms validation.",
    };
  }

  const resolvedTermsDocument = termsDocument || loadTermsDocument();
  return {
    success: true,
    summary: {
      acceptedName: installData.name,
      acceptedEmail: installData.email || "",
      termsVersion: resolvedTermsDocument.termsVersion,
      termsHash: resolvedTermsDocument.termsHash,
      lastUpdated: resolvedTermsDocument.lastUpdated || null,
      acceptanceMode,
    },
  };
}

function buildCliDryRunSummary(cliRequest, termsSummary) {
  const installData = cliRequest.installData;
  const walletEntry = buildWalletConfigEntry(installData.defaultSolanaWallet);
  const destinationPath = resolveDestinationInstallPath(
    installData.installPath,
  );
  const systemServiceRoot = getSystemServiceRoot();
  const plannedServiceInstallPath =
    systemServiceRoot &&
    path.resolve(systemServiceRoot) !== path.resolve(destinationPath)
      ? systemServiceRoot
      : destinationPath;

  return {
    mode: "dry-run",
    validation: "ok",
    platform: process.platform,
    terms: termsSummary,
    inputs: {
      name: installData.name,
      email: installData.email,
      defaultSolanaWallet: installData.defaultSolanaWallet || null,
      installPath: installData.installPath,
      addShortcuts: installData.addShortcuts,
      runTrayOnStartup: installData.runTrayOnStartup,
      runSlaveOnStartup: installData.runSlaveOnStartup,
      runAsRoot: installData.runAsRoot,
      autoUpdate: installData.autoUpdate,
      openDashboard: installData.openDashboard,
      buffer_cores: installData.bufferCores,
    },
    configPreview: {
      wallets: walletEntry ? [walletEntry] : [],
      default_payout_wallet: walletEntry ? walletEntry.address : null,
      phantom_app_id: null,
    },
    resolvedPaths: {
      selectedInstallPath: installData.installPath,
      destinationPath,
      plannedServiceInstallPath,
      rootClientConfigPath: path.join(destinationPath, "client_config.json"),
      guiClientConfigPath: path.join(
        destinationPath,
        "installer_gui",
        "client_config.json",
      ),
    },
  };
}

async function resolveCliTermsAcceptance(cliRequest) {
  const termsDocument = loadTermsDocument();

  if (cliRequest.acceptTerms) {
    return {
      success: true,
      termsDocument,
      acceptanceMode: "cli-flag",
    };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return {
      success: false,
      error:
        "Terms & Conditions must be accepted with --accept-terms, or run the installer in an interactive terminal to review and accept them.",
    };
  }

  const shouldReadTerms = await promptCliYesNo(
    "Would you like to read the Terms & Conditions before continuing?",
    false,
  );

  if (shouldReadTerms) {
    printCliTermsDocument(termsDocument);
  }

  const accepted = await promptCliYesNo(
    "Do you accept the Terms & Conditions?",
    false,
  );

  if (!accepted) {
    return {
      success: false,
      error: "Terms & Conditions were not accepted.",
    };
  }

  return {
    success: true,
    termsDocument,
    acceptanceMode: shouldReadTerms
      ? "interactive-read-and-accepted"
      : "interactive-accepted",
  };
}

const cliInvocation = parseCliInvocation(process.argv);
const isCliMode = cliInvocation.isCliMode;

if (isCliMode) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("log-level", "3");
}

let hasSingleInstanceLock = true;

if (!isCliMode) {
  hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      if (!mainWindow) {
        return;
      }

      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }

      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }

      mainWindow.focus();
    });
  }
}

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
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  // ✅ Append launch log
  //const launchLogPath = path.join(app.getPath('userData'), 'launch.log');
  //fs.appendFileSync(launchLogPath, `App launched at ${new Date().toISOString()}\n`);

  const { screen } = require("electron");
  const primaryDisplay = screen.getPrimaryDisplay();
  const width = Math.floor(primaryDisplay.size.width * 0.75);
  const height = Math.floor(primaryDisplay.size.height * 0.75);

  mainWindow = new BrowserWindow({
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

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.removeMenu();
  console.log("[Electron] Installer window launched in production mode");
  return mainWindow;
}

function escapePowerShellString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

async function relaunchInstallerElevated() {
  if (process.platform !== "win32") {
    return false;
  }

  const filePath = process.execPath;
  const argumentList = process.argv
    .slice(1)
    .filter((arg) => arg !== ELEVATED_LAUNCH_ARG);
  argumentList.push(ELEVATED_LAUNCH_ARG);
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

function wasLaunchedFromElevatedBootstrapper() {
  return process.argv.includes(BOOTSTRAPPER_ELEVATED_LAUNCH_ARG);
}

app.whenReady().then(async () => {
  if (!isCliMode && !hasSingleInstanceLock) {
    return;
  }

  if (isCliMode && (cliInvocation.usageRequested || cliInvocation.error)) {
    if (cliInvocation.error) {
      console.error(cliInvocation.error);
      console.error("");
    }
    console.log(getCliUsageText());
    app.exit(cliInvocation.error ? 1 : 0);
    return;
  }

  const shouldSkipWindowsElevation =
    isCliMode && cliInvocation.options?.dryRun === true;

  if (
    process.platform === "win32" &&
    !shouldSkipWindowsElevation &&
    !wasLaunchedFromElevatedBootstrapper()
  ) {
    const elevated = await isWindowsAdministrator();
    if (!elevated) {
      try {
        console.log(
          "[Electron] Relaunching installer with Administrator privileges",
        );
        if (!isCliMode) {
          app.releaseSingleInstanceLock();
        }
        await relaunchInstallerElevated();
        app.quit();
        return;
      } catch (error) {
        if (!app.requestSingleInstanceLock()) {
          app.quit();
          return;
        }
        console.error(
          "[Electron] Failed to relaunch installer elevated:",
          error.message,
        );
      }
    }
  }

  if (isCliMode) {
    const exitCode = await runCliInstallCommand(cliInvocation);
    app.exit(exitCode);
    return;
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
  if (event?.sender?.send) {
    event.sender.send("install-log", message);
  }
}
function sendProgress(event, percent) {
  if (event?.sender?.send) {
    event.sender.send("install-progress", percent);
    return;
  }

  console.log(`[Progress] ${percent}%`);
}

function resolveExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function ensureExecutablePermissions(executablePath) {
  if (!executablePath) {
    return executablePath;
  }

  try {
    fs.chmodSync(executablePath, 0o755);
  } catch (_error) {}

  return executablePath;
}

function getMacServiceSearchRoots(clientServiceDir, rootPath) {
  const serviceRoot = rootPath || path.resolve(clientServiceDir, "..");
  const systemRoot = getSystemServiceRoot();
  const explicitRoots = [
    clientServiceDir,
    path.join(serviceRoot, "client_service"),
    serviceRoot,
    systemRoot ? path.join(systemRoot, "client_service") : null,
    systemRoot,
    "/Applications",
    path.join("/Applications", "BreakEvenClient"),
    path.join(os.homedir(), "Applications"),
    path.join(os.homedir(), "Applications", "BreakEvenClient"),
    "/Library/Application Support/BreakEvenClient",
    "/Library/Application Support/BreakEvenClient/client_service",
    "/Library/Application Support/BreakEvenClient/updater_runtime",
  ].filter(Boolean);

  return [
    ...new Set(explicitRoots.map((candidate) => path.resolve(candidate))),
  ];
}

function buildMacPayloadPathCandidates(clientServiceDir, rootPath, entryName) {
  return getMacServiceSearchRoots(clientServiceDir, rootPath).map((root) =>
    path.join(root, entryName),
  );
}

function findMacPayloadInstallTarget(
  clientServiceDir,
  rootPath,
  appNamePattern,
  binaryNamePattern,
) {
  const searchRoots = getMacServiceSearchRoots(clientServiceDir, rootPath);
  const visited = new Set();
  const queue = searchRoots.map((rootPathValue) => ({
    path: rootPathValue,
    depth: 0,
  }));

  while (queue.length) {
    const current = queue.shift();
    if (!current || !current.path || visited.has(current.path)) {
      continue;
    }
    visited.add(current.path);

    if (!fs.existsSync(current.path)) {
      continue;
    }

    const stats = fs.statSync(current.path);
    if (stats.isFile()) {
      if (binaryNamePattern.test(path.basename(current.path))) {
        return current.path;
      }
      continue;
    }

    const baseName = path.basename(current.path);
    if (appNamePattern.test(baseName)) {
      const macOsDir = path.join(current.path, "Contents", "MacOS");
      if (fs.existsSync(macOsDir)) {
        return current.path;
      }
    }

    if (current.depth >= 4) {
      continue;
    }

    for (const entry of fs.readdirSync(current.path, { withFileTypes: true })) {
      const entryPath = path.join(current.path, entry.name);
      if (entry.isDirectory()) {
        queue.push({ path: entryPath, depth: current.depth + 1 });
        continue;
      }

      if (binaryNamePattern.test(entry.name)) {
        return entryPath;
      }
    }
  }

  return null;
}

function findMacUpdaterInstallTarget(clientServiceDir, rootPath) {
  const appNamePattern = /breakeven[\s_-]?updater\.app$/i;
  const binaryNamePattern = /breakeven[\s_-]?updater$/i;
  return findMacPayloadInstallTarget(
    clientServiceDir,
    rootPath,
    appNamePattern,
    binaryNamePattern,
  );
}

function getMacPrivilegeStagingBaseDir() {
  const candidates = ["/private/tmp", "/tmp", os.tmpdir()];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return os.tmpdir();
}

function stagePathForMacPrivilegedRead(sourcePath, stagedName = null) {
  if (process.platform !== "darwin") {
    return {
      stagedPath: sourcePath,
      cleanup() {},
    };
  }

  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`Cannot stage missing macOS payload path: ${sourcePath}`);
  }

  const stats = fs.statSync(sourcePath);
  const stageRoot = fs.mkdtempSync(
    path.join(getMacPrivilegeStagingBaseDir(), "breakeveninstaller-stage-"),
  );
  const targetName = stagedName || path.basename(sourcePath);
  const stagedPath = path.join(stageRoot, targetName);

  if (stats.isDirectory()) {
    fsExtra.copySync(sourcePath, stagedPath, {
      overwrite: true,
      errorOnExist: false,
    });
  } else {
    fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
    fs.copyFileSync(sourcePath, stagedPath);
  }

  try {
    fs.chmodSync(stageRoot, 0o755);
  } catch (_error) {}

  return {
    stagedPath,
    cleanup() {
      try {
        fs.rmSync(stageRoot, { recursive: true, force: true });
      } catch (_error) {}
    },
  };
}

async function installMacPkgPayload(event, pkgPath, serviceLabel) {
  sendLog(event, `📦 Installing macOS ${serviceLabel} package ${pkgPath}`);
  const stagedPkg = stagePathForMacPrivilegedRead(
    pkgPath,
    path.basename(pkgPath),
  );
  const effectivePkgPath = stagedPkg.stagedPath || pkgPath;

  if (effectivePkgPath !== pkgPath) {
    sendLog(
      event,
      `📦 Staged macOS package for privileged install at ${effectivePkgPath}`,
    );
  }

  try {
    await execCommandWithPrivilegeFallback(
      "/usr/sbin/installer",
      ["-pkg", effectivePkgPath, "-target", "/"],
      event,
      { alwaysElevateOnFailure: true },
    );
  } finally {
    stagedPkg.cleanup();
  }

  sendLog(event, `✅ Installed macOS ${serviceLabel} package ${pkgPath}`);
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

function getWindowsOfflineTemplateZipPath() {
  if (process.platform !== "win32") {
    return null;
  }

  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(
    localAppData,
    "BreakEvenInstallerCache",
    "offline-assets",
    "BreakEvenClient_Template.zip",
  );
}

function getWindowsTemplateZipCandidatePaths() {
  if (process.platform !== "win32") {
    return [];
  }

  const templateFileName = "BreakEvenClient_Template.zip";
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const installedExeDir = path.dirname(process.execPath || "");
  const installRoots = new Set([
    installedExeDir,
    path.join(localAppData, "breakeveninstaller"),
  ]);

  if (/^app-/i.test(path.basename(installedExeDir))) {
    installRoots.add(path.dirname(installedExeDir));
  }

  if (process.resourcesPath) {
    installRoots.add(path.dirname(process.resourcesPath));
  }

  const candidates = [
    getWindowsOfflineTemplateZipPath(),
    path.join(installedExeDir, "resources", templateFileName),
    path.join(installedExeDir, templateFileName),
  ];

  for (const installRoot of installRoots) {
    if (!installRoot) {
      continue;
    }

    candidates.push(path.join(installRoot, templateFileName));
    candidates.push(path.join(installRoot, "offline-assets", templateFileName));

    try {
      const appDirs = fs
        .readdirSync(installRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^app-/i.test(entry.name))
        .map((entry) => path.join(installRoot, entry.name))
        .sort()
        .reverse();

      for (const appDir of appDirs) {
        candidates.push(path.join(appDir, "resources", templateFileName));
        candidates.push(path.join(appDir, templateFileName));
      }
    } catch (_) {}
  }

  return Array.from(new Set(candidates.map((candidate) => path.resolve(candidate))));
}

function resolveUsableTemplateZipPath(candidates) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      const stats = fs.statSync(candidate);
      if (stats.isFile() && stats.size > 0) {
        return candidate;
      }
    } catch (_) {}
  }

  return null;
}

function getTemplateZipPath() {
  const appPath = app.getAppPath();
  return resolveUsableTemplateZipPath([
    ...getWindowsTemplateZipCandidatePaths(),
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

async function recordTermsAcceptance(payload = {}) {
  const identityValidation = validateNameAndEmail(payload.name, payload.email);
  if (!identityValidation.valid) {
    return {
      success: false,
      error: identityValidation.nameError || identityValidation.emailError,
    };
  }

  const acceptedName = identityValidation.normalizedName;
  const acceptedEmail = identityValidation.normalizedEmail;

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
}

ipcMain.handle("record-terms-acceptance", async (_event, payload = {}) => {
  return recordTermsAcceptance(payload);
});

async function runCliInstallCommand(cliState) {
  if (cliState.command !== CLI_INSTALL_COMMAND) {
    console.error(`Unsupported CLI command: ${cliState.command}`);
    return 1;
  }

  const cliRequest = buildCliInstallRequest(cliState.options);
  if (!cliRequest.success) {
    console.error(cliRequest.error);
    return 1;
  }

  let termsResolution;
  try {
    termsResolution = await resolveCliTermsAcceptance(cliRequest);
  } catch (error) {
    console.error(error.message || String(error));
    return 1;
  }

  if (!termsResolution.success) {
    console.error(termsResolution.error);
    return 1;
  }

  if (cliRequest.dryRun) {
    let termsValidation;
    try {
      termsValidation = validateCliTermsAcceptancePreview(
        cliRequest.installData,
        {
          termsDocument: termsResolution.termsDocument,
          acceptanceMode: termsResolution.acceptanceMode,
        },
      );
    } catch (error) {
      console.error(error.message || String(error));
      return 1;
    }

    if (!termsValidation.success) {
      console.error(termsValidation.error);
      return 1;
    }

    console.log(
      JSON.stringify(
        buildCliDryRunSummary(cliRequest, termsValidation.summary),
        null,
        2,
      ),
    );
    return 0;
  }

  const acceptanceResult = await recordTermsAcceptance({
    name: cliRequest.installData.name,
    email: cliRequest.installData.email,
    buttonLabel:
      termsResolution.acceptanceMode === "cli-flag"
        ? "CLI --accept-terms"
        : "CLI interactive acceptance",
    acceptanceStatement: `${cliRequest.installData.name} accepted the BreakEven Terms & Conditions through the installer CLI flow (${termsResolution.acceptanceMode}).`,
  });

  if (!acceptanceResult.success) {
    console.error(acceptanceResult.error);
    return 1;
  }

  const result = await performInstallation(null, {
    ...cliRequest.installData,
    termsAcceptance: acceptanceResult.acceptance,
  });

  if (!result.success) {
    console.error(result.error || "Installation failed.");
    return 1;
  }

  return 0;
}

function quoteDesktopExecArg(value) {
  const text = String(value || "");
  if (!/[\s"\\]/.test(text)) {
    return text;
  }
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRecentLogChunk(logFile, baselineSize = 0, maxBytes = 32768) {
  if (!logFile || !fs.existsSync(logFile)) {
    return "";
  }

  try {
    const stats = fs.statSync(logFile);
    const startOffset = Math.max(
      0,
      Math.min(
        Number.isFinite(baselineSize) ? baselineSize : 0,
        Math.max(0, stats.size - maxBytes),
      ),
    );
    return fs.readFileSync(logFile, "utf8").slice(startOffset);
  } catch (_error) {
    return "";
  }
}

function detectMacServiceLogFailure(logText) {
  const normalized = String(logText || "");
  if (!normalized) {
    return null;
  }

  const failurePatterns = [
    {
      pattern: /Failed to start embedded python interpreter!/i,
      message: "embedded Python interpreter failed to start",
    },
    {
      pattern: /Fatal Python error:/i,
      message: "fatal Python runtime error detected",
    },
    {
      pattern: /ModuleNotFoundError:\s*No module named ['\"]encodings['\"]/i,
      message: "embedded Python stdlib could not find encodings",
    },
    {
      pattern: /Traceback \(most recent call last\):/i,
      message: "Python traceback detected during service startup",
    },
  ];

  for (const entry of failurePatterns) {
    if (entry.pattern.test(normalized)) {
      return entry.message;
    }
  }

  return null;
}

function resolveWindowsDashboardExecutablePath(dashboardDir) {
  const winCandidates = ["BreakEven.exe", "BreakEven Dashboard.exe"];
  return winCandidates
    .map((name) => path.join(dashboardDir, name))
    .find((candidate) => fs.existsSync(candidate));
}

function resolveMacDashboardAppPath(dashboardDir) {
  const appCandidates = [
    path.join(dashboardDir, "BreakEven.app"),
    path.join(dashboardDir, "BreakEven Dashboard.app"),
    path.join(dashboardDir, "breakevendashboard.app"),
  ];
  const directMatch = appCandidates.find((candidate) =>
    fs.existsSync(candidate),
  );
  if (directMatch) {
    return directMatch;
  }

  try {
    const nestedMatch = fs
      .readdirSync(dashboardDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.toLowerCase().endsWith(".app"),
      )
      .map((entry) => path.join(dashboardDir, entry.name))[0];
    return nestedMatch || null;
  } catch (_error) {
    return null;
  }
}

function resolveMacDashboardZipPath(dashboardDir) {
  const zipCandidates = [
    path.join(dashboardDir, "BreakEven.zip"),
    path.join(dashboardDir, "BreakEven Dashboard.zip"),
    path.join(dashboardDir, "breakevendashboard.zip"),
  ];
  const directMatch = zipCandidates.find((candidate) =>
    fs.existsSync(candidate),
  );
  if (directMatch) {
    return directMatch;
  }

  try {
    const nestedMatch = fs
      .readdirSync(dashboardDir, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"),
      )
      .map((entry) => path.join(dashboardDir, entry.name))[0];
    return nestedMatch || null;
  } catch (_error) {
    return null;
  }
}

function resolveMacDashboardDmgPath(dashboardDir) {
  const dmgCandidates = [
    path.join(dashboardDir, "BreakEven.dmg"),
    path.join(dashboardDir, "BreakEven Dashboard.dmg"),
    path.join(dashboardDir, "breakevendashboard.dmg"),
  ];
  return dmgCandidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function resolveInstalledMacDashboardAppPath(appName = null) {
  const appNames = appName
    ? [appName]
    : ["BreakEven.app", "BreakEven Dashboard.app", "breakevendashboard.app"];

  return resolveExistingPath(
    appNames.flatMap((candidateName) => [
      path.join("/Applications", candidateName),
      path.join(os.homedir(), "Applications", candidateName),
    ]),
  );
}

async function ensureMacDashboardAppPath(event, dashboardDir) {
  const existingAppPath = resolveMacDashboardAppPath(dashboardDir);
  if (existingAppPath) {
    return existingAppPath;
  }

  const zipPath = resolveMacDashboardZipPath(dashboardDir);
  if (!zipPath) {
    return null;
  }

  sendLog(event, `📦 Extracting macOS dashboard app bundle from ${zipPath}...`);
  try {
    await extractZipToDirectory(zipPath, dashboardDir, {
      stripSingleTopLevelFolder: true,
      event,
    });
  } catch (zipErr) {
    sendLog(
      event,
      `⚠️ Could not extract macOS dashboard app bundle from ${zipPath}: ${zipErr.message}`,
    );
    return null;
  }

  const extractedAppPath = resolveMacDashboardAppPath(dashboardDir);
  if (!extractedAppPath) {
    sendLog(
      event,
      `⚠️ Extracted ${zipPath} but no macOS .app bundle was found in ${dashboardDir}.`,
    );
    return null;
  }

  return extractedAppPath;
}

async function mountMacDashboardDmgAndResolveApp(event, dmgPath) {
  const mountPoint = path.join(
    os.tmpdir(),
    `breakeven-dashboard-dmg-${process.pid}-${Date.now()}`,
  );
  fs.mkdirSync(mountPoint, { recursive: true });

  try {
    await execCommandLogged(
      "hdiutil",
      ["attach", dmgPath, "-nobrowse", "-mountpoint", mountPoint],
      event,
    );
    const mountedAppPath = resolveMacDashboardAppPath(mountPoint);
    if (!mountedAppPath) {
      throw new Error(`No .app bundle was found inside mounted DMG ${dmgPath}`);
    }

    return { mountPoint, appPath: mountedAppPath };
  } catch (err) {
    try {
      await execCommandLogged("hdiutil", ["detach", mountPoint], event, {
        ignoreFailure: true,
      });
    } catch (_detachErr) {}
    try {
      fs.rmSync(mountPoint, { recursive: true, force: true });
    } catch (_cleanupErr) {}
    throw err;
  }
}

async function detachMountedMacDashboardDmg(event, mountPoint) {
  if (!mountPoint) {
    return;
  }

  try {
    await execCommandLogged("hdiutil", ["detach", mountPoint], event, {
      ignoreFailure: true,
    });
  } finally {
    try {
      fs.rmSync(mountPoint, { recursive: true, force: true });
    } catch (_cleanupErr) {}
  }
}

async function installMacDashboardApp(event, dashboardDir) {
  const installedAppPath = resolveInstalledMacDashboardAppPath();
  if (installedAppPath && fs.existsSync(installedAppPath)) {
    return installedAppPath;
  }

  const directAppPath = await ensureMacDashboardAppPath(event, dashboardDir);
  let mountedDmg = null;
  let sourceAppPath = directAppPath;

  try {
    if (!sourceAppPath) {
      const dmgPath = resolveMacDashboardDmgPath(dashboardDir);
      if (dmgPath) {
        mountedDmg = await mountMacDashboardDmgAndResolveApp(event, dmgPath);
        sourceAppPath = mountedDmg.appPath;
      }
    }

    if (!sourceAppPath) {
      return resolveInstalledMacDashboardAppPath();
    }

    const appName = path.basename(sourceAppPath) || "BreakEven.app";
    const systemTargetPath = path.join("/Applications", appName);
    const userTargetPath = path.join(os.homedir(), "Applications", appName);
    const normalizedAppPath = path.resolve(sourceAppPath);

    if (
      normalizedAppPath === path.resolve(systemTargetPath) ||
      normalizedAppPath === path.resolve(userTargetPath)
    ) {
      return sourceAppPath;
    }

    try {
      await execCommandWithPrivilegeFallback(
        "/bin/sh",
        [
          "-lc",
          [
            buildPosixShellCommand("/bin/mkdir", ["-p", "/Applications"]),
            `${buildPosixShellCommand("/bin/rm", ["-rf", systemTargetPath])} >/dev/null 2>&1 || true`,
            buildPosixShellCommand("/usr/bin/ditto", [
              sourceAppPath,
              systemTargetPath,
            ]),
            buildPosixShellCommand("/bin/chmod", [
              "-R",
              "a+rX,u+w",
              systemTargetPath,
            ]),
          ].join(" && "),
        ],
        event,
        { alwaysElevateOnFailure: true },
      );

      if (fs.existsSync(systemTargetPath)) {
        sendLog(event, `✅ Installed Dashboard app to ${systemTargetPath}`);
        return systemTargetPath;
      }
    } catch (installErr) {
      sendLog(
        event,
        `⚠️ Could not install Dashboard app into /Applications: ${installErr.message}. Falling back to ~/Applications.`,
      );
    }

    fs.mkdirSync(path.dirname(userTargetPath), { recursive: true });
    fs.rmSync(userTargetPath, { recursive: true, force: true });
    fsExtra.copySync(sourceAppPath, userTargetPath, { overwrite: true });
    sendLog(event, `✅ Installed Dashboard app to ${userTargetPath}`);
    return userTargetPath;
  } finally {
    if (mountedDmg) {
      await detachMountedMacDashboardDmg(event, mountedDmg.mountPoint);
    }
  }
}

async function clearMacAppQuarantine(event, appPath) {
  if (process.platform !== "darwin" || !appPath || !fs.existsSync(appPath)) {
    return;
  }

  try {
    if (path.resolve(appPath).startsWith(path.resolve("/Applications"))) {
      await execCommandWithPrivilegeFallback(
        "/usr/bin/xattr",
        ["-dr", "com.apple.quarantine", appPath],
        event,
        { alwaysElevateOnFailure: true },
      );
    } else {
      await execCommandLogged(
        "/usr/bin/xattr",
        ["-dr", "com.apple.quarantine", appPath],
        event,
        { ignoreFailure: true },
      );
    }
    sendLog(event, `✅ Cleared macOS quarantine attributes for ${appPath}`);
  } catch (err) {
    sendLog(
      event,
      `⚠️ Could not clear macOS quarantine attributes for ${appPath}: ${err.message}`,
    );
  }
}

function resolveLinuxDashboardIconTarget(dashboardDir) {
  const iconCandidates = [
    path.join(dashboardDir, "assets", "icon.png"),
    path.join(dashboardDir, "icon.png"),
  ];

  return (
    iconCandidates.find((candidate) => fs.existsSync(candidate)) ||
    "breakevendashboard"
  );
}

async function ensureLinuxDashboardLaunchTarget(event, dashboardDir) {
  const existingLaunchPath = findLinuxDashboardLaunchPath(dashboardDir);
  if (existingLaunchPath) {
    try {
      fs.chmodSync(existingLaunchPath, 0o755);
    } catch (_) {}
    return existingLaunchPath;
  }

  const linuxPackages = [
    {
      packagePath: path.join(dashboardDir, "BreakEven.deb"),
      args: ["dpkg", "-i"],
      label: "Dashboard package",
    },
    {
      packagePath: path.join(dashboardDir, "BreakEven.rpm"),
      args: ["rpm", "-i"],
      label: "Dashboard package",
    },
  ];

  for (const candidate of linuxPackages) {
    if (!fs.existsSync(candidate.packagePath)) {
      continue;
    }

    sendLog(
      event,
      `📦 Installing ${candidate.label} ${candidate.packagePath}...`,
    );
    try {
      await execCommandWithPrivilegeFallback(
        candidate.args[0],
        [...candidate.args.slice(1), candidate.packagePath],
        event,
        { alwaysElevateOnFailure: true },
      );
      const launchPath = await waitForLinuxDashboardLaunchPath(
        event,
        dashboardDir,
      );
      if (launchPath) {
        try {
          fs.chmodSync(launchPath, 0o755);
        } catch (_) {}
        return launchPath;
      }
    } catch (installErr) {
      sendLog(
        event,
        `⚠️ Could not auto-install dashboard package for shortcut creation: ${installErr.message}`,
      );
    }
  }

  return null;
}

async function createWindowsDashboardShortcuts(event, targetPath) {
  const desktopDir = path.join(os.homedir(), "Desktop");
  const startMenuDir = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
  );
  const shortcutName = "BreakEven Dashboard.lnk";
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    `$targetPath = ${escapePowerShellString(targetPath)}`,
    `$desktopDir = ${escapePowerShellString(desktopDir)}`,
    `$startMenuDir = ${escapePowerShellString(startMenuDir)}`,
    `$shortcutName = ${escapePowerShellString(shortcutName)}`,
    "$shell = New-Object -ComObject WScript.Shell",
    "$locations = @($desktopDir, $startMenuDir)",
    "foreach ($dir in $locations) {",
    "  New-Item -ItemType Directory -Path $dir -Force | Out-Null",
    "  $shortcutPath = Join-Path $dir $shortcutName",
    "  $shortcut = $shell.CreateShortcut($shortcutPath)",
    "  $shortcut.TargetPath = $targetPath",
    "  $shortcut.WorkingDirectory = Split-Path $targetPath -Parent",
    "  $shortcut.IconLocation = $targetPath",
    "  $shortcut.Save()",
    "}",
  ].join("\n");

  await execCommandLogged(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", psScript],
    event,
  );
  sendLog(
    event,
    "✅ Created Windows desktop and Start Menu dashboard shortcuts",
  );
}

function writeLinuxDashboardShortcut(shortcutPath, targetPath, iconTarget) {
  const execLine = quoteDesktopExecArg(targetPath);
  const iconLine = iconTarget ? `Icon=${iconTarget}\n` : "";
  const content = `[Desktop Entry]
Type=Application
Name=BreakEven Dashboard
Exec=${execLine}
Path=${path.dirname(targetPath)}
${iconLine}Terminal=false
Categories=Office;
`;
  fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
  fs.writeFileSync(shortcutPath, content, "utf8");
  fs.chmodSync(shortcutPath, 0o755);
}

async function createLinuxDashboardShortcuts(event, dashboardDir, targetPath) {
  const desktopShortcutPath = path.join(
    os.homedir(),
    "Desktop",
    "BreakEven Dashboard.desktop",
  );
  const appShortcutPath = path.join(
    os.homedir(),
    ".local",
    "share",
    "applications",
    "BreakEven Dashboard.desktop",
  );
  const iconTarget = resolveLinuxDashboardIconTarget(dashboardDir);

  writeLinuxDashboardShortcut(desktopShortcutPath, targetPath, iconTarget);
  writeLinuxDashboardShortcut(appShortcutPath, targetPath, iconTarget);
  sendLog(
    event,
    "✅ Created Linux desktop and application launcher dashboard shortcuts",
  );
}

async function createMacDashboardShortcuts(event, appPath) {
  const appName = path.basename(appPath) || "BreakEven.app";
  const targets = [path.join(os.homedir(), "Desktop", appName)];

  for (const targetPath of targets) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } catch (_) {}
    fs.symlinkSync(appPath, targetPath);
  }

  sendLog(event, "✅ Created macOS dashboard shortcut");
}

async function prepareDashboardAppAfterInstall(event, destinationPath) {
  const dashboardDir = path.join(destinationPath, "dashboard_gui");
  if (!fs.existsSync(dashboardDir)) {
    throw new Error(
      `Dashboard setup failed because ${dashboardDir} was not found.`,
    );
  }

  if (process.platform !== "darwin") {
    return { dashboardDir, appPath: null };
  }

  const appPath = await installMacDashboardApp(event, dashboardDir);
  if (!appPath || !fs.existsSync(appPath)) {
    throw new Error(
      `Dashboard setup failed because no macOS app bundle could be installed from ${dashboardDir}.`,
    );
  }

  await clearMacAppQuarantine(event, appPath);
  sendLog(event, `✅ Prepared macOS dashboard app at ${appPath}`);
  return { dashboardDir, appPath };
}

async function createDashboardShortcutsAfterInstall(event, destinationPath) {
  const dashboardDir = path.join(destinationPath, "dashboard_gui");
  if (!fs.existsSync(dashboardDir)) {
    sendLog(
      event,
      `⚠️ Dashboard shortcut creation skipped because ${dashboardDir} was not found.`,
    );
    return false;
  }

  try {
    if (process.platform === "win32") {
      const targetPath = resolveWindowsDashboardExecutablePath(dashboardDir);
      if (!targetPath) {
        sendLog(
          event,
          `⚠️ No Windows dashboard executable found in ${dashboardDir}; shortcuts were not created.`,
        );
        return false;
      }
      await createWindowsDashboardShortcuts(event, targetPath);
      return true;
    }

    if (process.platform === "linux") {
      const targetPath = await ensureLinuxDashboardLaunchTarget(
        event,
        dashboardDir,
      );
      if (!targetPath) {
        sendLog(
          event,
          `⚠️ No Linux dashboard launch target is available; shortcuts were not created.`,
        );
        return false;
      }
      await createLinuxDashboardShortcuts(event, dashboardDir, targetPath);
      return true;
    }

    if (process.platform === "darwin") {
      const appPath = await installMacDashboardApp(event, dashboardDir);
      if (!appPath) {
        sendLog(
          event,
          `⚠️ No macOS dashboard app bundle or extractable dashboard zip was found in ${dashboardDir}; shortcuts were not created.`,
        );
        return false;
      }
      await clearMacAppQuarantine(event, appPath);
      await createMacDashboardShortcuts(event, appPath);
      return true;
    }

    sendLog(
      event,
      `⚠️ Dashboard shortcut creation is not supported on platform ${process.platform}.`,
    );
    return false;
  } catch (err) {
    sendLog(event, `⚠️ Failed to create dashboard shortcuts: ${err.message}`);
    return false;
  }
}

function findLinuxDashboardLaunchPath(dashboardDir) {
  const executableCandidates = [
    "BreakEven",
    "BreakEven.AppImage",
    "BreakEven-x86_64.AppImage",
  ]
    .map((name) => path.join(dashboardDir, name))
    .filter((candidate) => fs.existsSync(candidate));

  if (executableCandidates.length > 0) {
    return executableCandidates[0];
  }

  const systemExecutables = [
    "/usr/bin/breakeven",
    "/usr/bin/breakevendashboard",
    "/usr/local/bin/breakeven",
    "/usr/local/bin/breakevendashboard",
    "/opt/BreakEven/breakeven",
  ];

  return (
    systemExecutables.find((candidate) => fs.existsSync(candidate)) || null
  );
}

async function waitForLinuxDashboardLaunchPath(
  event,
  dashboardDir,
  timeoutMs = 60000,
  intervalMs = 1000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const launchPath = findLinuxDashboardLaunchPath(dashboardDir);
    if (launchPath) {
      return launchPath;
    }
    await pause(intervalMs);
  }

  sendLog(
    event,
    `⚠️ Dashboard install completed but no launchable Linux binary appeared within ${Math.round(timeoutMs / 1000)}s.`,
  );
  return null;
}

async function launchDashboardAfterInstall(event, destinationPath) {
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
      const appPath = await installMacDashboardApp(event, dashboardDir);
      const dmgPath = resolveMacDashboardDmgPath(dashboardDir);

      if (appPath && fs.existsSync(appPath)) {
        await clearMacAppQuarantine(event, appPath);
        sendLog(event, `🚀 Launching Dashboard app bundle ${appPath}`);
        launchDetached("open", [appPath]);
        return true;
      }

      if (dmgPath && fs.existsSync(dmgPath)) {
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
      const existingLaunchPath = findLinuxDashboardLaunchPath(dashboardDir);

      if (existingLaunchPath) {
        try {
          fs.chmodSync(existingLaunchPath, 0o755);
        } catch (_) {}
        sendLog(event, `🚀 Launching Dashboard from ${existingLaunchPath}`);
        launchDetached(existingLaunchPath, []);
        return true;
      }

      // Try to install the package and then launch once the installed binary is present.
      const debPath = path.join(dashboardDir, "BreakEven.deb");
      if (fs.existsSync(debPath)) {
        sendLog(event, `📦 Installing Dashboard package ${debPath}...`);
        try {
          await execCommandWithPrivilegeFallback(
            "dpkg",
            ["-i", debPath],
            event,
            { alwaysElevateOnFailure: true },
          );
          const launchPath = await waitForLinuxDashboardLaunchPath(
            event,
            dashboardDir,
          );
          if (launchPath) {
            try {
              fs.chmodSync(launchPath, 0o755);
            } catch (_) {}
            sendLog(
              event,
              `🚀 Launching installed Dashboard from ${launchPath}`,
            );
            launchDetached(launchPath, []);
            return true;
          }
        } catch (installErr) {
          sendLog(
            event,
            `⚠️ Could not auto-install dashboard package: ${installErr.message}`,
          );
        }

        sendLog(
          event,
          `⚠️ Opening dashboard package location for manual launch.`,
        );
        launchDetached("xdg-open", [dashboardDir]);
        return true;
      }

      const rpmPath = path.join(dashboardDir, "BreakEven.rpm");
      if (fs.existsSync(rpmPath)) {
        sendLog(event, `📦 Installing Dashboard package ${rpmPath}...`);
        try {
          await execCommandWithPrivilegeFallback(
            "rpm",
            ["-i", rpmPath],
            event,
            { alwaysElevateOnFailure: true },
          );
          const launchPath = await waitForLinuxDashboardLaunchPath(
            event,
            dashboardDir,
          );
          if (launchPath) {
            try {
              fs.chmodSync(launchPath, 0o755);
            } catch (_) {}
            sendLog(
              event,
              `🚀 Launching installed Dashboard from ${launchPath}`,
            );
            launchDetached(launchPath, []);
            return true;
          }
        } catch (installErr) {
          sendLog(
            event,
            `⚠️ Could not auto-install dashboard package: ${installErr.message}`,
          );
        }

        sendLog(
          event,
          `⚠️ Opening dashboard package location for manual launch.`,
        );
        launchDetached("xdg-open", [dashboardDir]);
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
        resolve({
          stdout,
          stderr,
          exitCode: error && typeof error.code === "number" ? error.code : 0,
          error: error || null,
        });
      },
    );
  });
}

function execCommandQuiet(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { windowsHide: process.platform === "win32", ...options },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: error && typeof error.code === "number" ? error.code : 0,
          error: error || null,
        });
      },
    );
  });
}

function formatExecFailureMessage(result, fallback = "Command failed") {
  return (
    (result?.stderr && result.stderr.toString().trim()) ||
    (result?.stdout && result.stdout.toString().trim()) ||
    result?.error?.message ||
    fallback
  );
}

function shouldAttemptPosixPrivilegeFallback(result) {
  const text = formatExecFailureMessage(result).toLowerCase();
  return [
    "eacces",
    "eperm",
    "permission denied",
    "operation not permitted",
    "authentication is required",
    "must be root",
    "access denied",
    "not authorized",
  ].some((token) => text.includes(token));
}

function quotePosixShellArg(value) {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

function buildPosixShellCommand(command, args = []) {
  return [command, ...args].map((part) => quotePosixShellArg(part)).join(" ");
}

function escapeAppleScriptString(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function hasInteractiveTerminal() {
  try {
    return Boolean(
      isCliMode &&
      process.stdin &&
      process.stdout &&
      process.stdin.isTTY &&
      process.stdout.isTTY,
    );
  } catch (_error) {
    return false;
  }
}

async function execCommandWithPrivilegeFallback(
  command,
  args,
  event,
  options = {},
) {
  const { alwaysElevateOnFailure = false, ...execOptions } = options;
  const direct = await execCommandLogged(command, args, event, {
    ...execOptions,
    ignoreFailure: true,
  });
  if (direct.exitCode === 0 && !direct.error) {
    return direct;
  }

  const directMessage = formatExecFailureMessage(direct);
  if (
    !["linux", "darwin"].includes(process.platform) ||
    (!alwaysElevateOnFailure && !shouldAttemptPosixPrivilegeFallback(direct))
  ) {
    throw new Error(directMessage);
  }

  const candidates = [];
  if (process.platform === "linux") {
    candidates.push({
      command: "sudo",
      args: ["-n", command, ...args],
    });

    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
      candidates.push({
        command: "pkexec",
        args: [command, ...args],
      });
    }

    if (hasInteractiveTerminal()) {
      candidates.push({
        command: "sudo",
        args: [command, ...args],
      });
    }
  } else if (process.platform === "darwin") {
    candidates.push({
      command: "sudo",
      args: ["-n", command, ...args],
    });
    candidates.push({
      command: "osascript",
      args: [
        "-e",
        `do shell script \"${escapeAppleScriptString(buildPosixShellCommand(command, args))}\" with administrator privileges`,
      ],
    });

    if (hasInteractiveTerminal()) {
      candidates.push({
        command: "sudo",
        args: [command, ...args],
      });
    }
  }

  let lastError = directMessage;
  for (const candidate of candidates) {
    const result = await execCommandLogged(
      candidate.command,
      candidate.args,
      event,
      {
        ...execOptions,
        ignoreFailure: true,
      },
    );
    if (result.exitCode === 0 && !result.error) {
      return result;
    }
    lastError = formatExecFailureMessage(result, lastError);
  }

  throw new Error(lastError);
}

async function removeLinuxUserService(event, serviceName) {
  if (process.platform !== "linux") {
    return;
  }

  const unitName = `${serviceName}.service`;
  const unitPath = path.join(
    os.homedir(),
    ".config",
    "systemd",
    "user",
    unitName,
  );

  await execCommandLogged(
    "systemctl",
    ["--user", "disable", "--now", unitName],
    event,
    { ignoreFailure: true },
  );

  if (fs.existsSync(unitPath)) {
    fs.unlinkSync(unitPath);
    sendLog(event, `🧹 Removed existing Linux user unit at ${unitPath}`);
  }

  await execCommandLogged("systemctl", ["--user", "daemon-reload"], event, {
    ignoreFailure: true,
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

async function commandExists(command) {
  if (process.platform === "win32") {
    return false;
  }

  const result = await execCommandQuiet("/bin/sh", [
    "-lc",
    `command -v ${quotePosixShellArg(command)} >/dev/null 2>&1`,
  ]);
  return result.exitCode === 0;
}

async function detectLinuxFuseSupport() {
  const dpkgChecks = ["libfuse2", "libfuse2t64"];
  if (await commandExists("dpkg")) {
    for (const packageName of dpkgChecks) {
      const fuseCheck = await execCommandQuiet("dpkg", ["-s", packageName]);
      if (fuseCheck.exitCode === 0) {
        return { available: true, detail: `package ${packageName}` };
      }
    }
  }

  if (await commandExists("rpm")) {
    for (const packageName of ["fuse-libs", "fuse"]) {
      const fuseCheck = await execCommandQuiet("rpm", ["-q", packageName]);
      if (fuseCheck.exitCode === 0) {
        return { available: true, detail: `package ${packageName}` };
      }
    }
  }

  const knownFuseLibraryPaths = [
    "/lib/x86_64-linux-gnu/libfuse.so.2",
    "/usr/lib/x86_64-linux-gnu/libfuse.so.2",
    "/lib64/libfuse.so.2",
    "/usr/lib64/libfuse.so.2",
    "/usr/lib/libfuse.so.2",
  ];
  const existingLibraryPath = knownFuseLibraryPaths.find((candidate) =>
    fs.existsSync(candidate),
  );
  if (existingLibraryPath) {
    return { available: true, detail: `library ${existingLibraryPath}` };
  }

  if (await commandExists("ldconfig")) {
    const libraryCheck = await execCommandQuiet("/bin/sh", [
      "-lc",
      "ldconfig -p 2>/dev/null | grep -q 'libfuse\\.so\\.2'",
    ]);
    if (libraryCheck.exitCode === 0) {
      return {
        available: true,
        detail: "libfuse.so.2 in shared library cache",
      };
    }
  }

  return { available: false, detail: null };
}

async function installLinuxFuseFromRepositories(event) {
  const installCandidates = [];

  if (await commandExists("apt-get")) {
    installCandidates.push({
      label: "apt-get",
      command: "apt-get",
      args: ["install", "-y", "libfuse2"],
    });
  }

  if (await commandExists("dnf")) {
    installCandidates.push({
      label: "dnf",
      command: "dnf",
      args: ["install", "-y", "fuse", "fuse-libs"],
    });
  }

  if (await commandExists("yum")) {
    installCandidates.push({
      label: "yum",
      command: "yum",
      args: ["install", "-y", "fuse", "fuse-libs"],
    });
  }

  if (await commandExists("zypper")) {
    installCandidates.push({
      label: "zypper",
      command: "zypper",
      args: ["--non-interactive", "install", "fuse", "libfuse2"],
    });
  }

  let lastError = null;
  for (const candidate of installCandidates) {
    sendLog(
      event,
      `ℹ️ FUSE not installed, attempting repository install via ${candidate.label}...`,
    );
    try {
      await execCommandWithPrivilegeFallback(
        candidate.command,
        candidate.args,
        event,
        { alwaysElevateOnFailure: true },
      );
      return { success: true, source: candidate.label };
    } catch (installErr) {
      lastError = installErr;
      sendLog(
        event,
        `ℹ️ ${candidate.label} install did not complete: ${installErr.message}`,
      );
    }
  }

  return { success: false, error: lastError ? lastError.message : null };
}

async function getLinuxFuseInstallHint() {
  if (await commandExists("apt-get")) {
    return "sudo apt install libfuse2";
  }
  if (await commandExists("dnf")) {
    return "sudo dnf install fuse fuse-libs";
  }
  if (await commandExists("yum")) {
    return "sudo yum install fuse fuse-libs";
  }
  if (await commandExists("zypper")) {
    return "sudo zypper install fuse libfuse2";
  }
  return "Install a FUSE 2 runtime package for your distribution.";
}

async function checkAndInstallFUSE(event) {
  if (process.platform !== "linux") {
    return { success: true, alreadyInstalled: true };
  }

  sendLog(event, "🔍 Checking for FUSE support...");

  const fuseSupport = await detectLinuxFuseSupport();
  if (fuseSupport.available) {
    sendLog(
      event,
      `✅ FUSE support detected via ${fuseSupport.detail} - AppImages will run in native mode (best performance)`,
    );
    return {
      success: true,
      alreadyInstalled: true,
      detail: fuseSupport.detail,
    };
  }

  const repositoryInstall = await installLinuxFuseFromRepositories(event);
  if (repositoryInstall.success) {
    sendLog(
      event,
      `✅ FUSE installed successfully via ${repositoryInstall.source}`,
    );
    return { success: true, installed: true, source: repositoryInstall.source };
  }

  sendLog(
    event,
    "ℹ️ Repository install did not complete, attempting bundled Debian FUSE package when supported...",
  );

  const debPath = resolveExistingPath([
    path.join(
      process.resourcesPath || "",
      "app.asar.unpacked",
      "dependencies",
      "linux",
      "libfuse2_amd64.deb",
    ),
    path.join(__dirname, "dependencies", "linux", "libfuse2_amd64.deb"),
  ]);

  if ((await commandExists("dpkg")) && debPath && fs.existsSync(debPath)) {
    try {
      sendLog(event, "📦 Installing FUSE from bundled package...");
      await execCommandWithPrivilegeFallback("dpkg", ["-i", debPath], event, {
        alwaysElevateOnFailure: true,
      });
      sendLog(event, "✅ FUSE installed successfully from bundled package");
      return { success: true, installed: true };
    } catch (installError) {
      sendLog(
        event,
        `⚠️ Could not install bundled FUSE package: ${installError.message}`,
      );
    }
  } else {
    sendLog(
      event,
      "ℹ️ Bundled Debian FUSE package is not applicable on this Linux system or was not found.",
    );
  }

  sendLog(
    event,
    "ℹ️ FUSE not installed - AppImages will use extract-and-run mode (slower startup, no internet required)",
  );
  const fuseInstallHint = await getLinuxFuseInstallHint();
  sendLog(
    event,
    `💡 Optional: Install FUSE for better performance: ${fuseInstallHint}`,
  );
  return {
    success: true, // Don't block installation
    warning: true,
    message:
      "FUSE not installed. Services will use extract-and-run fallback mode.",
  };
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

async function ensureMacAppBundle(clientServiceDir, event, rootPath) {
  const localAppPath = path.join(clientServiceDir, "Breakeven_Slave.app");
  if (fs.existsSync(localAppPath)) {
    return localAppPath;
  }

  const appCandidates = buildMacPayloadPathCandidates(
    clientServiceDir,
    rootPath,
    "Breakeven_Slave.app",
  );
  const zipPath = path.join(clientServiceDir, "Breakeven_Slave.app.zip");
  if (fs.existsSync(zipPath)) {
    sendLog(event, "📦 Unpacking macOS BreakEven Slave bundle");
    await extractZipToDirectory(zipPath, clientServiceDir);
    if (!fs.existsSync(localAppPath)) {
      throw new Error("Failed to unpack Breakeven_Slave.app");
    }
    return localAppPath;
  }

  const pkgPath = path.join(clientServiceDir, "Breakeven_Slave.pkg");
  if (fs.existsSync(pkgPath)) {
    await installMacPkgPayload(event, pkgPath, "BreakEven Slave");
    const installedAppPath = resolveExistingPath(appCandidates);
    if (installedAppPath) {
      return installedAppPath;
    }
  }

  return resolveExistingPath(appCandidates);
}

function getMacExecutablePath(appPath) {
  const macOsDir = path.join(appPath, "Contents", "MacOS");
  if (!fs.existsSync(macOsDir)) {
    throw new Error("Invalid macOS bundle: missing Contents/MacOS");
  }
  const preferred = path.join(macOsDir, "Breakeven_Slave");
  if (fs.existsSync(preferred)) {
    return ensureExecutablePermissions(preferred);
  }
  const candidates = fs.readdirSync(macOsDir);
  if (!candidates.length) {
    throw new Error("Breakeven_Slave.app has no executable payload");
  }
  const fallback = path.join(macOsDir, candidates[0]);
  return ensureExecutablePermissions(fallback);
}

async function resolveSlaveBinary(platform, clientServiceDir, event, rootPath) {
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
    const appPath = await ensureMacAppBundle(clientServiceDir, event, rootPath);
    if (appPath) {
      const executablePath = getMacExecutablePath(appPath);
      return { binaryPath: executablePath };
    }

    const standaloneBinaryPath = resolveExistingPath(
      buildMacPayloadPathCandidates(
        clientServiceDir,
        rootPath,
        "Breakeven_Slave",
      ),
    );
    if (standaloneBinaryPath) {
      return {
        binaryPath: ensureExecutablePermissions(standaloneBinaryPath),
      };
    }

    return null;
  }

  return null;
}

function buildLinuxAppImageServiceBootstrap(
  clientServiceDir,
  binaryPath,
  logFile,
) {
  if (!binaryPath.endsWith(".AppImage")) {
    return [];
  }

  const runtimeRoot = path.join(
    clientServiceDir,
    ".appimage-runtimes",
    path.basename(binaryPath, ".AppImage"),
  );
  const serviceRoot = path.resolve(clientServiceDir, "..");
  const configSource = path.join(clientServiceDir, "..", "client_config.json");
  const logDir = path.dirname(logFile);
  const escapedServiceRoot = serviceRoot.replace(/"/g, '\\"');
  const escapedClientServiceDir = clientServiceDir.replace(/"/g, '\\"');
  const escapedRuntimeRoot = runtimeRoot.replace(/"/g, '\\"');
  const escapedConfigSource = configSource.replace(/"/g, '\\"');
  const escapedLogDir = logDir.replace(/"/g, '\\"');

  return [
    "",
    "# AppImage service mode: extract to a stable runtime directory and stage client_config.json there",
    `SERVICE_ROOT="${escapedServiceRoot}"`,
    `CLIENT_SERVICE_DIR="${escapedClientServiceDir}"`,
    `LOG_DIR="${escapedLogDir}"`,
    'mkdir -p "$LOG_DIR"',
    'mkdir -p "$CLIENT_SERVICE_DIR"',
    'echo "$(date -Iseconds) Runner preflight: service_root=$SERVICE_ROOT client_service_dir=$CLIENT_SERVICE_DIR log_dir=$LOG_DIR binary=$BINARY" >> "$LOG_FILE"',
    'if [[ "$BINARY" == *.AppImage ]]; then',
    `  RUNTIME_ROOT="${escapedRuntimeRoot}"`,
    '  EXTRACT_ROOT="$RUNTIME_ROOT/squashfs-root"',
    `  CONFIG_SOURCE="${escapedConfigSource}"`,
    '  echo "$(date -Iseconds) AppImage bootstrap: runtime_root=$RUNTIME_ROOT config_source=$CONFIG_SOURCE" >> "$LOG_FILE"',
    '  SOURCE_MTIME="$(stat -c %Y "$BINARY" 2>/dev/null || echo 0)"',
    '  STAMP_FILE="$RUNTIME_ROOT/.appimage-source-mtime"',
    '  CURRENT_MTIME=""',
    '  if [[ -f "$STAMP_FILE" ]]; then',
    '    CURRENT_MTIME="$(cat "$STAMP_FILE" 2>/dev/null || true)"',
    "  fi",
    '  if [[ ! -x "$EXTRACT_ROOT/AppRun" || "$CURRENT_MTIME" != "$SOURCE_MTIME" ]]; then',
    '    echo "$(date -Iseconds) Preparing stable AppImage runtime at $RUNTIME_ROOT" >> "$LOG_FILE"',
    '    rm -rf "$RUNTIME_ROOT"',
    '    mkdir -p "$RUNTIME_ROOT"',
    '    (cd "$RUNTIME_ROOT" && "$BINARY" --appimage-extract >/dev/null 2>> "$LOG_FILE")',
    '    printf "%s" "$SOURCE_MTIME" > "$STAMP_FILE"',
    "  fi",
    '  if [[ -f "$CONFIG_SOURCE" ]]; then',
    '    mkdir -p "$EXTRACT_ROOT/usr"',
    '    cp -f "$CONFIG_SOURCE" "$EXTRACT_ROOT/usr/client_config.json"',
    '    cp -f "$CONFIG_SOURCE" "$EXTRACT_ROOT/client_config.json"',
    "  else",
    '    echo "$(date -Iseconds) Missing client_config.json at $CONFIG_SOURCE" >> "$LOG_FILE"',
    "  fi",
    '  rm -rf "$EXTRACT_ROOT/logs"',
    '  ln -sfn "$LOG_DIR" "$EXTRACT_ROOT/logs" 2>/dev/null || true',
    '  mkdir -p "$EXTRACT_ROOT/logs"',
    '  export APPDIR="$EXTRACT_ROOT"',
    "  unset APPIMAGE_EXTRACT_AND_RUN",
    '  BINARY="$EXTRACT_ROOT/AppRun"',
    '  echo "$(date -Iseconds) AppImage bootstrap ready: appdir=$APPDIR effective_binary=$BINARY" >> "$LOG_FILE"',
    "fi",
  ];
}

function createRunnerScript(platform, clientServiceDir, binaryPath, logFile) {
  if (platform === "win32") {
    return binaryPath;
  }

  const runnerName = "breakeven_slave_service_runner.sh";
  const runnerPath = path.join(clientServiceDir, runnerName);
  const escapedBinary = binaryPath.replace(/"/g, '\\"');
  const escapedLog = logFile.replace(/"/g, '\\"');

  const appImageHandler =
    platform === "linux" && binaryPath.endsWith(".AppImage")
      ? buildLinuxAppImageServiceBootstrap(
          clientServiceDir,
          binaryPath,
          logFile,
        )
      : [];

  const content = [
    "#!/bin/bash",
    "set -e",
    `BINARY=\"${escapedBinary}\"`,
    `LOG_FILE=\"${escapedLog}\"`,
    'mkdir -p "$(dirname "$LOG_FILE")"',
    ': >> "$LOG_FILE"',
    ...appImageHandler,
    'echo "$(date -Iseconds) BreakEven Slave runner launch: cwd=$(pwd) effective_binary=$BINARY" >> "$LOG_FILE"',
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

function getWindowsServiceHostSourcePath() {
  return resolveExistingPath([
    path.join(
      process.resourcesPath || "",
      "app.asar.unpacked",
      "service_host",
      "BreakEvenSlaveServiceHost.cs",
    ),
    path.join(
      process.resourcesPath || "",
      "service_host",
      "BreakEvenSlaveServiceHost.cs",
    ),
    path.join(__dirname, "service_host", "BreakEvenSlaveServiceHost.cs"),
  ]);
}

async function ensureWindowsServiceHost(event, clientServiceDir) {
  const hostExePath = path.join(
    clientServiceDir,
    "BreakEvenSlaveServiceHost.exe",
  );
  if (fs.existsSync(hostExePath)) {
    return hostExePath;
  }
  const sourcePath = getWindowsServiceHostSourcePath();
  if (!sourcePath) {
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

function buildSystemdEnvironmentEntries(environment = {}) {
  return Object.entries(environment)
    .filter(
      ([key, value]) =>
        key && value !== undefined && value !== null && String(value) !== "",
    )
    .map(([key, value]) => {
      const escapedValue = String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
      return `\nEnvironment=\"${key}=${escapedValue}\"`;
    })
    .join("");
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
  const autoStart = options.autoStart !== false;
  const startImmediately = options.startImmediately !== false;
  await removeLinuxUserService(event, serviceName);
  const systemdDir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(systemdDir, { recursive: true });
  const unitPath = path.join(systemdDir, `${serviceName}.service`);
  const escapedRunner = runnerPath.replace(/(["\\$`])/g, "\\$1");
  const workingDir = path
    .join(destinationPath, "client_service")
    .replace(/"/g, '\\"');
  const logFile = options.logFile
    ? String(options.logFile).replace(/\\/g, "/")
    : "";

  // Determine if this is a GUI service (tray) that needs display
  const needsDisplay = serviceName.includes("tray");
  const envVars = buildSystemdEnvironmentEntries({
    ...(needsDisplay
      ? {
          DISPLAY: process.env.DISPLAY || ":0",
          XAUTHORITY: process.env.XAUTHORITY || "%h/.Xauthority",
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "%t",
          DBUS_SESSION_BUS_ADDRESS:
            process.env.DBUS_SESSION_BUS_ADDRESS || "unix:path=%t/bus",
        }
      : {}),
    ...(options.environment || {}),
  });
  const afterTarget = needsDisplay
    ? "graphical-session.target default.target"
    : "default.target";
  const wantsTarget = needsDisplay ? "\nWants=graphical-session.target" : "";
  const logDirectives = logFile
    ? `\nStandardOutput=append:${logFile}\nStandardError=append:${logFile}`
    : "";

  const unitContent = `[Unit]
Description=${description}
After=${afterTarget}${wantsTarget}

[Service]
Type=simple
ExecStart=/bin/bash "${escapedRunner}"
Restart=on-failure
RestartSec=5
WorkingDirectory=${workingDir}${envVars}${logDirectives}

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unitContent, "utf8");
  if (needsDisplay) {
    await execCommandLogged(
      "systemctl",
      [
        "--user",
        "import-environment",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
        "DESKTOP_SESSION",
        "XDG_SESSION_TYPE",
        "XDG_CURRENT_DESKTOP",
      ],
      event,
      { ignoreFailure: true },
    );
  }
  await execCommandLogged("systemctl", ["--user", "daemon-reload"], event);
  if (autoStart) {
    const enableArgs = startImmediately
      ? ["--user", "enable", "--now", `${serviceName}.service`]
      : ["--user", "enable", `${serviceName}.service`];
    await execCommandLogged("systemctl", enableArgs, event);
  } else {
    await execCommandLogged(
      "systemctl",
      ["--user", "disable", `${serviceName}.service`],
      event,
      { ignoreFailure: true },
    );

    if (startImmediately) {
      await execCommandLogged(
        "systemctl",
        ["--user", "start", `${serviceName}.service`],
        event,
      );
    } else {
      sendLog(
        event,
        `ℹ️ Registered Linux user service ${serviceName}.service without enabling startup.`,
      );
    }
  }
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

function buildMacLaunchdPlist(label, runnerPath, logFile, options = {}) {
  const autoStart = options.autoStart !== false;
  const workingDirectory = String(
    options.workingDirectory || path.dirname(runnerPath),
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${runnerPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${workingDirectory}</string>
    <key>RunAtLoad</key>
    <${autoStart ? "true" : "false"}/>
    <key>KeepAlive</key>
    <${autoStart ? "true" : "false"}/>
    <key>StandardOutPath</key>
    <string>${logFile}</string>
    <key>StandardErrorPath</key>
    <string>${logFile}</string>
</dict>
</plist>`;
}

async function registerMacService(event, runnerPath, logFile, options = {}) {
  const label = options.label || "com.breakeven.slave";
  const autoStart = options.autoStart !== false;
  const startImmediately = options.startImmediately !== false;
  const agentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const plistPath = path.join(agentsDir, `${label}.plist`);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const plist = buildMacLaunchdPlist(label, runnerPath, logFile, options);
  const shellSteps = [
    buildPosixShellCommand("/bin/mkdir", ["-p", agentsDir]),
    `${buildPosixShellCommand("launchctl", ["bootout", `gui/${uid}`, plistPath])} >/dev/null 2>&1 || true`,
    `${buildPosixShellCommand("launchctl", ["bootout", `gui/${uid}/${label}`])} >/dev/null 2>&1 || true`,
    `${buildPosixShellCommand("launchctl", ["remove", label])} >/dev/null 2>&1 || true`,
    `${buildPosixShellCommand("/bin/rm", ["-f", plistPath])} >/dev/null 2>&1 || true`,
  ];

  fs.writeFileSync(plistPath, plist, "utf8");
  if (autoStart || startImmediately) {
    shellSteps.push(
      `${buildPosixShellCommand("launchctl", ["enable", `gui/${uid}/${label}`])} >/dev/null 2>&1 || true`,
    );
  }
  shellSteps.push(
    buildPosixShellCommand("launchctl", ["bootstrap", `gui/${uid}`, plistPath]),
  );

  if (autoStart || startImmediately) {
    shellSteps.push(
      buildPosixShellCommand("launchctl", [
        "kickstart",
        "-k",
        `gui/${uid}/${label}`,
      ]),
    );
  }

  await execCommandLogged("/bin/sh", ["-lc", shellSteps.join(" && ")], event);

  if (!autoStart && !startImmediately) {
    sendLog(
      event,
      `ℹ️ Registered macOS LaunchAgent ${label} without enabling startup.`,
    );
  }

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

async function registerMacLaunchDaemon(
  event,
  runnerPath,
  logFile,
  options = {},
) {
  const label = options.label || "com.breakeven.slave";
  const autoStart = options.autoStart !== false;
  const startImmediately = options.startImmediately !== false;
  const daemonsDir = path.join("/Library", "LaunchDaemons");
  const plistPath = path.join(daemonsDir, `${label}.plist`);
  const tempPlistPath = path.join(os.tmpdir(), `${label}.plist`);
  const plist = buildMacLaunchdPlist(label, runnerPath, logFile, options);
  fs.writeFileSync(tempPlistPath, plist, "utf8");

  const shellSteps = [
    buildPosixShellCommand("/bin/mkdir", ["-p", daemonsDir]),
    `${buildPosixShellCommand("launchctl", ["bootout", "system", plistPath])} >/dev/null 2>&1 || true`,
    `${buildPosixShellCommand("launchctl", ["bootout", `system/${label}`])} >/dev/null 2>&1 || true`,
    `${buildPosixShellCommand("launchctl", ["remove", label])} >/dev/null 2>&1 || true`,
    `${buildPosixShellCommand("/bin/rm", ["-f", plistPath])} >/dev/null 2>&1 || true`,
    buildPosixShellCommand("/usr/bin/install", [
      "-m",
      "644",
      tempPlistPath,
      plistPath,
    ]),
    buildPosixShellCommand("/usr/sbin/chown", ["root:wheel", plistPath]),
    buildPosixShellCommand("/bin/chmod", ["644", plistPath]),
  ];

  if (autoStart || startImmediately) {
    shellSteps.push(
      `${buildPosixShellCommand("launchctl", ["enable", `system/${label}`])} >/dev/null 2>&1 || true`,
    );
  }

  shellSteps.push(
    buildPosixShellCommand("launchctl", ["bootstrap", "system", plistPath]),
  );

  if (autoStart || startImmediately) {
    shellSteps.push(
      buildPosixShellCommand("launchctl", [
        "kickstart",
        "-k",
        `system/${label}`,
      ]),
    );
  }

  try {
    await execCommandWithPrivilegeFallback(
      "/bin/sh",
      ["-lc", shellSteps.join(" && ")],
      event,
      { alwaysElevateOnFailure: true },
    );
  } finally {
    try {
      fs.unlinkSync(tempPlistPath);
    } catch (_error) {}
  }

  if (!autoStart && !startImmediately) {
    sendLog(
      event,
      `ℹ️ Registered macOS LaunchDaemon ${label} without enabling startup.`,
    );
  }

  const startCommand = [
    `${buildPosixShellCommand("launchctl", ["enable", `system/${label}`])} >/dev/null 2>&1 || true`,
    `${buildPosixShellCommand("launchctl", ["bootstrap", "system", plistPath])} >/dev/null 2>&1 || true`,
    buildPosixShellCommand("launchctl", ["kickstart", "-k", `system/${label}`]),
  ].join(" && ");

  return {
    type: "launch-daemon",
    identifier: label,
    commands: {
      start: ["/bin/sh", "-lc", startCommand],
      stop: ["launchctl", "bootout", `system/${label}`],
      restart: ["/bin/sh", "-lc", startCommand],
      status: ["launchctl", "print", `system/${label}`],
    },
    notes: `LaunchDaemon plist stored at ${plistPath}`,
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

  const destinationPaths = Array.isArray(destinationPath)
    ? destinationPath
    : [destinationPath];

  for (const basePath of destinationPaths) {
    if (!basePath) {
      continue;
    }

    const manifest = {
      name: serviceName,
      generatedAt: new Date().toISOString(),
      platform: descriptor.platform,
      serviceType: descriptor.type,
      identifier: descriptor.identifier,
      binary: normalizeManifestPath(basePath, descriptor.binaryPath),
      runner: normalizeManifestPath(basePath, descriptor.runnerPath),
      logFile: normalizeManifestPath(basePath, descriptor.logFile),
      control: {
        commands: manifestCommands,
      },
      notes: descriptor.notes,
    };

    const manifestPath = path.join(basePath, "client_service", manifestName);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
}

function getServiceManifestRoots(paths) {
  const roots = [paths?.manifestRoot || paths?.rootPath];

  if (
    (process.platform === "linux" || process.platform === "darwin") &&
    paths?.rootPath &&
    path.resolve(paths.rootPath) !==
      path.resolve(paths.manifestRoot || paths.rootPath)
  ) {
    roots.push(paths.rootPath);
  }

  return [...new Set(roots.filter(Boolean).map((root) => path.resolve(root)))];
}

function ensureLinuxServiceLogAccessPath(event, paths) {
  if (process.platform !== "linux") {
    return;
  }

  fs.mkdirSync(paths.logsDir, { recursive: true });
  const serviceLogsPath = path.join(paths.clientServiceDir, "logs");
  if (fs.existsSync(serviceLogsPath)) {
    return;
  }

  try {
    fs.symlinkSync(
      path.relative(paths.clientServiceDir, paths.logsDir),
      serviceLogsPath,
      "dir",
    );
    sendLog(
      event,
      `✅ Linked service log path ${serviceLogsPath} -> ${paths.logsDir}`,
    );
  } catch (err) {
    fs.mkdirSync(serviceLogsPath, { recursive: true });
    sendLog(
      event,
      `⚠️ Could not create service log symlink at ${serviceLogsPath}: ${err.message}. Created a plain directory instead.`,
    );
  }
}

function validateLinuxServiceInstall(event, paths, services) {
  if (process.platform !== "linux") {
    return;
  }

  const requiredEntries = [
    {
      label: "service root client_config.json",
      targetPath: path.join(paths.rootPath, "client_config.json"),
    },
    {
      label: "service client_config.json",
      targetPath: path.join(paths.clientServiceDir, "client_config.json"),
    },
    {
      label: "service client directory",
      targetPath: paths.clientServiceDir,
    },
    {
      label: "service logs directory",
      targetPath: paths.logsDir,
    },
  ];

  for (const service of services) {
    if (!service || !service.managed) {
      continue;
    }

    requiredEntries.push(
      {
        label: `${service.label} binary`,
        targetPath: service.binaryPath,
      },
      {
        label: `${service.label} runner`,
        targetPath: service.runnerPath,
      },
      {
        label: `${service.label} log directory`,
        targetPath: path.dirname(service.logFile),
      },
    );

    for (const root of getServiceManifestRoots(paths)) {
      requiredEntries.push({
        label: `${service.label} manifest (${root})`,
        targetPath: path.join(root, "client_service", service.manifestFileName),
      });
    }
  }

  const seen = new Set();
  const failures = [];

  for (const entry of requiredEntries) {
    const normalizedPath = path.resolve(entry.targetPath);
    if (seen.has(`${entry.label}:${normalizedPath}`)) {
      continue;
    }
    seen.add(`${entry.label}:${normalizedPath}`);

    if (fs.existsSync(entry.targetPath)) {
      sendLog(
        event,
        `✅ Linux service validation: ${entry.label} found at ${entry.targetPath}`,
      );
    } else {
      failures.push(`Missing ${entry.label} at ${entry.targetPath}`);
    }
  }

  if (failures.length) {
    throw new Error(`Linux service validation failed: ${failures.join("; ")}`);
  }
}

async function verifyLinuxSystemdServiceHealth(
  event,
  descriptor,
  options = {},
) {
  if (process.platform !== "linux" || !descriptor) {
    return;
  }

  const unitName = descriptor.identifier || "breakeven-slave.service";
  const logFile = descriptor.logFile;
  const timeoutMs = options.timeoutMs || 12000;
  const intervalMs = options.intervalMs || 500;
  const serviceLabel = options.serviceLabel || unitName;
  const baselineLogMtimeMs = Number.isFinite(options.baselineLogMtimeMs)
    ? options.baselineLogMtimeMs
    : null;
  const deadline = Date.now() + timeoutMs;

  let lastServiceState = "unknown";
  let lastLogState = baselineLogMtimeMs === null ? "missing" : "unchanged";

  sendLog(
    event,
    `🔎 Verifying Linux ${serviceLabel} health for ${unitName} and ${logFile}`,
  );

  while (Date.now() <= deadline) {
    const statusResult = await execCommandQuiet("systemctl", [
      "--user",
      "is-active",
      unitName,
    ]);
    const statusText = [statusResult.stdout, statusResult.stderr]
      .map((value) => (value ? value.toString().trim() : ""))
      .filter(Boolean)
      .join(" ");
    const serviceActive =
      statusResult.exitCode === 0 && /^active\b/i.test(statusText);

    let logReady = false;
    if (logFile && fs.existsSync(logFile)) {
      const logStats = fs.statSync(logFile);
      logReady =
        baselineLogMtimeMs === null || logStats.mtimeMs > baselineLogMtimeMs;
      lastLogState = logReady ? "present and updated" : "present but unchanged";
    } else {
      lastLogState = "missing";
    }

    lastServiceState = statusText || `exit code ${statusResult.exitCode}`;

    if (serviceActive && logReady) {
      sendLog(
        event,
        `✅ Linux ${serviceLabel} health check passed: ${unitName} is active and ${logFile} is ready`,
      );
      return;
    }

    await pause(intervalMs);
  }

  throw new Error(
    `Linux ${serviceLabel} health check failed: ${unitName} did not become active with a created or updated log at ${logFile} within ${timeoutMs}ms (service: ${lastServiceState}; log: ${lastLogState}).`,
  );
}

async function verifyMacLaunchAgentHealth(event, descriptor, options = {}) {
  if (process.platform !== "darwin" || !descriptor) {
    return;
  }

  const label = descriptor.identifier || "com.breakeven.slave";
  const logFile = descriptor.logFile;
  const timeoutMs = options.timeoutMs || 12000;
  const intervalMs = options.intervalMs || 500;
  const serviceLabel = options.serviceLabel || label;
  const baselineLogMtimeMs = Number.isFinite(options.baselineLogMtimeMs)
    ? options.baselineLogMtimeMs
    : null;
  const baselineLogSize = Number.isFinite(options.baselineLogSize)
    ? options.baselineLogSize
    : 0;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const deadline = Date.now() + timeoutMs;

  let lastServiceState = "unknown";
  let lastLogState = baselineLogMtimeMs === null ? "missing" : "unchanged";

  sendLog(
    event,
    `🔎 Verifying macOS ${serviceLabel} LaunchAgent ${label} and ${logFile}`,
  );

  while (Date.now() <= deadline) {
    const scopedStatus = await execCommandQuiet("launchctl", [
      "print",
      `gui/${uid}/${label}`,
    ]);
    let statusText = [scopedStatus.stdout, scopedStatus.stderr]
      .map((value) => (value ? value.toString().trim() : ""))
      .filter(Boolean)
      .join(" ");
    let serviceLoaded = scopedStatus.exitCode === 0;

    if (!serviceLoaded) {
      const listStatus = await execCommandQuiet("launchctl", ["list", label]);
      const listText = [listStatus.stdout, listStatus.stderr]
        .map((value) => (value ? value.toString().trim() : ""))
        .filter(Boolean)
        .join(" ");
      if (listStatus.exitCode === 0) {
        serviceLoaded = true;
        statusText = listText || statusText;
      } else if (listText) {
        statusText = listText;
      }
    }

    let logReady = false;
    if (logFile && fs.existsSync(logFile)) {
      const logStats = fs.statSync(logFile);
      logReady =
        baselineLogMtimeMs === null || logStats.mtimeMs > baselineLogMtimeMs;
      lastLogState = logReady ? "present and updated" : "present but unchanged";
      const failureMessage = detectMacServiceLogFailure(
        readRecentLogChunk(logFile, baselineLogSize),
      );
      if (failureMessage) {
        throw new Error(
          `macOS ${serviceLabel} health check failed: LaunchAgent ${label} wrote a fatal startup error to ${logFile} (${failureMessage}).`,
        );
      }
    } else {
      lastLogState = "missing";
    }

    lastServiceState = statusText || `exit code ${scopedStatus.exitCode}`;

    if (serviceLoaded && logReady) {
      sendLog(
        event,
        `✅ macOS ${serviceLabel} health check passed: LaunchAgent ${label} is loaded and ${logFile} is ready`,
      );
      return;
    }

    await pause(intervalMs);
  }

  throw new Error(
    `macOS ${serviceLabel} health check failed: LaunchAgent ${label} did not appear loaded with a created or updated log at ${logFile} within ${timeoutMs}ms (service: ${lastServiceState}; log: ${lastLogState}).`,
  );
}

async function verifyMacLaunchDaemonHealth(event, descriptor, options = {}) {
  if (process.platform !== "darwin" || !descriptor) {
    return;
  }

  const label = descriptor.identifier || "com.breakeven.slave";
  const logFile = descriptor.logFile;
  const timeoutMs = options.timeoutMs || 12000;
  const intervalMs = options.intervalMs || 500;
  const serviceLabel = options.serviceLabel || label;
  const baselineLogMtimeMs = Number.isFinite(options.baselineLogMtimeMs)
    ? options.baselineLogMtimeMs
    : null;
  const baselineLogSize = Number.isFinite(options.baselineLogSize)
    ? options.baselineLogSize
    : 0;
  const deadline = Date.now() + timeoutMs;

  let lastServiceState = "unknown";
  let lastLogState = baselineLogMtimeMs === null ? "missing" : "unchanged";

  sendLog(
    event,
    `🔎 Verifying macOS ${serviceLabel} LaunchDaemon ${label} and ${logFile}`,
  );

  while (Date.now() <= deadline) {
    const scopedStatus = await execCommandQuiet("launchctl", [
      "print",
      `system/${label}`,
    ]);
    let statusText = [scopedStatus.stdout, scopedStatus.stderr]
      .map((value) => (value ? value.toString().trim() : ""))
      .filter(Boolean)
      .join(" ");
    let serviceLoaded = scopedStatus.exitCode === 0;

    if (!serviceLoaded) {
      const listStatus = await execCommandQuiet("launchctl", ["list", label]);
      const listText = [listStatus.stdout, listStatus.stderr]
        .map((value) => (value ? value.toString().trim() : ""))
        .filter(Boolean)
        .join(" ");
      if (listStatus.exitCode === 0) {
        serviceLoaded = true;
        statusText = listText || statusText;
      } else if (listText) {
        statusText = listText;
      }
    }

    let logReady = false;
    if (logFile && fs.existsSync(logFile)) {
      const logStats = fs.statSync(logFile);
      logReady =
        baselineLogMtimeMs === null || logStats.mtimeMs > baselineLogMtimeMs;
      lastLogState = logReady ? "present and updated" : "present but unchanged";
      const failureMessage = detectMacServiceLogFailure(
        readRecentLogChunk(logFile, baselineLogSize),
      );
      if (failureMessage) {
        throw new Error(
          `macOS ${serviceLabel} health check failed: LaunchDaemon ${label} wrote a fatal startup error to ${logFile} (${failureMessage}).`,
        );
      }
    } else {
      lastLogState = "missing";
    }

    lastServiceState = statusText || `exit code ${scopedStatus.exitCode}`;

    if (
      !serviceLoaded &&
      logReady &&
      /permission|not permitted|not authorized|access denied|must be root/i.test(
        lastServiceState,
      )
    ) {
      serviceLoaded = true;
      lastServiceState +=
        " (accepted after log activity despite restricted status output)";
    }

    if (serviceLoaded && logReady) {
      sendLog(
        event,
        `✅ macOS ${serviceLabel} health check passed: LaunchDaemon ${label} is loaded and ${logFile} is ready`,
      );
      return;
    }

    await pause(intervalMs);
  }

  throw new Error(
    `macOS ${serviceLabel} health check failed: LaunchDaemon ${label} did not appear loaded with a created or updated log at ${logFile} within ${timeoutMs}ms (service: ${lastServiceState}; log: ${lastLogState}).`,
  );
}

async function verifyLinuxTraySessionHealth(event, descriptor, options = {}) {
  if (process.platform !== "linux" || !descriptor) {
    return;
  }

  if (descriptor.type === "systemd-user-service") {
    await verifyLinuxSystemdServiceHealth(event, descriptor, {
      ...options,
      serviceLabel: "tray service",
    });
    return;
  }

  const autostartPath =
    descriptor.autostartPath ||
    path.join(os.homedir(), ".config", "autostart", descriptor.identifier);
  const logFile = descriptor.logFile;
  const timeoutMs = options.timeoutMs || 12000;
  const intervalMs = options.intervalMs || 500;
  const baselineLogMtimeMs = Number.isFinite(options.baselineLogMtimeMs)
    ? options.baselineLogMtimeMs
    : null;
  const deadline = Date.now() + timeoutMs;
  let lastLogState = baselineLogMtimeMs === null ? "missing" : "unchanged";

  if (!fs.existsSync(autostartPath)) {
    throw new Error(
      `Linux tray health check failed: missing desktop autostart entry at ${autostartPath}.`,
    );
  }

  sendLog(
    event,
    `🔎 Verifying Linux tray session health for ${autostartPath} and ${logFile}`,
  );

  while (Date.now() <= deadline) {
    if (logFile && fs.existsSync(logFile)) {
      const logStats = fs.statSync(logFile);
      const logReady =
        baselineLogMtimeMs === null || logStats.mtimeMs > baselineLogMtimeMs;
      lastLogState = logReady ? "present and updated" : "present but unchanged";

      if (logReady) {
        sendLog(
          event,
          `✅ Linux tray health check passed: autostart entry exists and ${logFile} is ready`,
        );
        return;
      }
    } else {
      lastLogState = "missing";
    }

    await pause(intervalMs);
  }

  throw new Error(
    `Linux tray health check failed: desktop autostart entry exists at ${autostartPath}, but ${logFile} was not created or updated within ${timeoutMs}ms after the immediate tray launch (log: ${lastLogState}).`,
  );
}

async function ensureMacTrayAppBundle(clientServiceDir, event, rootPath) {
  const localAppPath = path.join(clientServiceDir, "Breakeven_Tray.app");
  if (fs.existsSync(localAppPath)) {
    return localAppPath;
  }

  const appCandidates = buildMacPayloadPathCandidates(
    clientServiceDir,
    rootPath,
    "Breakeven_Tray.app",
  );
  const zipPath = path.join(clientServiceDir, "Breakeven_Tray.app.zip");
  if (fs.existsSync(zipPath)) {
    sendLog(event, "📦 Unpacking macOS BreakEven Tray bundle");
    await extractZipToDirectory(zipPath, clientServiceDir);
    if (!fs.existsSync(localAppPath)) {
      throw new Error("Failed to unpack Breakeven_Tray.app");
    }
    return localAppPath;
  }

  const pkgPath = path.join(clientServiceDir, "Breakeven_Tray.pkg");
  if (fs.existsSync(pkgPath)) {
    await installMacPkgPayload(event, pkgPath, "BreakEven Tray");
    const installedAppPath = resolveExistingPath(appCandidates);
    if (installedAppPath) {
      return installedAppPath;
    }
  }

  return resolveExistingPath(appCandidates);
}

function getMacTrayExecutablePath(appPath) {
  const macOsDir = path.join(appPath, "Contents", "MacOS");
  if (!fs.existsSync(macOsDir)) {
    throw new Error("Invalid macOS tray bundle: missing Contents/MacOS");
  }
  const preferred = path.join(macOsDir, "Breakeven_Tray");
  if (fs.existsSync(preferred)) {
    return ensureExecutablePermissions(preferred);
  }
  const candidates = fs.readdirSync(macOsDir);
  if (!candidates.length) {
    throw new Error("Breakeven_Tray.app has no executable payload");
  }
  const fallback = path.join(macOsDir, candidates[0]);
  return ensureExecutablePermissions(fallback);
}

async function resolveTrayBinary(platform, clientServiceDir, event, rootPath) {
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
    const appPath = await ensureMacTrayAppBundle(
      clientServiceDir,
      event,
      rootPath,
    );
    if (appPath) {
      const executablePath = getMacTrayExecutablePath(appPath);
      return { binaryPath: executablePath };
    }

    const standaloneBinaryPath = resolveExistingPath(
      buildMacPayloadPathCandidates(
        clientServiceDir,
        rootPath,
        "Breakeven_Tray",
      ),
    );
    if (standaloneBinaryPath) {
      return {
        binaryPath: ensureExecutablePermissions(standaloneBinaryPath),
      };
    }

    return null;
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

  const appImageHandler =
    platform === "linux" && binaryPath.endsWith(".AppImage")
      ? buildLinuxAppImageServiceBootstrap(
          clientServiceDir,
          binaryPath,
          logFile,
        )
      : [];

  const content = [
    "#!/bin/bash",
    "set -e",
    `BINARY=\"${escapedBinary}\"`,
    `LOG_FILE=\"${escapedLog}\"`,
    'mkdir -p "$(dirname "$LOG_FILE")"',
    ': >> "$LOG_FILE"',
    ...appImageHandler,
    'echo "$(date -Iseconds) BreakEven Tray runner launch: cwd=$(pwd) effective_binary=$BINARY" >> "$LOG_FILE"',
    'echo "$(date -Iseconds) Tray session env: DISPLAY=${DISPLAY:-} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-} XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-} XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-}" >> "$LOG_FILE"',
    'echo "$(date -Iseconds) BreakEven Tray starting" >> "$LOG_FILE"',
    '"$BINARY" >> "$LOG_FILE" 2>&1',
    "EXITCODE=$?",
    'echo "$(date -Iseconds) BreakEven Tray stopped with $EXITCODE" >> "$LOG_FILE"',
    "exit $EXITCODE",
  ].join("\n");
  fs.writeFileSync(runnerPath, content, { mode: 0o755 });

  return runnerPath;
}

async function ensureMacUpdaterAppBundle(clientServiceDir, event, rootPath) {
  const localAppPath = path.join(clientServiceDir, "Breakeven_Updater.app");
  if (fs.existsSync(localAppPath)) {
    return localAppPath;
  }

  const appCandidates = buildMacPayloadPathCandidates(
    clientServiceDir,
    rootPath,
    "Breakeven_Updater.app",
  );
  const zipPath = path.join(clientServiceDir, "Breakeven_Updater.app.zip");
  if (fs.existsSync(zipPath)) {
    sendLog(event, "📦 Unpacking macOS BreakEven Updater bundle");
    await extractZipToDirectory(zipPath, clientServiceDir);
    if (!fs.existsSync(localAppPath)) {
      throw new Error("Failed to unpack Breakeven_Updater.app");
    }
    return localAppPath;
  }

  const pkgPath = path.join(clientServiceDir, "Breakeven_Updater.pkg");
  if (fs.existsSync(pkgPath)) {
    await installMacPkgPayload(event, pkgPath, "BreakEven Updater");
    const installedTarget =
      resolveExistingPath(appCandidates) ||
      findMacUpdaterInstallTarget(clientServiceDir, rootPath);
    if (installedTarget) {
      return installedTarget;
    }
  }

  return (
    resolveExistingPath(appCandidates) ||
    findMacUpdaterInstallTarget(clientServiceDir, rootPath)
  );
}

function getMacUpdaterExecutablePath(appPath) {
  const macOsDir = path.join(appPath, "Contents", "MacOS");
  if (!fs.existsSync(macOsDir)) {
    throw new Error("Invalid macOS updater bundle: missing Contents/MacOS");
  }
  const preferred = path.join(macOsDir, "Breakeven_Updater");
  if (fs.existsSync(preferred)) {
    return ensureExecutablePermissions(preferred);
  }
  const candidates = fs.readdirSync(macOsDir);
  if (!candidates.length) {
    throw new Error("Breakeven_Updater.app has no executable payload");
  }
  const fallback = path.join(macOsDir, candidates[0]);
  return ensureExecutablePermissions(fallback);
}

async function resolveUpdaterBinary(
  platform,
  clientServiceDir,
  event,
  rootPath,
) {
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
    const installTarget = await ensureMacUpdaterAppBundle(
      clientServiceDir,
      event,
      rootPath,
    );
    if (installTarget) {
      if (installTarget.toLowerCase().endsWith(".app")) {
        const executablePath = getMacUpdaterExecutablePath(installTarget);
        return { binaryPath: executablePath };
      }

      return {
        binaryPath: ensureExecutablePermissions(installTarget),
      };
    }

    const standaloneBinaryPath = resolveExistingPath(
      buildMacPayloadPathCandidates(
        clientServiceDir,
        rootPath,
        "Breakeven_Updater",
      ),
    );
    if (standaloneBinaryPath) {
      return {
        binaryPath: ensureExecutablePermissions(standaloneBinaryPath),
      };
    }

    return null;
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

  const appImageHandler =
    platform === "linux" && binaryPath.endsWith(".AppImage")
      ? buildLinuxAppImageServiceBootstrap(
          clientServiceDir,
          binaryPath,
          logFile,
        )
      : [];

  const content = [
    "#!/bin/bash",
    "set -e",
    `BINARY=\"${escapedBinary}\"`,
    `LOG_FILE=\"${escapedLog}\"`,
    'mkdir -p "$(dirname "$LOG_FILE")"',
    ': >> "$LOG_FILE"',
    ...appImageHandler,
    'echo "$(date -Iseconds) BreakEven Updater runner launch: cwd=$(pwd) effective_binary=$BINARY" >> "$LOG_FILE"',
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
    updaterRuntimeDir: path.join(destinationPath, "updater_runtime"),
    relocated: false,
  };
}

async function prepareMacServicePayloadPathsWithPrivilegeFallback(
  event,
  plan,
  systemRoot,
  targetClientDir,
  targetLogsDir,
) {
  let currentUser = "";
  try {
    currentUser = String(os.userInfo().username || "").trim();
  } catch (_error) {
    currentUser = String(process.env.USER || "").trim();
  }

  const stagedSource = stagePathForMacPrivilegedRead(
    plan.clientServiceDir,
    "client_service",
  );

  const shellSteps = [
    buildPosixShellCommand("/bin/mkdir", [
      "-p",
      systemRoot,
      targetClientDir,
      targetLogsDir,
      path.join(systemRoot, "updater_runtime"),
    ]),
    buildPosixShellCommand("/usr/bin/ditto", [
      stagedSource.stagedPath,
      targetClientDir,
    ]),
  ];

  if (currentUser) {
    shellSteps.push(
      buildPosixShellCommand("/usr/sbin/chown", [
        "-R",
        currentUser,
        systemRoot,
      ]),
    );
  }

  shellSteps.push(
    buildPosixShellCommand("/bin/chmod", ["-R", "u+rwX,go+rX", systemRoot]),
  );

  try {
    await execCommandWithPrivilegeFallback(
      "/bin/sh",
      ["-lc", shellSteps.join(" && ")],
      event,
      { alwaysElevateOnFailure: true },
    );
  } finally {
    stagedSource.cleanup();
  }

  sendLog(
    event,
    `📁 Service payload relocated to elevated path ${targetClientDir} with macOS administrator privileges`,
  );
  return {
    rootPath: systemRoot,
    manifestRoot: plan.manifestRoot,
    clientServiceDir: targetClientDir,
    logsDir: targetLogsDir,
    updaterRuntimeDir: path.join(systemRoot, "updater_runtime"),
    relocated: true,
  };
}

async function prepareServicePayloadPaths(event, destinationPath) {
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
  const targetUpdaterRuntimeDir = path.join(systemRoot, "updater_runtime");

  try {
    fs.mkdirSync(systemRoot, { recursive: true });
    fsExtra.copySync(plan.clientServiceDir, targetClientDir, {
      overwrite: true,
      errorOnExist: false,
    });
    fs.mkdirSync(targetLogsDir, { recursive: true });
    fs.mkdirSync(targetUpdaterRuntimeDir, { recursive: true });
    sendLog(
      event,
      `📁 Service payload relocated to elevated path ${targetClientDir}`,
    );
    return {
      rootPath: systemRoot,
      manifestRoot: destinationPath,
      clientServiceDir: targetClientDir,
      logsDir: targetLogsDir,
      updaterRuntimeDir: targetUpdaterRuntimeDir,
      relocated: true,
    };
  } catch (err) {
    if (process.platform === "darwin") {
      try {
        return await prepareMacServicePayloadPathsWithPrivilegeFallback(
          event,
          plan,
          systemRoot,
          targetClientDir,
          targetLogsDir,
        );
      } catch (privErr) {
        sendLog(
          event,
          `⚠️ Unable to relocate service payload to ${systemRoot} after requesting macOS administrator privileges: ${privErr.message}. Continuing with standard install path.`,
        );
        return plan;
      }
    }

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
    rootPath,
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
  const baselineLogMtimeMs = fs.existsSync(logFile)
    ? fs.statSync(logFile).mtimeMs
    : null;
  const baselineLogSize = fs.existsSync(logFile)
    ? fs.statSync(logFile).size
    : 0;
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
      descriptor = await registerLinuxService(event, runnerPath, rootPath, {
        logFile,
        environment: {
          BREAKEVEN_SERVICE_ROOT: rootPath,
          BREAKEVEN_CLIENT_SERVICE_DIR: clientServiceDir,
          BREAKEVEN_LOG_DIR: logsDir,
        },
      });
    } else if (platform === "darwin") {
      descriptor = await registerMacLaunchDaemon(event, runnerPath, logFile, {
        label: "com.breakeven.slave",
        autoStart: options.autoStart,
        startImmediately: options.startImmediately,
      });
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
  descriptor.baselineLogMtimeMs = baselineLogMtimeMs;
  descriptor.baselineLogSize = baselineLogSize;
  descriptor.platform = platform;
  writeServiceManifest(getServiceManifestRoots(paths), descriptor);
  sendLog(
    event,
    `✅ Native BreakEven Slave service configured (${descriptor.type})`,
  );
  return { managed: true, descriptor };
}

async function configureTrayService(event, paths, options = {}) {
  const { clientServiceDir, logsDir, manifestRoot, rootPath } = paths;
  const platform = process.platform;
  const binaryInfo = await resolveTrayBinary(
    platform,
    clientServiceDir,
    event,
    rootPath,
  );
  if (!binaryInfo) {
    sendLog(
      event,
      `⚠️ No native BreakEven Tray binary found for platform ${platform}. Falling back to script launch.`,
    );
    return { managed: false };
  }

  fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, "breakeven_tray.log");
  const baselineLogMtimeMs = fs.existsSync(logFile)
    ? fs.statSync(logFile).mtimeMs
    : null;
  const baselineLogSize = fs.existsSync(logFile)
    ? fs.statSync(logFile).size
    : 0;
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
      await removeLinuxUserService(event, "breakeven-tray");
      const legacyAutostartPath = path.join(
        os.homedir(),
        ".config",
        "autostart",
        "tray_app.desktop",
      );
      if (fs.existsSync(legacyAutostartPath)) {
        fs.unlinkSync(legacyAutostartPath);
        sendLog(
          event,
          `🧹 Removed legacy Linux tray autostart entry at ${legacyAutostartPath}`,
        );
      }

      descriptor = await registerLinuxService(event, runnerPath, rootPath, {
        serviceName: "breakeven-tray",
        description: "BreakEven tray application",
        logFile,
        environment: {
          BREAKEVEN_SERVICE_ROOT: rootPath,
          BREAKEVEN_CLIENT_SERVICE_DIR: clientServiceDir,
          BREAKEVEN_LOG_DIR: logsDir,
        },
      });
    } else if (platform === "darwin") {
      descriptor = await registerMacLaunchDaemon(event, runnerPath, logFile, {
        label: "com.breakeven.tray",
        autoStart: options.autoStart,
        startImmediately: options.startImmediately,
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
  descriptor.baselineLogMtimeMs = baselineLogMtimeMs;
  descriptor.baselineLogSize = baselineLogSize;
  descriptor.platform = platform;
  writeServiceManifest(getServiceManifestRoots(paths), descriptor, {
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
  let logFile = null;
  if (platform === "darwin") {
    fs.mkdirSync(logsDir, { recursive: true });
    logFile = path.join(logsDir, "breakeven_updater.log");
    fs.closeSync(fs.openSync(logFile, "a"));
  }

  const binaryInfo = await resolveUpdaterBinary(
    platform,
    clientServiceDir,
    event,
    rootPath,
  );
  if (!binaryInfo) {
    if (platform === "darwin") {
      const message = `No macOS BreakEven Updater executable was installed. Searched: ${buildMacPayloadPathCandidates(clientServiceDir, rootPath, "Breakeven_Updater.app").join(", ")}`;
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
      sendLog(event, `❌ ${message}`);
      throw new Error(message);
    }
    sendLog(
      event,
      `⚠️ No native BreakEven Updater binary found for platform ${platform}. Falling back to script launch.`,
    );
    return { managed: false };
  }

  fs.mkdirSync(logsDir, { recursive: true });
  logFile = logFile || path.join(logsDir, "breakeven_updater.log");
  const baselineLogMtimeMs = fs.existsSync(logFile)
    ? fs.statSync(logFile).mtimeMs
    : null;
  const baselineLogSize = fs.existsSync(logFile)
    ? fs.statSync(logFile).size
    : 0;
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
        logFile,
        environment: {
          BREAKEVEN_SERVICE_ROOT: rootPath,
          BREAKEVEN_CLIENT_SERVICE_DIR: clientServiceDir,
          BREAKEVEN_LOG_DIR: logsDir,
          BREAKEVEN_UPDATER_RUNTIME_BASE: rootPath,
        },
      });
    } else if (platform === "darwin") {
      descriptor = await registerMacLaunchDaemon(event, runnerPath, logFile, {
        label: "com.breakeven.updater",
        autoStart: options.autoStart,
        startImmediately: options.startImmediately,
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
  descriptor.baselineLogMtimeMs = baselineLogMtimeMs;
  descriptor.baselineLogSize = baselineLogSize;
  descriptor.platform = platform;
  writeServiceManifest(getServiceManifestRoots(paths), descriptor, {
    fileName: "updater_service_manifest.json",
    name: "breakeven_updater",
  });
  sendLog(
    event,
    `✅ Native BreakEven Updater service configured (${descriptor.type})`,
  );
  return { managed: true, descriptor };
}

async function performInstallation(event, installData) {
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
  const identityValidation = validateNameAndEmail(
    installData.name,
    installData.email,
  );
  if (!identityValidation.valid) {
    return {
      success: false,
      error: identityValidation.nameError || identityValidation.emailError,
    };
  }

  const normalizedName = identityValidation.normalizedName;
  const normalizedEmail = identityValidation.normalizedEmail;

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
  const destinationPath = resolveDestinationInstallPath(selectedPath);

  const bufferValidation = validateBufferCores(
    installData.bufferCores ?? installData.buffer_cores,
    GUI_DEFAULT_BUFFER_CORES,
  );
  if (!bufferValidation.valid) {
    return {
      success: false,
      error: bufferValidation.error,
    };
  }

  const defaultWalletValidation = validateSolanaWalletAddress(
    installData.defaultSolanaWallet,
    {
      allowEmpty: true,
      optionName: "Default Solana wallet address",
    },
  );
  if (!defaultWalletValidation.valid) {
    return {
      success: false,
      error: defaultWalletValidation.error,
    };
  }

  const defaultWalletEntry = buildWalletConfigEntry(
    defaultWalletValidation.value,
  );
  const walletList = defaultWalletEntry ? [defaultWalletEntry] : [];
  const clientConfig = {
    version: "0.0.0.0",
    name: normalizedName,
    email: normalizedEmail,
    buffer_cores: bufferValidation.value,
    installPath: destinationPath,
    serviceInstallPath: getSystemServiceRoot() || destinationPath,
    addShortcuts: !!installData.addShortcuts,
    runTrayOnStartup: !!installData.runTrayOnStartup,
    runSlaveOnStartup: !!installData.runSlaveOnStartup,
    runAsRoot: !!installData.runAsRoot,
    autoUpdate: !!installData.autoUpdate,
    openDashboard: !!installData.openDashboard,
    wallets: walletList,
    default_payout_wallet: defaultWalletEntry
      ? defaultWalletEntry.address
      : null,
    phantom_app_id: null,
  };

  const configPathGUI = path.join(
    destinationPath,
    "installer_gui",
    "client_config.json",
  );
  const configPathRoot = path.join(destinationPath, "client_config.json");
  const zipPath = getTemplateZipPath();

  let trayServiceInfo = { managed: false };
  let slaveServiceInfo = { managed: false };
  let updaterServiceInfo = { managed: false };
  let servicePaths = buildServicePathPlan(destinationPath);

  try {
    if (!zipPath) {
      throw new Error(
        "Unable to locate BreakEvenClient_Template.zip in the offline cache or packaged installer resources.",
      );
    }

    sendProgress(event, 0);
    sendLog(
      event,
      `📝 Terms accepted by ${recordedAcceptance.name}${recordedAcceptance.email ? ` <${recordedAcceptance.email}>` : ""} at ${recordedAcceptance.acceptedAt} (version ${recordedAcceptance.termsVersion})`,
    );

    // Check for FUSE on Linux and attempt installation from bundled package
    if (process.platform === "linux") {
      await checkAndInstallFUSE(event);
    }

    sendProgress(event, 10);

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

    sendProgress(event, 30);

    if (process.platform === "win32") {
      const elevated = await isWindowsAdministrator();
      if (!elevated) {
        throw new Error(
          "Windows service registration requires Administrator privileges. Relaunch the installer with 'Run as Administrator' and retry.",
        );
      }
    }

    sendProgress(event, 20);
    if (getSystemServiceRoot()) {
      servicePaths = await prepareServicePayloadPaths(event, destinationPath);
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

    if (servicePaths?.clientServiceDir) {
      const serviceConfigPath = path.join(
        servicePaths.clientServiceDir,
        "client_config.json",
      );
      try {
        fs.mkdirSync(servicePaths.clientServiceDir, { recursive: true });
        fs.writeFileSync(serviceConfigPath, serializedConfig);
        sendLog(
          event,
          `✅ client_config.json copied to service client directory ${serviceConfigPath}`,
        );
      } catch (serviceCfgErr) {
        sendLog(
          event,
          `⚠️ Failed to copy client_config.json to service client directory: ${serviceCfgErr.message}`,
        );
      }
    }

    if (process.platform === "linux") {
      ensureLinuxServiceLogAccessPath(event, servicePaths);
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
    sendProgress(event, 45);

    trayServiceInfo = await configureTrayService(event, servicePaths, {
      autoStart: clientConfig.runTrayOnStartup,
      startImmediately: clientConfig.runTrayOnStartup,
    });

    slaveServiceInfo = await configureSlaveService(event, servicePaths, {
      autoStart: clientConfig.runSlaveOnStartup,
      startImmediately: clientConfig.runSlaveOnStartup,
    });

    updaterServiceInfo = await configureUpdaterService(event, servicePaths, {
      autoStart: clientConfig.autoUpdate,
      startImmediately:
        process.platform === "darwin" ? true : clientConfig.autoUpdate,
    });

    sendProgress(event, 65);

    if (
      trayServiceInfo.managed ||
      slaveServiceInfo.managed ||
      updaterServiceInfo.managed
    ) {
      if (process.platform === "linux") {
        validateLinuxServiceInstall(event, servicePaths, [
          {
            label: "slave",
            managed: slaveServiceInfo.managed,
            binaryPath: slaveServiceInfo.descriptor?.binaryPath,
            runnerPath: slaveServiceInfo.descriptor?.runnerPath,
            logFile: slaveServiceInfo.descriptor?.logFile,
            manifestFileName: "service_manifest.json",
          },
          {
            label: "tray",
            managed: trayServiceInfo.managed,
            binaryPath: trayServiceInfo.descriptor?.binaryPath,
            runnerPath: trayServiceInfo.descriptor?.runnerPath,
            logFile: trayServiceInfo.descriptor?.logFile,
            manifestFileName: "tray_service_manifest.json",
          },
          {
            label: "updater",
            managed: updaterServiceInfo.managed,
            binaryPath: updaterServiceInfo.descriptor?.binaryPath,
            runnerPath: updaterServiceInfo.descriptor?.runnerPath,
            logFile: updaterServiceInfo.descriptor?.logFile,
            manifestFileName: "updater_service_manifest.json",
          },
        ]);

        if (slaveServiceInfo.managed && clientConfig.runSlaveOnStartup) {
          await verifyLinuxSystemdServiceHealth(
            event,
            slaveServiceInfo.descriptor,
            {
              serviceLabel: "slave service",
              baselineLogMtimeMs:
                slaveServiceInfo.descriptor?.baselineLogMtimeMs,
              baselineLogSize: slaveServiceInfo.descriptor?.baselineLogSize,
            },
          );
        }

        if (updaterServiceInfo.managed && clientConfig.autoUpdate) {
          await verifyLinuxSystemdServiceHealth(
            event,
            updaterServiceInfo.descriptor,
            {
              serviceLabel: "updater service",
              baselineLogMtimeMs:
                updaterServiceInfo.descriptor?.baselineLogMtimeMs,
            },
          );
        }

        if (trayServiceInfo.managed && clientConfig.runTrayOnStartup) {
          await verifyLinuxTraySessionHealth(
            event,
            trayServiceInfo.descriptor,
            {
              baselineLogMtimeMs:
                trayServiceInfo.descriptor?.baselineLogMtimeMs,
            },
          );
        }
      } else if (process.platform === "darwin") {
        if (slaveServiceInfo.managed && clientConfig.runSlaveOnStartup) {
          await verifyMacLaunchDaemonHealth(
            event,
            slaveServiceInfo.descriptor,
            {
              serviceLabel: "slave service",
              baselineLogMtimeMs:
                slaveServiceInfo.descriptor?.baselineLogMtimeMs,
            },
          );
        }

        if (updaterServiceInfo.managed && clientConfig.autoUpdate) {
          await verifyMacLaunchDaemonHealth(
            event,
            updaterServiceInfo.descriptor,
            {
              serviceLabel: "updater service",
              baselineLogMtimeMs:
                updaterServiceInfo.descriptor?.baselineLogMtimeMs,
              baselineLogSize: updaterServiceInfo.descriptor?.baselineLogSize,
            },
          );
        }

        if (trayServiceInfo.managed && clientConfig.runTrayOnStartup) {
          await verifyMacLaunchDaemonHealth(event, trayServiceInfo.descriptor, {
            serviceLabel: "tray service",
            baselineLogMtimeMs: trayServiceInfo.descriptor?.baselineLogMtimeMs,
            baselineLogSize: trayServiceInfo.descriptor?.baselineLogSize,
          });
        }
      }
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

    sendProgress(event, 80);
    if (trayServiceInfo.managed) {
      sendLog(
        event,
        `🟢 Tray managed via native ${trayServiceInfo.descriptor?.type || "service"}; runtime launch delegated to the OS.`,
      );
    }
    if (slaveServiceInfo.managed) {
      sendLog(
        event,
        `🟢 Slave managed via native ${slaveServiceInfo.descriptor?.type || "service"}; runtime launch delegated to the OS.`,
      );
    }
    if (updaterServiceInfo.managed) {
      sendLog(
        event,
        `🟢 Updater managed via native ${updaterServiceInfo.descriptor?.type || "service"}; runtime launch delegated to the OS.`,
      );
    }

    sendProgress(event, 85);
    await prepareDashboardAppAfterInstall(event, destinationPath);

    if (clientConfig.addShortcuts) {
      await createDashboardShortcutsAfterInstall(event, destinationPath);
    } else {
      sendLog(
        event,
        "ℹ️ Dashboard shortcut creation skipped by install option.",
      );
    }

    sendProgress(event, 90);

    sendLog(event, `🎉 Installation completed successfully`);

    if (clientConfig.openDashboard) {
      sendProgress(event, 95);
      await launchDashboardAfterInstall(event, destinationPath);
    }

    sendProgress(event, 100);

    return { success: true };
  } catch (err) {
    let errorMessage = err.message;
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
}

ipcMain.handle("start-installation", async (event, installData) => {
  return performInstallation(event, installData);
});

ipcMain.handle("window-close", () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.close();
});
ipcMain.handle("window-minimize", () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.minimize();
});
