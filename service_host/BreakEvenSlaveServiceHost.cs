using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;

namespace BreakEven.ServiceHost
{
    public class BreakEvenWorkerService : ServiceBase
    {
        private const uint CreateUnicodeEnvironment = 0x00000400;
        private const uint NormalPriorityClass = 0x00000020;
        private const uint InvalidSessionId = 0xFFFFFFFF;

        private Process _process;
        private readonly string _binaryPath;
        private readonly string _logFile;
        private bool _stopping;

        public BreakEvenWorkerService(string serviceName, string binaryPath, string logFile)
        {
            ServiceName = string.IsNullOrWhiteSpace(serviceName) ? "BreakEvenSlave" : serviceName;
            _binaryPath = binaryPath;
            _logFile = logFile;
            AutoLog = true;
            CanHandleSessionChangeEvent = true;
        }

        protected override void OnStart(string[] args)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_logFile) ?? AppDomain.CurrentDomain.BaseDirectory);
            Log(string.Format("Service starting (binary: {0})", _binaryPath));

            StartWorkerForCurrentContext(true);
        }

        protected override void OnSessionChange(SessionChangeDescription changeDescription)
        {
            base.OnSessionChange(changeDescription);

            if (!IsTrayService || _stopping)
            {
                return;
            }

            switch (changeDescription.Reason)
            {
                case SessionChangeReason.SessionLogon:
                case SessionChangeReason.ConsoleConnect:
                case SessionChangeReason.RemoteConnect:
                case SessionChangeReason.SessionUnlock:
                    TryRestartTrayForInteractiveSession(changeDescription.Reason.ToString());
                    break;
            }
        }

        private bool IsTrayService
        {
            get
            {
                return string.Equals(ServiceName, "BreakEvenTray", StringComparison.OrdinalIgnoreCase);
            }
        }

        private void StartWorkerForCurrentContext(bool failIfNoInteractiveSession)
        {
            DisposeExitedProcess();

            if (IsTrayService)
            {
                string deferredReason;
                if (TryStartTrayInInteractiveSession(out deferredReason))
                {
                    return;
                }

                if (!string.IsNullOrWhiteSpace(deferredReason))
                {
                    Log(deferredReason);
                    if (!failIfNoInteractiveSession)
                    {
                        return;
                    }
                }

                if (!failIfNoInteractiveSession)
                {
                    return;
                }

                throw new InvalidOperationException("Failed to launch BreakEven tray in an interactive user session.");
            }

            var psi = new ProcessStartInfo
            {
                FileName = _binaryPath,
                WorkingDirectory = Path.GetDirectoryName(_binaryPath) ?? Environment.CurrentDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            try
            {
                AttachProcess(Process.Start(psi), "service session");
            }
            catch (Exception ex)
            {
                Log(string.Format("Failed to start worker process: {0}", ex.Message));
                throw;
            }
        }

        private void TryRestartTrayForInteractiveSession(string reason)
        {
            try
            {
                DisposeExitedProcess();
                if (_process != null)
                {
                    Log(string.Format("Tray worker already running; ignoring session change {0}", reason));
                    return;
                }

                Log(string.Format("Attempting interactive tray launch after session event {0}", reason));
                StartWorkerForCurrentContext(false);
            }
            catch (Exception ex)
            {
                Log(string.Format("Failed to launch interactive tray after session event {0}: {1}", reason, ex.Message));
            }
        }

        protected override void OnStop()
        {
            _stopping = true;
            DisposeExitedProcess();

            if (_process == null)
            {
                Log("Stop requested but worker process was null");
                KillResidualProcesses();
                Log("Service stop completed.");
                return;
            }

            try
            {
                if (!_process.HasExited)
                {
                    Log("Attempting to stop worker process...");
                    _process.CloseMainWindow();
                    if (!_process.WaitForExit(5000))
                    {
                        _process.Kill();
                        _process.WaitForExit(5000);
                    }
                }
            }
            catch (Exception ex)
            {
                Log(string.Format("Error while stopping worker process: {0}", ex.Message));
            }
            finally
            {
                KillResidualProcesses();
                Log("Service stop completed.");
            }
        }

        private void DisposeExitedProcess()
        {
            if (_process == null)
            {
                return;
            }

            try
            {
                if (_process.HasExited)
                {
                    _process.Dispose();
                    _process = null;
                }
            }
            catch
            {
                _process = null;
            }
        }

        private void AttachProcess(Process process, string launchContext)
        {
            if (process == null)
            {
                Log("Failed to start worker process: Process.Start returned null");
                throw new InvalidOperationException("Failed to start worker process.");
            }

            _process = process;
            Log(string.Format("Worker started in {0} with PID {1}", launchContext, _process.Id));
            _process.EnableRaisingEvents = true;
            _process.Exited += (sender, eventArgs) =>
            {
                Log(string.Format("Worker stopped with exit code {0}", _process.ExitCode));
                if (!_stopping)
                {
                    try
                    {
                        Stop();
                    }
                    catch (Exception stopEx)
                    {
                        Log(string.Format("Error signaling service stop: {0}", stopEx.Message));
                    }
                }
            };
        }

        private bool TryStartTrayInInteractiveSession(out string deferredReason)
        {
            deferredReason = null;
            var sessionId = WTSGetActiveConsoleSessionId();
            if (sessionId == InvalidSessionId)
            {
                deferredReason = "No active console session detected; tray launch deferred until a user signs in.";
                return false;
            }

            IntPtr userToken = IntPtr.Zero;
            IntPtr environment = IntPtr.Zero;
            PROCESS_INFORMATION processInfo = new PROCESS_INFORMATION();

            try
            {
                if (!WTSQueryUserToken(sessionId, out userToken))
                {
                    deferredReason = string.Format("Unable to acquire user token for session {0}; tray launch deferred until sign-in completes.", sessionId);
                    return false;
                }

                CreateEnvironmentBlock(out environment, userToken, false);

                var startupInfo = new STARTUPINFO();
                startupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                startupInfo.lpDesktop = @"winsta0\default";

                var workingDirectory = Path.GetDirectoryName(_binaryPath) ?? Environment.CurrentDirectory;
                if (!CreateProcessAsUser(
                    userToken,
                    _binaryPath,
                    null,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    CreateUnicodeEnvironment | NormalPriorityClass,
                    environment,
                    workingDirectory,
                    ref startupInfo,
                    out processInfo))
                {
                    var win32Error = Marshal.GetLastWin32Error();
                    throw new InvalidOperationException(string.Format("CreateProcessAsUser failed with Win32 error {0}.", win32Error));
                }

                var launchedProcess = Process.GetProcessById((int)processInfo.dwProcessId);
                AttachProcess(launchedProcess, string.Format("interactive session {0}", sessionId));
                return true;
            }
            finally
            {
                if (processInfo.hThread != IntPtr.Zero)
                {
                    CloseHandle(processInfo.hThread);
                }

                if (processInfo.hProcess != IntPtr.Zero)
                {
                    CloseHandle(processInfo.hProcess);
                }

                if (environment != IntPtr.Zero)
                {
                    DestroyEnvironmentBlock(environment);
                }

                if (userToken != IntPtr.Zero)
                {
                    CloseHandle(userToken);
                }
            }
        }

        private void KillResidualProcesses()
        {
            try
            {
                var targetName = Path.GetFileNameWithoutExtension(_binaryPath);
                if (string.IsNullOrWhiteSpace(targetName))
                {
                    return;
                }

                foreach (var proc in Process.GetProcessesByName(targetName))
                {
                    try
                    {
                        if (proc.HasExited)
                        {
                            continue;
                        }

                        Log(string.Format("Force terminating orphaned {0} (PID {1})", proc.ProcessName, proc.Id));
                        proc.Kill();
                        proc.WaitForExit(5000);
                    }
                    catch (Exception inner)
                    {
                        Log(string.Format("Failed to terminate PID {0}: {1}", proc.Id, inner.Message));
                    }
                }
            }
            catch (Exception sweepEx)
            {
                Log(string.Format("Residual process sweep failed: {0}", sweepEx.Message));
            }
        }

        private void Log(string message)
        {
            var prefix = string.IsNullOrWhiteSpace(ServiceName) ? "BreakEvenService" : ServiceName;
            var line = string.Format("[{0:O}] [{1}] {2}{3}", DateTime.Now, prefix, message, Environment.NewLine);
            File.AppendAllText(_logFile, line);
        }

        public static void Main(string[] args)
        {
            string binaryPath = string.Empty;
            string logFile = string.Empty;
            string serviceName = "BreakEvenSlave";

            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--binary":
                        if (i + 1 < args.Length)
                        {
                            binaryPath = args[++i];
                        }
                        break;
                    case "--log":
                        if (i + 1 < args.Length)
                        {
                            logFile = args[++i];
                        }
                        break;
                    case "--serviceName":
                        if (i + 1 < args.Length)
                        {
                            serviceName = args[++i];
                        }
                        break;
                }
            }

            if (string.IsNullOrWhiteSpace(binaryPath))
            {
                throw new ArgumentException("Missing --binary argument for service host.");
            }

            if (string.IsNullOrWhiteSpace(logFile))
            {
                var fallbackName = string.IsNullOrWhiteSpace(serviceName)
                    ? "breakeven_service"
                    : serviceName.Replace(" ", "_");
                logFile = Path.Combine(
                    Path.GetDirectoryName(binaryPath) ?? AppDomain.CurrentDomain.BaseDirectory,
                    string.Format("{0}.log", fallbackName));
            }

            ServiceBase.Run(new BreakEvenWorkerService(serviceName, binaryPath, logFile));
        }

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessAsUser(
            IntPtr hToken,
            string lpApplicationName,
            string lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll")]
        private static extern uint WTSGetActiveConsoleSessionId();

        [DllImport("userenv.dll", SetLastError = true)]
        private static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

        [DllImport("userenv.dll", SetLastError = true)]
        private static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }
    }
}
