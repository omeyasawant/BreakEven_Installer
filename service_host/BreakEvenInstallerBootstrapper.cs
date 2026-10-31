using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace BreakEven.Bootstrapper
{
    internal static class Program
    {
        private const string InstallRootFolderName = "breakeveninstaller";
        private const string OfflineCacheRootFolderName = "BreakEvenInstallerCache";
        private const string InstalledAppExeName = "breakeveninstaller.exe";
        private const string EmbeddedSetupResourceName = "BreakEvenInstaller.SquirrelSetup.exe";
        private const string EmbeddedTemplateResourceName = "BreakEvenInstaller.BreakEvenClient_Template.zip";
        private const string OfflineAssetsFolderName = "offline-assets";
        private const string TemplateZipFileName = "BreakEvenClient_Template.zip";
        private const string BootstrapperElevatedLaunchArg = "--bootstrapper-elevated-launch";

        [STAThread]
        private static int Main(string[] args)
        {
            var silentInstall = HasSilentFlag(args);
            var tempRoot = Path.Combine(
                Path.GetTempPath(),
                "BreakEvenInstallerBootstrapper",
                Guid.NewGuid().ToString("N"));

            try
            {
                Directory.CreateDirectory(tempRoot);

                var setupPath = Path.Combine(tempRoot, "BreakEven-Installer-SquirrelSetup.exe");
                var templatePath = Path.Combine(tempRoot, TemplateZipFileName);
                ExtractEmbeddedResource(EmbeddedSetupResourceName, setupPath);
                ExtractEmbeddedResource(EmbeddedTemplateResourceName, templatePath);

                var setupExitCode = RunProcess(setupPath, args, tempRoot, true);
                if (setupExitCode != 0)
                {
                    return setupExitCode;
                }

                var installRoot = GetInstallRoot();
                var installedAppDir = WaitForInstalledAppDir(installRoot, TimeSpan.FromMinutes(5));
                if (string.IsNullOrWhiteSpace(installedAppDir))
                {
                    throw new InvalidOperationException(
                        "Squirrel completed but the installed app directory could not be located.");
                }

                var offlineCacheRoot = GetOfflineCacheRoot();
                var offlineAssetsDir = Path.Combine(offlineCacheRoot, OfflineAssetsFolderName);
                var installRootTemplatePath = Path.Combine(installRoot, TemplateZipFileName);
                var offlineTemplatePath = Path.Combine(offlineAssetsDir, TemplateZipFileName);
                var installedResourcesDir = Path.Combine(installedAppDir, "resources");
                var installedResourceTemplatePath = Path.Combine(installedResourcesDir, TemplateZipFileName);

                ResetTemplateCachePaths(
                    offlineCacheRoot,
                    offlineAssetsDir,
                    installRootTemplatePath,
                    offlineTemplatePath,
                    installedResourcesDir,
                    installedResourceTemplatePath);

                File.Copy(templatePath, installRootTemplatePath, true);
                File.Copy(templatePath, offlineTemplatePath, true);

                File.Copy(templatePath, installedResourceTemplatePath, true);

                var installRootTemplateInfo = new FileInfo(installRootTemplatePath);
                if (!installRootTemplateInfo.Exists || installRootTemplateInfo.Length <= 0)
                {
                    throw new InvalidOperationException(
                        "Failed to persist the BreakEven template zip at the install root.");
                }

                var offlineTemplateInfo = new FileInfo(offlineTemplatePath);
                if (!offlineTemplateInfo.Exists || offlineTemplateInfo.Length <= 0)
                {
                    throw new InvalidOperationException(
                        "Failed to persist the offline BreakEven template zip after installation.");
                }

                var installedResourceTemplateInfo = new FileInfo(installedResourceTemplatePath);
                if (!installedResourceTemplateInfo.Exists || installedResourceTemplateInfo.Length <= 0)
                {
                    throw new InvalidOperationException(
                        "Failed to copy the BreakEven template zip into the installed app resources.");
                }

                if (!silentInstall)
                {
                    LaunchInstalledApp(installedAppDir);
                }

                return 0;
            }
            catch (Exception ex)
            {
                if (!silentInstall)
                {
                    MessageBox.Show(
                        ex.Message,
                        "BreakEven Installer",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                }
                return 1;
            }
            finally
            {
                TryDeleteDirectory(tempRoot);
            }
        }

        private static bool HasSilentFlag(string[] args)
        {
            foreach (var arg in args)
            {
                var normalized = (arg ?? string.Empty).Trim().ToLowerInvariant();
                if (normalized == "--silent" || normalized == "/silent" || normalized == "/s")
                {
                    return true;
                }
            }

            return false;
        }

        private static string GetInstallRoot()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                InstallRootFolderName);
        }

        private static string GetOfflineCacheRoot()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                OfflineCacheRootFolderName);
        }

        private static void ResetTemplateCachePaths(
            string offlineCacheRoot,
            string offlineAssetsDir,
            string installRootTemplatePath,
            string offlineTemplatePath,
            string installedResourcesDir,
            string installedResourceTemplatePath)
        {
            Directory.CreateDirectory(offlineCacheRoot);
            TryDeleteFile(installRootTemplatePath);
            TryDeleteDirectory(offlineAssetsDir);
            Directory.CreateDirectory(offlineAssetsDir);

            Directory.CreateDirectory(installedResourcesDir);
            TryDeleteFile(installedResourceTemplatePath);
            TryDeleteFile(offlineTemplatePath);
        }

        private static void ExtractEmbeddedResource(string resourceName, string outputPath)
        {
            var assembly = Assembly.GetExecutingAssembly();
            using (var resourceStream = assembly.GetManifestResourceStream(resourceName))
            {
                if (resourceStream == null)
                {
                    throw new InvalidOperationException(
                        string.Format("Missing embedded resource: {0}", resourceName));
                }

                var parentDirectory = Path.GetDirectoryName(outputPath);
                if (!string.IsNullOrWhiteSpace(parentDirectory))
                {
                    Directory.CreateDirectory(parentDirectory);
                }

                using (var fileStream = File.Create(outputPath))
                {
                    resourceStream.CopyTo(fileStream);
                }
            }
        }

        private static int RunProcess(string filePath, string[] args, string workingDirectory, bool waitForExit)
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = filePath,
                Arguments = BuildArgumentString(args),
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = false,
            };

            using (var process = Process.Start(startInfo))
            {
                if (process == null)
                {
                    throw new InvalidOperationException(
                        string.Format("Failed to launch process: {0}", filePath));
                }

                if (!waitForExit)
                {
                    return 0;
                }

                process.WaitForExit();
                return process.ExitCode;
            }
        }

        private static string BuildArgumentString(string[] args)
        {
            if (args == null || args.Length == 0)
            {
                return string.Empty;
            }

            var parts = new string[args.Length];
            for (var index = 0; index < args.Length; index++)
            {
                parts[index] = QuoteArgument(args[index] ?? string.Empty);
            }
            return string.Join(" ", parts);
        }

        private static string QuoteArgument(string value)
        {
            if (value.Length == 0)
            {
                return "\"\"";
            }

            var requiresQuotes = false;
            foreach (var character in value)
            {
                if (char.IsWhiteSpace(character) || character == '"')
                {
                    requiresQuotes = true;
                    break;
                }
            }

            if (!requiresQuotes)
            {
                return value;
            }

            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        private static string WaitForInstalledAppDir(string installRoot, TimeSpan timeout)
        {
            var deadline = DateTime.UtcNow.Add(timeout);
            while (DateTime.UtcNow < deadline)
            {
                var installedAppDir = GetLatestInstalledAppDir(installRoot);
                if (!string.IsNullOrWhiteSpace(installedAppDir))
                {
                    return installedAppDir;
                }

                Thread.Sleep(1000);
            }

            return null;
        }

        private static string GetLatestInstalledAppDir(string installRoot)
        {
            if (!Directory.Exists(installRoot))
            {
                return null;
            }

            var latestDirectory = string.Empty;
            foreach (var directory in Directory.GetDirectories(installRoot, "app-*", SearchOption.TopDirectoryOnly))
            {
                if (string.CompareOrdinal(directory, latestDirectory) > 0)
                {
                    latestDirectory = directory;
                }
            }

            return string.IsNullOrWhiteSpace(latestDirectory) ? null : latestDirectory;
        }

        private static void LaunchInstalledApp(string installedAppDir)
        {
            var installedAppPath = Path.Combine(installedAppDir, InstalledAppExeName);
            if (!File.Exists(installedAppPath))
            {
                throw new FileNotFoundException(
                    "Installed BreakEven app executable was not found.",
                    installedAppPath);
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = installedAppPath,
                WorkingDirectory = installedAppDir,
                UseShellExecute = false,
                Arguments = BootstrapperElevatedLaunchArg,
            };

            Process.Start(startInfo);
        }

        private static void TryDeleteDirectory(string targetPath)
        {
            if (string.IsNullOrWhiteSpace(targetPath) || !Directory.Exists(targetPath))
            {
                return;
            }

            try
            {
                Directory.Delete(targetPath, true);
            }
            catch
            {
                // Best effort cleanup only.
            }
        }

        private static void TryDeleteFile(string targetPath)
        {
            if (string.IsNullOrWhiteSpace(targetPath) || !File.Exists(targetPath))
            {
                return;
            }

            try
            {
                File.Delete(targetPath);
            }
            catch
            {
                // Best effort cleanup only.
            }
        }
    }
}
