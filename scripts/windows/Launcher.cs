using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

internal static class Launcher
{
    private const string Title = "Namica Nexus";
    private const string BuiltNodePath = @"dist\windows-node.txt";
    private const string HostEntry = @"dist\apps\host\src\main.js";

    [STAThread]
    private static int Main()
    {
        return Run(
            url => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }),
            message => MessageBox.Show(message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error));
    }

    internal static int Run(Action<string> openConsole, Action<string> showError)
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            Directory.SetCurrentDirectory(root);
            string dataSetting = Environment.GetEnvironmentVariable("NEXUS_DATA_DIR");
            string dataDirectory = NormalizeDirectory(String.IsNullOrEmpty(dataSetting) ? "data" : dataSetting);
            int port = ReadPort();
            var address = new UriBuilder("http", "127.0.0.1", port).Uri;

            using (var startup = new Mutex(false, @"Local\NamicaNexus.Host." + port.ToString(CultureInfo.InvariantCulture)))
            {
                try
                {
                    if (!startup.WaitOne(TimeSpan.FromSeconds(25)))
                        throw new InvalidOperationException("另一个启动器仍在等待 Host。请稍后重试。");
                }
                catch (AbandonedMutexException)
                {
                    // The previous launcher exited during startup. Check the port again.
                }

                try
                {
                    EnsureHost(root, address, dataDirectory);
                }
                finally
                {
                    startup.ReleaseMutex();
                }
            }

            string consoleUrl = new Uri(address, "/console/").AbsoluteUri;
            try
            {
                openConsole(consoleUrl);
            }
            catch (Win32Exception error)
            {
                throw new InvalidOperationException("Host 已启动。请在浏览器中打开 " + consoleUrl + "\n\n" + error.Message, error);
            }

            return 0;
        }
        catch (Exception error)
        {
            showError(error.Message);
            return 1;
        }
    }

    private static int ReadPort()
    {
        string setting = Environment.GetEnvironmentVariable("NEXUS_PORT");
        if (setting == null)
            return 8080;

        int port;
        if (!Int32.TryParse(setting, NumberStyles.Integer, CultureInfo.InvariantCulture, out port) ||
            port < 1 || port > 65535)
            throw new InvalidOperationException("请将 NEXUS_PORT 设为 1 至 65535 的整数，或清除该变量以使用端口 8080。");

        return port;
    }

    private static string NormalizeDirectory(string directory)
    {
        string path = Path.GetFullPath(directory);
        return path.Length == Path.GetPathRoot(path).Length
            ? path
            : path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static void EnsureHost(string root, Uri address, string dataDirectory)
    {
        using (var http = new HttpClient(new HttpClientHandler {
            AllowAutoRedirect = false, UseCookies = false, UseProxy = false
        }) {
            Timeout = TimeSpan.FromSeconds(1),
            MaxResponseContentBufferSize = 16 * 1024
        })
        {
            var statusUrl = new Uri(address, "/api/manage/host/status");
            if (IsReady(http, statusUrl, dataDirectory))
                return;
            if (!CanBind(address.Port))
                throw PortInUse(address.Port, dataDirectory);

            if (!File.Exists(Path.Combine(root, HostEntry)) ||
                !File.Exists(Path.Combine(root, @"apps\web\dist\index.html")) ||
                !File.Exists(Path.Combine(root, @"apps\web\dist\console\index.html")))
                throw new InvalidOperationException("缺少 Host 或网页构建产物。请在项目目录运行 npm ci 和 npm run build。");

            var start = new ProcessStartInfo(FindNode(root), "\"" + HostEntry + "\"") {
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true
            };
            start.EnvironmentVariables["NEXUS_PORT"] = address.Port.ToString(CultureInfo.InvariantCulture);
            start.EnvironmentVariables["NEXUS_DATA_DIR"] = dataDirectory;

            using (var host = StartHost(start))
            {
                var timer = Stopwatch.StartNew();
                while (timer.Elapsed < TimeSpan.FromSeconds(18))
                {
                    if (IsReady(http, statusUrl, dataDirectory))
                        return;
                    if (host.HasExited)
                    {
                        // A terminal-launched Host may have won the port since preflight.
                        if (IsReady(http, statusUrl, dataDirectory))
                            return;
                        if (!CanBind(address.Port))
                            throw PortInUse(address.Port, dataDirectory);
                        throw new InvalidOperationException("Host 启动失败（退出码 " + host.ExitCode +
                            "）。请在项目目录运行 npm start 查看原因。");
                    }

                    Thread.Sleep(150);
                }

                throw new InvalidOperationException("等待 Host 就绪超时。请检查端口 " + address.Port +
                    " 和数据目录 " + dataDirectory + "，或在项目目录运行 npm start 查看原因。");
            }
        }
    }

    private static string FindNode(string root)
    {
        string buildNode = Path.Combine(root, BuiltNodePath);
        if (File.Exists(buildNode))
        {
            string executable = File.ReadAllText(buildNode);
            if (Path.IsPathRooted(executable) && File.Exists(executable))
                return executable;
        }

        return "node.exe";
    }

    private static Process StartHost(ProcessStartInfo start)
    {
        try
        {
            return Process.Start(start);
        }
        catch (Win32Exception error)
        {
            throw new InvalidOperationException("无法启动 Node.js。请确认 node.exe 位于 PATH 中，或在项目目录重新运行 npm run build。\n\n" +
                error.Message, error);
        }
    }

    private static InvalidOperationException PortInUse(int port, string dataDirectory)
    {
        return new InvalidOperationException("端口 " + port + " 已占用，未发现使用此数据目录的就绪 Host。\n\n" +
            dataDirectory + "\n\n请检查 NEXUS_DATA_DIR，或使用 NEXUS_PORT 指定其他端口。");
    }

    private static bool CanBind(int port)
    {
        using (var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp))
        {
            try
            {
                socket.ExclusiveAddressUse = true;
                socket.Bind(new IPEndPoint(IPAddress.Loopback, port));
                return true;
            }
            catch (SocketException error)
            {
                if (error.SocketErrorCode == SocketError.AddressAlreadyInUse || error.SocketErrorCode == SocketError.AccessDenied)
                    return false;
                throw;
            }
        }
    }

    private static bool IsReady(HttpClient http, Uri statusUrl, string dataDirectory)
    {
        try
        {
            using (var response = http.GetAsync(statusUrl).GetAwaiter().GetResult())
            {
                if (response.StatusCode != HttpStatusCode.OK)
                    return false;

                var json = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                var status = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
                return status != null && MatchesStatus(status, statusUrl.Port, dataDirectory);
            }
        }
        catch (HttpRequestException) { return false; }
        catch (OperationCanceledException) { return false; }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (NotSupportedException) { return false; }
    }

    private static bool MatchesStatus(Dictionary<string, object> status, int port, string dataDirectory)
    {
        object service, state, address, reportedPort, directory;
        return status.TryGetValue("service", out service) && Equals(service, "namica-nexus") &&
            status.TryGetValue("status", out state) && Equals(state, "running") &&
            status.TryGetValue("address", out address) && Equals(address, "127.0.0.1") &&
            status.TryGetValue("port", out reportedPort) && Equals(reportedPort, port) &&
            status.TryGetValue("dataDirectory", out directory) && directory is string &&
            Path.IsPathRooted((string)directory) &&
            SameDirectory(dataDirectory, NormalizeDirectory((string)directory));
    }

    private static bool SameDirectory(string expected, string reported)
    {
        if (String.Equals(expected, reported, StringComparison.Ordinal))
            return true;
        if (!String.Equals(Path.GetPathRoot(expected), Path.GetPathRoot(reported), StringComparison.OrdinalIgnoreCase))
            return false;

        // Directory IDs distinguish case-sensitive names and recognize Windows path aliases.
        DirectoryId expectedId, reportedId;
        return TryGetDirectoryId(expected, out expectedId) && TryGetDirectoryId(reported, out reportedId) &&
            expectedId.VolumeSerialNumber == reportedId.VolumeSerialNumber &&
            expectedId.Low == reportedId.Low && expectedId.High == reportedId.High;
    }

    private static bool TryGetDirectoryId(string path, out DirectoryId id)
    {
        const uint openExisting = 3;
        const uint openDirectory = 0x02000000;
        const int fileIdInfo = 18;
        id = new DirectoryId();

        using (var handle = CreateFile(path, 0, FileShare.ReadWrite | FileShare.Delete,
            IntPtr.Zero, openExisting, openDirectory, IntPtr.Zero))
        {
            return !handle.IsInvalid && GetFileInformationByHandleEx(handle, fileIdInfo,
                out id, (uint)Marshal.SizeOf(typeof(DirectoryId)));
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DirectoryId
    {
        public ulong VolumeSerialNumber;
        public ulong Low;
        public ulong High;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFile(string path, uint access, FileShare sharing,
        IntPtr security, uint disposition, uint attributes, IntPtr template);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,
        int infoClass, out DirectoryId info, uint size);
}
