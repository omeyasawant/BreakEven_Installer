using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;

namespace BreakEven.ServiceHost
{
    public class BreakEvenWorkerService : ServiceBase
    {
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
        }

        protected override void OnStart(string[] args)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_logFile) ?? AppDomain.CurrentDomain.BaseDirectory);
            Log(string.Format("Service starting (binary: {0})", _binaryPath));

            var psi = new ProcessStartInfo
            {
                FileName = _binaryPath,
                WorkingDirectory = Path.GetDirectoryName(_binaryPath) ?? Environment.CurrentDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            try
            {
                _process = Process.Start(psi);
            }
            catch (Exception ex)
            {
                Log(string.Format("Failed to start worker process: {0}", ex.Message));
                throw;
            }

            if (_process != null)
            {
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
            else
            {
                Log("Failed to start worker process: Process.Start returned null");
                throw new InvalidOperationException("Failed to start worker process.");
            }
        }

        protected override void OnStop()
        {
            _stopping = true;
            if (_process == null)
            {
                Log("Stop requested but worker process was null");
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
    }
}
