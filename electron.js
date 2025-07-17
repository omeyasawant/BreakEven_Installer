

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
// handle all the common Squirrel events and quit early if one fired
if (require('electron-squirrel-startup')) {
    app.quit();
    return;
}
const path = require('path');
const fs = require('fs');
const fsExtra = require('fs-extra');
const os = require('os');
const AdmZip = require('adm-zip');
//const childProcess = require('child_process');
const { execFile, spawn } = require('child_process');


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


    const { screen } = require('electron');
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
        }
    });

    win.loadFile(path.join(__dirname,'index.html'));
    win.webContents.openDevTools();
    win.removeMenu();
    console.log('[Electron] Installer window launched in production mode');
}

app.whenReady().then(createWindow);
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

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.filePaths[0];
});

function sendLog(event, message) {
    console.log(message);
    event.sender.send('install-log', message);
}
function sendProgress(event, percent) {
    event.sender.send('install-progress', percent);
}

function makeAutoStartScript(scriptPath, name, targetDir) {
    const platform = os.platform();
    if (platform === 'win32') {
        const startupPath = path.join(process.env.APPDATA, 'Microsoft\\Windows\\Start Menu\\Programs\\Startup');
        const batPath = path.join(startupPath, `${name}.bat`);
        fs.writeFileSync(batPath, `@echo off\ncd /d "${targetDir}"\nstart "" python "${scriptPath}"\n`);
    } else {
        const autostartDir = path.join(os.homedir(), '.config', 'autostart');
        if (!fs.existsSync(autostartDir)) fs.mkdirSync(autostartDir, { recursive: true });
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

async function cleanupCondaEnv(destinationPath, envName, event) {
    const condaPath = path.join(destinationPath, 'Miniconda3', 'Scripts', 'conda.exe');
    sendLog(event, `🧹 Cleaning up Conda env: ${envName}`);
    await new Promise(resolve => {
        execFile(condaPath, ['env', 'remove', '-y', '-n', envName], (err) => {
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
        const minicondaDir = path.join(destinationPath, 'Miniconda3');
        const condaRunPath = path.join(minicondaDir, 'Scripts', 'conda.exe');
        const envName = 'breakeven_env';

        sendLog(event, `🟡 Launching ${label} using conda env ${envName}...`);
        sendLog(event, `📄 Command: ${condaRunPath} run -n ${envName} python ${script}`);

        const proc = spawn(condaRunPath, ['run', '-n', envName, 'python', script], {
            cwd: destinationPath,
            windowsHide: true,
            detached: true,
            stdio:false,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let started = false;
        let exited = false;

        const timeout = setTimeout(() => {
            if (!started && !exited) {
                sendLog(event, `⚠️ ${label} did not confirm startup in time. Proceeding with installation.`);

                const pidPath = path.join(destinationPath, `${label.toLowerCase()}_pid.txt`);
                try {
                    fs.writeFileSync(pidPath, String(proc.pid));
                    sendLog(event, `📄 PID file written for ${label}: ${proc.pid}`);
                } catch (err) {
                    sendLog(event, `⚠️ Failed to write PID file for ${label}: ${err.message}`);
                }

                resolve(proc);  // Allow installation to proceed
            }
        }, 15000); // 15s timeout


        proc.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            sendLog(event, `📩 ${label}: ${msg}`);
            if (!started && msg.toLowerCase().includes("tray_app is ready")) {
                started = true;
                clearTimeout(timeout);
                sendLog(event, `✅ ${label} confirmed running`);

                const pidPath = path.join(destinationPath, `${label.toLowerCase()}_pid.txt`);
                try {
                    fs.writeFileSync(pidPath, String(proc.pid));
                    sendLog(event, `📄 PID file written for ${label}: ${proc.pid}`);
                } catch (err) {
                    sendLog(event, `⚠️ Failed to write PID file for ${label}: ${err.message}`);
                }

                resolve(proc);

            }
        });



        const handleLine = (line) => {
            const msg = line.toString().trim();
            sendLog(event, `📩 ${label}: ${msg}`);
            if (!started && (msg.toLowerCase().includes("tray_app is ready") || msg.toLowerCase().includes("ready"))) {
                started = true;
                clearTimeout(timeout);
                sendLog(event, `✅ ${label} confirmed running`);
                resolve(proc);
            }
        };

        proc.stdout.on('data', handleLine);
        proc.stderr.on('data', handleLine);

        proc.on('error', err => {
            clearTimeout(timeout);
            exited = true;
            sendLog(event, `❌ ${label} Process failed: ${err.message}`);
            reject(err);
        });

        proc.on('exit', (code) => {
            exited = true;
            if (!started) {
                clearTimeout(timeout);
                sendLog(event, `❌ ${label} exited prematurely with code ${code}`);
                reject(new Error(`${label} exited with code ${code}`));
            }
        });


        proc.on('close', (code) => {
            if (!started) {
                sendLog(event, `❌ ${label} exited prematurely with code ${code}`);
                reject(new Error(`${label} exited with code ${code}`));
            }
        });

    });
}



ipcMain.handle('start-installation', async (event, installData) => {
    const selectedPath = installData.installPath;
    const normalized = selectedPath.replace(/\\/g, '/');
    const destinationPath = normalized.endsWith('/BreakEvenClient')
        ? selectedPath
        : path.join(selectedPath, 'BreakEvenClient');

    const envName = 'breakeven_env';
    const clientConfig = {
        version: "0.0.0.0",
        name: installData.name,
        email: installData.email,
        installPath: destinationPath,
        runTrayOnStartup: !!installData.runTrayOnStartup,
        runSlaveOnStartup: !!installData.runSlaveOnStartup,
        runAsRoot: !!installData.runAsRoot,
        autoUpdate: !!installData.autoUpdate,
        openDashboard: !!installData.openDashboard
    };

    const configPathGUI = path.join(destinationPath, 'installer_gui', 'client_config.json');
    const configPathRoot = path.join(destinationPath, 'client_config.json');
    const sourceTemplate = path.join(__dirname, 'BreakEvenClient_Template');
    const minicondaExe = path.join(destinationPath, 'miniconda_installer', 'Miniconda3-latest-Windows-x86_64.exe');
    const minicondaTargetDir = path.join(destinationPath, 'Miniconda3');
    const zipPath = path.join(__dirname, 'BreakEvenClient_Template.zip');

    let envCreated = false;

    try {
        sendProgress(event, 0);

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
        sendLog(event, `📦 Extracting template from ${zipPath} to ${destinationPath}`);

        try {
            const zip = new AdmZip(zipPath);
            const entries = zip.getEntries();

            // Determine if there's a single top-level folder
            const topLevelFolders = new Set(
                entries
                    .map(entry => entry.entryName.split('/')[0])
                    .filter(name => name && !name.endsWith('.'))
            );

            if (topLevelFolders.size === 1) {
                // Extract only contents inside the folder (not the folder itself)
                const topLevelFolder = [...topLevelFolders][0];
                sendLog(event, `📂 Detected folder: ${topLevelFolder}, extracting contents...`);

                entries.forEach(entry => {
                    if (entry.entryName.startsWith(topLevelFolder + '/')) {
                        const relativePath = entry.entryName.replace(topLevelFolder + '/', '');
                        const outputPath = path.join(destinationPath, relativePath);

                        if (entry.isDirectory) {
                            fs.mkdirSync(outputPath, { recursive: true });
                        } else {
                            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                            fs.writeFileSync(outputPath, entry.getData());
                        }
                    }
                });

            } else {
                // Extract as-is to destination
                zip.extractAllTo(destinationPath, true);
            }

            sendLog(event, `✅ Template extracted successfully.`);
        } catch (zipErr) {
            throw new Error(`❌ Failed to extract template: ${zipErr.message}`);
        }


        sendProgress(event, 20);
        fs.writeFileSync(configPathGUI, JSON.stringify(clientConfig, null, 2));
        fs.writeFileSync(configPathRoot, JSON.stringify(clientConfig, null, 2));
        sendLog(event, `✅ client_config.json saved`);

        sendProgress(event, 30);
        const condaExpectedPath = path.join(minicondaTargetDir, 'Scripts', 'conda.exe');
        if (!fs.existsSync(condaExpectedPath)) {
            sendLog(event, `⚙ Installing Miniconda...`);
            await new Promise((resolve, reject) => {
                const installer = spawn(minicondaExe, [
                    '/S', '/InstallationType=JustMe', '/AddToPath=0', '/RegisterPython=0', `/D=${minicondaTargetDir}`
                ], { detached: true, stdio: 'ignore', windowsHide: true });

                installer.on('close', code => {
                    if (code === 0) {
                        sendLog(event, `✅ Miniconda installed`);
                        resolve();
                    } else reject(new Error(`Miniconda installer exited with code ${code}`));
                });
                installer.on('error', reject);
            });
        } else sendLog(event, `✅ Miniconda already installed`);

        sendProgress(event, 60);
        const condaPath = path.join(minicondaTargetDir, 'Scripts', 'conda.exe');
        const requirementsPath = path.join(destinationPath, 'client_service', 'requirements.txt');

        sendLog(event, `📦 Creating Conda env: ${envName}`);
        await new Promise((resolve, reject) => {
            execFile(condaPath, ['create', '-y', '-n', envName, 'python=3.11'], (err) => {
                if (err) return reject(new Error('Failed to create Conda env: ' + err));
                sendLog(event, `✅ Conda env created`);
                envCreated = true;
                resolve();
            });
        });

        sendProgress(event, 85);
        sendLog(event, `📥 Installing requirements`);
        await new Promise((resolve, reject) => {
            execFile(condaPath, ['run', '-n', envName, 'pip', 'install', '-r', requirementsPath], (err, stdout, stderr) => {
                if (err) {
                    sendLog(event, `❌ Failed to install Python requirements: ${stderr || err.message}`);
                    return reject(new Error('Python requirements installation failed.'));
                }
                sendLog(event, `✅ Python requirements installed`);
                sendLog(event, `📦 stdout:\n${stdout}`);
                resolve();
            });
        });

        const servicesToLaunch = [];

        if (clientConfig.runTrayOnStartup) {
            const trayScript = path.join(destinationPath, 'client_service', 'tray_app.py');
            if (fs.existsSync(trayScript)) {
                await LaunchService(event, "Tray", trayScript, destinationPath);
                servicesToLaunch.push({ name: 'tray_app', script: trayScript });
            } else {
                throw new Error(`Tray script not found at ${trayScript}`);
            }
        }

        if (clientConfig.runSlaveOnStartup) {
            const slaveScript = path.join(destinationPath, 'client_service', 'Breakeven_Slave.py');

            if (fs.existsSync(slaveScript)) {
                try {
                    await LaunchService(event, "Slave", slaveScript, destinationPath);
                    servicesToLaunch.push({ name: 'slave_bot', script: slaveScript });
                } catch (err) {
                    sendLog(event, `❌ Slave failed to start: ${err.message}`);
                    // Not fatal — let the installation proceed
                }
            } else {
                sendLog(event, `❌ Slave script not found at ${slaveScript}`);
            }
        }

        if (clientConfig.autoUpdate) {
            const updaterScript = path.join(destinationPath, 'client_service', 'updater.py');
            if (fs.existsSync(updaterScript)) {
                try {
                    await LaunchService(event, "Updater", updaterScript, destinationPath);
                    makeAutoStartScript(updaterScript, 'updater_service', destinationPath);
                    sendLog(event, `⚙️ AutoStart set for updater_service`);
                } catch (err) {
                    sendLog(event, `❌ Updater failed to start: ${err.message}`);
                }
            } else {
                sendLog(event, `❌ Updater script not found at ${updaterScript}`);
            }
        }


        for (const service of servicesToLaunch) {
            makeAutoStartScript(service.script, service.name, destinationPath);
            sendLog(event, `⚙️ AutoStart set for ${service.name}`);
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
            const dashboardExePath = path.join(destinationPath, 'dashboard_gui', 'BreakEven Dashboard.exe');

            if (fs.existsSync(dashboardExePath)) {
                sendLog(event, `🚀 Launching Dashboard from ${dashboardExePath}`);
                try {
                    spawn(dashboardExePath, [], {
                        detached: true,
                        stdio: 'ignore',
                        windowsHide: true
                    }).unref();
                } catch (err) {
                    sendLog(event, `❌ Failed to launch dashboard: ${err.message}`);
                }
            } else {
                sendLog(event, `❌ Dashboard executable not found at ${dashboardExePath}`);
            }
        }

        return { success: true };


    } catch (err) {
        let errorMessage = err.message;
        if (envCreated) {
            await cleanupCondaEnv(destinationPath, envName, event);
        }
        if (errorMessage.includes('EPERM') || errorMessage.includes('permission denied')) {
            errorMessage += "\n⚠️ Access Denied. Run installer as admin or use a writeable folder.";
            sendLog(event, `⚠️ Suggestion: Use 'Run as Administrator'`);
        }
        sendLog(event, `❌ Error: ${errorMessage}`);
        return { success: false, error: errorMessage };
    }
});

ipcMain.handle('window-close', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.close();
});
ipcMain.handle('window-minimize', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.minimize();
});
