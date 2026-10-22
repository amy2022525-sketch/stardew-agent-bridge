using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace StardewAgentBridge;

// 网络线程只做「收帧 + 有界入队」；所有游戏 API 都在 ModEntry 的主线程回调里执行。
//
// 安全边界：
// - 只监听回环地址；
// - 拒绝带 Origin 头（网页）的请求，防止浏览器借本机端口操作游戏；
// - 必须携带 Bearer 令牌（来自本机受保护凭据文件，可轮换，无需重启游戏）；
// - 单帧与单连接都有上限，慢客户端不会拖住主线程。
public sealed class BridgeServer : IDisposable
{
    public sealed class Peer : IDisposable
    {
        public WebSocket Socket { get; }
        public CancellationTokenSource Lifetime { get; } = new();
        public bool Handshaken { get; set; }
        public string? ClientName { get; init; }
        private readonly SemaphoreSlim sending = new(1);

        public Peer(WebSocket socket) => Socket = socket;

        public async Task Send(Response response)
        {
            try
            {
                await sending.WaitAsync(Lifetime.Token);
                try
                {
                    var data = JsonSerializer.SerializeToUtf8Bytes(response, Protocol.Json);
                    await Socket.SendAsync(data, WebSocketMessageType.Text, true, Lifetime.Token);
                }
                finally { sending.Release(); }
            }
            catch (Exception) { Lifetime.Cancel(); }
        }

        public void Dispose()
        {
            try { Lifetime.Cancel(); } catch (Exception) { }
            try { Socket.Abort(); Socket.Dispose(); } catch (Exception) { }
        }
    }

    public sealed record Pending(Peer Peer, Request Request, DateTime Received);

    public readonly ConcurrentQueue<Pending> Inbox = new();

    private readonly HttpListener listener = new();
    private readonly ConcurrentDictionary<Peer, byte> peers = new();
    private readonly CancellationTokenSource shutdown = new();
    private readonly Func<string?> tokenProvider;
    private readonly Action<string, bool> log;
    private long lastFrameTicks;

    public int Port { get; }
    public string? LastRejectReason { get; private set; }

    public BridgeServer(int port, Func<string?> tokenProvider, Action<string, bool> log)
    {
        this.tokenProvider = tokenProvider;
        this.log = log;
        Port = port;
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        _ = Accept();
    }

    /// <summary>最近一次收到合法帧的时间（UTC ticks）；游戏侧 watchdog 用它判断 Bridge 是否失联。</summary>
    public DateTime? LastFrameAt => Interlocked.Read(ref lastFrameTicks) is var ticks && ticks > 0
        ? new DateTime(ticks, DateTimeKind.Utc)
        : null;

    public int PeerCount => peers.Count;

    private async Task Accept()
    {
        while (!shutdown.IsCancellationRequested)
        {
            HttpListenerContext context;
            try { context = await listener.GetContextAsync(); }
            catch (Exception) when (shutdown.IsCancellationRequested) { return; }
            catch (Exception error) { log($"接受连接失败：{error.Message}", true); continue; }

            if (!context.Request.IsWebSocketRequest)
            {
                LastRejectReason = "非 WebSocket 请求";
                context.Response.StatusCode = 400;
                context.Response.Close();
                continue;
            }
            if (context.Request.Headers["Origin"] != null)
            {
                LastRejectReason = "带 Origin 头（疑似网页）";
                context.Response.StatusCode = 403;
                context.Response.Close();
                continue;
            }
            if (peers.Count >= 4)
            {
                LastRejectReason = "连接数已达上限";
                context.Response.StatusCode = 429;
                context.Response.Close();
                continue;
            }
            var token = tokenProvider();
            if (string.IsNullOrEmpty(token))
            {
                LastRejectReason = "尚未生成凭据文件：请先启动一次 Stardew Agent Bridge";
                context.Response.StatusCode = 503;
                context.Response.Close();
                continue;
            }
            var header = context.Request.Headers["Authorization"];
            if (header == null || !header.StartsWith("Bearer ", StringComparison.Ordinal) || !CryptographicEquals(header.Substring(7).Trim(), token))
            {
                LastRejectReason = "令牌不匹配";
                context.Response.StatusCode = 401;
                context.Response.Close();
                continue;
            }
            _ = Serve(context);
        }
    }

    // 定长比较，避免按字节提前返回带来的时间差。
    private static bool CryptographicEquals(string provided, string expected)
    {
        var a = Encoding.UTF8.GetBytes(provided);
        var b = Encoding.UTF8.GetBytes(expected);
        if (a.Length != b.Length) return false;
        var diff = 0;
        for (var i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
        return diff == 0;
    }

    private async Task Serve(HttpListenerContext context)
    {
        Peer? peer = null;
        try
        {
            peer = new Peer((await context.AcceptWebSocketAsync(null)).WebSocket);
            peers.TryAdd(peer, 0);
            var buffer = new byte[16384];
            while (!peer.Lifetime.IsCancellationRequested)
            {
                using var frame = new MemoryStream();
                WebSocketReceiveResult read;
                do
                {
                    read = await peer.Socket.ReceiveAsync(new ArraySegment<byte>(buffer), peer.Lifetime.Token);
                    if (read.MessageType != WebSocketMessageType.Text) return;
                    frame.Write(buffer, 0, read.Count);
                    if (frame.Length > 262144) { LastRejectReason = "单帧超过 256 KiB"; return; }
                } while (!read.EndOfMessage);

                Interlocked.Exchange(ref lastFrameTicks, DateTime.UtcNow.Ticks);

                Request? request;
                try { request = JsonSerializer.Deserialize<Request>(frame.ToArray(), Protocol.Json); }
                catch (JsonException) { LastRejectReason = "帧不是合法 JSON"; return; }

                if (request == null || string.IsNullOrEmpty(request.RequestId) || request.RequestId.Length > 80) return;
                if (request.Op != null && request.Op != "request") return;
                if (request.Protocol != null && request.Protocol != Protocol.Name)
                {
                    await peer.Send(Response.Fail(request, "PROTOCOL_MISMATCH", $"需要协议 {Protocol.Name}。", 0, 0));
                    continue;
                }
                if (request.Args.ValueKind != JsonValueKind.Object || request.TimeoutMs < 100 || request.TimeoutMs > 120000)
                {
                    await peer.Send(Response.Fail(request, "INVALID_ARGUMENT", "args 或 timeoutMs 无效。", 0, 0));
                    continue;
                }
                if (Inbox.Count >= 64)
                {
                    await peer.Send(Response.Fail(request, "ACTION_BUSY", "请求队列已满。", 0, 0, true, "wait"));
                    continue;
                }
                Inbox.Enqueue(new(peer, request, DateTime.UtcNow));
            }
        }
        catch (Exception) { /* 对端退出只终止自己的连接；主线程会释放该连接拥有的动作。 */ }
        finally
        {
            if (peer != null)
            {
                peers.TryRemove(peer, out _);
                peer.Dispose();
            }
        }
    }

    public void InvalidateSessions()
    {
        foreach (var peer in peers.Keys) peer.Handshaken = false;
    }

    public bool DropAllPeers()
    {
        if (peers.IsEmpty) return false;
        foreach (var peer in peers.Keys) peer.Dispose();
        return true;
    }

    public void Dispose()
    {
        shutdown.Cancel();
        try { listener.Close(); } catch (Exception) { }
        foreach (var peer in peers.Keys) peer.Dispose();
    }
}
