/**
 * 浏览器预览用的 Tauri API mock。
 * 仅当不在 Tauri 环境（无 __TAURI_INTERNALS__）时生效，
 * 真实桌面应用中完全惰性。用于在不编译 Rust 的情况下走查 UI。
 */
(function () {
  if (typeof window === "undefined") return;
  if (window.__TAURI_INTERNALS__) return;

  const now = Math.floor(Date.now() / 1000);
  const containers = [
    {
      id: "a1b2c3d4e5f6789012345678901234567890abcd",
      name: "nginx-proxy",
      image: "nginx:1.27-alpine",
      state: "running",
      status: "Up 3 hours",
      created: now - 3600 * 3,
      ports: [
        { ip: "0.0.0.0", private_port: 80, public_port: 8080, proto: "tcp" },
        { ip: "0.0.0.0", private_port: 443, public_port: 8443, proto: "tcp" },
        { ip: "::", private_port: 80, public_port: 8081, proto: "tcp" },
      ],
    },
    {
      id: "b2c3d4e5f6a7789012345678901234567890abcd",
      name: "redis-cache",
      image: "redis:7.4",
      state: "running",
      status: "Up 26 hours",
      created: now - 3600 * 26,
      ports: [{ ip: "127.0.0.1", private_port: 6379, public_port: 6379, proto: "tcp" }],
    },
    {
      id: "c3d4e5f6a7b8789012345678901234567890abcd",
      name: "postgres-db",
      image: "postgres:16.4",
      state: "running",
      status: "Up 2 days (healthy)",
      created: now - 3600 * 50,
      ports: [{ ip: "0.0.0.0", private_port: 5432, public_port: 5433, proto: "tcp" }],
    },
    {
      id: "d4e5f6a7b8c9789012345678901234567890abcd",
      name: "buildkit-daemon",
      image: "moby/buildkit:v0.16",
      state: "exited",
      status: "Exited (0) 5 minutes ago",
      created: now - 3600 * 72,
      ports: [],
    },
    {
      id: "e5f6a7b8c9d0789012345678901234567890abcd",
      name: "watchtower",
      image: "containrrr/watchtower",
      state: "paused",
      status: "Up 4 days (Paused)",
      created: now - 3600 * 96,
      ports: [],
    },
  ];

  const images = [
    { id: "sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff", tags: ["nginx:1.27-alpine", "nginx:latest"], size: 43_200_000, created: now - 86400 * 5 },
    { id: "sha256:222233334444555566667777888899990000aaaabbbbccccddddeeeeffff1111", tags: ["redis:7.4"], size: 116_800_000, created: now - 86400 * 12 },
    { id: "sha256:33334444555566667777888899990000aaaabbbbccccddddeeeeffff11112222", tags: ["postgres:16.4"], size: 431_000_000, created: now - 86400 * 30 },
    { id: "sha256:4444555566667777888899990000aaaabbbbccccddddeeeeffff111122223333", tags: [], size: 88_500_000, created: now - 86400 * 60 },
  ];

  const info = {
    version: "27.3.1",
    api_version: "1.51",
    os: "linux",
    arch: "x86_64",
    containers: containers.length,
    running: containers.filter((c) => c.state === "running").length,
    paused: containers.filter((c) => c.state === "paused").length,
    stopped: containers.filter((c) => c.state === "exited").length,
    images: images.length,
  };

  let tick = 0;
  const statsTick = () => {
    tick++;
    const wave = Math.sin(tick / 5) * 0.5 + 0.5;
    return {
      cpu_percent: 12 + wave * 46,
      mem_usage: 320 * 1024 * 1024 + wave * 90 * 1024 * 1024,
      mem_limit: 4 * 1024 * 1024 * 1024,
      mem_percent: 8 + wave * 3,
      net_rx: 1024 * 1024 * 260 + tick * 4096,
      net_tx: 1024 * 1024 * 96 + tick * 2048,
      block_read: 1024 * 1024 * 1200,
      block_write: 1024 * 1024 * 340,
    };
  };

  const streams = {};
  const chIndex = new Map();
  const debug = { pushed: 0, misses: 0, streams: {} };
  window.__MOCK_DEBUG__ = debug;

  /** 向 Channel 推数据：走 transformCallback 注册的 window['_id'] 回调，带顺序索引 */
  function push(ch, data) {
    if (!ch || ch.id === undefined) return;
    const fn = window[`_${ch.id}`];
    if (typeof fn !== "function") {
      debug.misses++;
      return;
    }
    const idx = chIndex.get(ch.id) ?? 0;
    chIndex.set(ch.id, idx + 1);
    debug.pushed++;
    fn({ index: idx, message: data });
  }

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    plugins: {},
    invoke: (cmd, args) => {
      switch (cmd) {
        case "docker_info":
          return Promise.resolve(info);
        case "list_containers":
          return Promise.resolve(containers);
        case "list_images":
          return Promise.resolve(images);
        case "container_action":
        case "remove_image":
          return Promise.resolve();
        case "subscribe_events":
        case "stream_logs":
        case "stream_stats":
        case "pull_image":
        case "exec_create":
        case "exec_attach": {
          const sid = `sid-${cmd}-${Math.random().toString(36).slice(2, 8)}`;
          streams[sid] = args;
          // 模拟 stats 流：每秒推一个 tick
          if (cmd === "stream_stats") {
            const timer = setInterval(() => {
              if (streams[sid] === undefined) return clearInterval(timer);
              push(args.onTick, statsTick());
            }, 1000);
          }
          if (cmd === "stream_logs") {
            let n = 0;
            const levels = [
              ["out", "info"],
              ["out", "info"],
              ["out", "warn"],
              ["err", "error"],
            ];
            const timer = setInterval(() => {
              if (streams[sid] === undefined) return clearInterval(timer);
              const [stream, level] = levels[n % 4];
              push(args.onChunk, {
                stream,
                data: `2026-09-19T1${n % 10}:22:33 ${level}  nginx-proxy  request served in ${20 + ((n * 7) % 80)}ms (mock #${n})\n`,
              });
              n++;
            }, 400);
          }
          if (cmd === "exec_attach") {
            let n = 0;
            const timer = setInterval(() => {
              if (streams[sid] === undefined) return clearInterval(timer);
              const lines = [
                "\r\n\u001b[32mroot@nginx-proxy\u001b[0m:/# echo welcome to DockPilot mock\r\n",
                "welcome to DockPilot mock\r\n",
                "\u001b[32mroot@nginx-proxy\u001b[0m:/# ls /usr/share/nginx\r\n",
                "html  modules\r\n",
              ];
              push(args.onChunk, lines[n % lines.length]);
              n++;
            }, 900);
          }
          return Promise.resolve(sid);
        }
        case "cancel_stream": {
          const sid = args.streamId;
          delete streams[sid];
          return Promise.resolve();
        }
        case "exec_input":
        case "exec_resize":
          return Promise.resolve();
        default:
          console.warn("[tauri-mock] unhandled invoke:", cmd, args);
          return Promise.resolve();
      }
    },
    transformCallback: (callback, once) => {
      const id = `mockcb-${Math.random().toString(36).slice(2, 10)}`;
      Object.defineProperty(window, `_${id}`, {
        value: callback,
        writable: !once,
        configurable: true,
      });
      return id;
    },
    unregisterCallback: (id) => {
      delete window[`_${id}`];
    },
    // Channel 通过 onmessage 回调，mock 直接调用对象方法即可
  };

  console.info("[tauri-mock] active — browser preview mode");
})();
