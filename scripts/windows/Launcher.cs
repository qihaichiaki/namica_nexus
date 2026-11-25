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
using System.Security.Cryptography;
using System.Text;
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
            var seed = new Endpoint(Environment.GetEnvironmentVariable("NEXUS_ADDRESS") ?? "127.0.0.1", port, dataDirectory);
            string profile = ProfilePath(root, seed);
            Uri address;

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
                    Endpoint active = seed, pending = seed;
                    if (File.Exists(profile))
                    {
                        var state = new JavaScriptSerializer().Deserialize<DeploymentState>(File.ReadAllText(profile));
                        active = state.active.Validate();
                        pending = state.pending.Validate();
                    }
                    address = EnsureHost(root, active, pending, seed, profile);
                }
                finally
                {
                    startup.ReleaseMutex();
                }
            }

            string hostName = address.HostNameType == UriHostNameType.IPv6 ? "[::1]" : "127.0.0.1";
            string consoleUrl = "http://" + hostName + (address.IsDefaultPort ? "" : ":" + address.Port.ToString(CultureInfo.InvariantCulture)) + "/console/";
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

    // The profile name must match deploymentProfile() in the Host.
    private static string ProfilePath(string root, Endpoint seed)
    {
        var explicitFile = Environment.GetEnvironmentVariable("NEXUS_DEPLOYMENT_FILE");
        if (!String.IsNullOrEmpty(explicitFile)) return Path.GetFullPath(explicitFile);
        var key = seed.address + "\n" + seed.port.ToString(CultureInfo.InvariantCulture) + "\n" + seed.dataDirectory;
        using (var sha = SHA256.Create())
            return Path.Combine(root, ".nexus-deployment", BitConverter.ToString(
                sha.ComputeHash(Encoding.UTF8.GetBytes(key))).Replace("-", "").ToLowerInvariant() + ".json");
    }

    internal sealed class DeploymentState
    {
        public Endpoint active { get; set; }
        public Endpoint pending { get; set; }
    }

    internal sealed class Endpoint
    {
        public string address { get; set; }
        public int port { get; set; }
        public string dataDirectory { get; set; }

        public Endpoint() { }
        public Endpoint(string name, int number, string path)
        {
            address = name; port = number; dataDirectory = path;
            Validate();
        }
        internal Endpoint Validate()
        {
            if ((address != "127.0.0.1" && address != "::1") || port < 1 || port > 65535 ||
                String.IsNullOrEmpty(dataDirectory) || !Path.IsPathRooted(dataDirectory))
                throw new InvalidOperationException("部署配置中的监听地址、端口或数据目录无效。");
            return this;
        }
        internal Uri Uri { get { return new UriBuilder("http", address, port).Uri; } }
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

    private static Uri EnsureHost(string root, Endpoint active, Endpoint pending, Endpoint seed, string profile)
    {
        using (var http = new HttpClient(new HttpClientHandler {
            AllowAutoRedirect = false, UseCookies = false, UseProxy = false
        }) {
            Timeout = TimeSpan.FromSeconds(1),
            MaxResponseContentBufferSize = 16 * 1024
        })
        {
            if (IsReady(http, active))
                return active.Uri;
            if (active.Uri == pending.Uri && !CanBind(active))
                throw PortInUse(active.port, active.dataDirectory);

            if (!File.Exists(Path.Combine(root, HostEntry)) ||
                !File.Exists(Path.Combine(root, @"apps\web\dist\index.html")) ||
                !File.Exists(Path.Combine(root, @"apps\web\dist\console\index.html")))
                throw new InvalidOperationException("缺少 Host 或网页构建产物。请在项目目录运行 npm ci 和 npm run build。");

            var start = new ProcessStartInfo(FindNode(root), "\"" + HostEntry + "\"") {
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true
            };
            start.EnvironmentVariables["NEXUS_DEPLOYMENT_FILE"] = profile;
            start.EnvironmentVariables["NEXUS_PORT"] = seed.port.ToString(CultureInfo.InvariantCulture);
            start.EnvironmentVariables["NEXUS_ADDRESS"] = seed.address;
            start.EnvironmentVariables["NEXUS_DATA_DIR"] = seed.dataDirectory;

            using (var host = StartHost(start))
            {
                var timer = Stopwatch.StartNew();
                bool migrating = !String.Equals(active.dataDirectory, pending.dataDirectory, StringComparison.Ordinal);
                while (timer.Elapsed < (migrating ? TimeSpan.FromMinutes(10) : TimeSpan.FromSeconds(18)))
                {
                    if (IsReady(http, pending)) return pending.Uri;
                    if ((active.Uri != pending.Uri || migrating) && IsReady(http, active)) return active.Uri;
                    if (host.HasExited)
                    {
                        // A terminal-launched Host may have won the port since preflight.
                        if (IsReady(http, active)) return active.Uri;
                        if (!CanBind(pending)) throw PortInUse(pending.port, pending.dataDirectory);
                        throw new InvalidOperationException("Host 启动失败（退出码 " + host.ExitCode +
                            "）。请在项目目录运行 npm start 查看原因。");
                    }

                    Thread.Sleep(150);
                }

                throw new InvalidOperationException("等待 Host 就绪超时。请检查端口 " + pending.port +
                    " 和数据目录 " + pending.dataDirectory + "，或在项目目录运行 npm start 查看原因。");
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

    private static bool CanBind(Endpoint endpoint)
    {
        var ip = IPAddress.Parse(endpoint.address);
        using (var socket = new Socket(ip.AddressFamily, SocketType.Stream, ProtocolType.Tcp))
        {
            try
            {
                socket.ExclusiveAddressUse = true;
                socket.Bind(new IPEndPoint(ip, endpoint.port));
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

    private static bool IsReady(HttpClient http, Endpoint endpoint)
    {
        try
        {
            using (var response = http.GetAsync(new Uri(endpoint.Uri, "/api/manage/host/status")).GetAwaiter().GetResult())
            {
                if (response.StatusCode != HttpStatusCode.OK)
                    return false;

                var json = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                var status = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
                return status != null && MatchesStatus(status, endpoint);
            }
        }
        catch (HttpRequestException) { return false; }
        catch (OperationCanceledException) { return false; }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (NotSupportedException) { return false; }
    }

    private static bool MatchesStatus(Dictionary<string, object> status, Endpoint endpoint)
    {
        object service, state, address, reportedPort, directory;
        return status.TryGetValue("service", out service) && Equals(service, "namica-nexus") &&
            status.TryGetValue("status", out state) && Equals(state, "running") &&
            status.TryGetValue("address", out address) && Equals(address, endpoint.address) &&
            status.TryGetValue("port", out reportedPort) && Equals(reportedPort, endpoint.port) &&
            status.TryGetValue("dataDirectory", out directory) && directory is string &&
            Path.IsPathRooted((string)directory) &&
            SameDirectory(endpoint.dataDirectory, NormalizeDirectory((string)directory));
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
