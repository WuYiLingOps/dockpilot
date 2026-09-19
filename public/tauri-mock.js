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
      name: "redis-prod",
      image: "registry.cn-hangzhou.aliyuncs.com/wylhub/redis:7-alpine",
      state: "running",
      status: "Up 51 minutes",
      created: now - 3600,
      ports: [{ ip: "0.0.0.0", private_port: 6379, public_port: 6379, proto: "tcp" }],
    },
    {
      id: "b2c3d4e5f6a7789012345678901234567890abcd",
      name: "pg-prod",
      image: "registry.cn-hangzhou.aliyuncs.com/wylhub/postgres:17-alpine",
      state: "running",
      status: "Up 53 minutes",
      created: now - 3600 * 2,
      ports: [{ ip: "0.0.0.0", private_port: 5432, public_port: 5432, proto: "tcp" }],
    },
    {
      id: "c3d4e5f6a7b8789012345678901234567890abcd",
      name: "nexus3",
      image: "registry.cn-hangzhou.aliyuncs.com/wylhub/nexus3:3.93.2",
      state: "running",
      status: "Up 2 days",
      created: now - 3600 * 50,
      ports: [{ ip: "0.0.0.0", private_port: 8081, public_port: 8081, proto: "tcp" }],
    },
    {
      id: "d4e5f6a7b8c9789012345678901234567890abcd",
      name: "jellyfin",
      image: "registry.cn-hangzhou.aliyuncs.com/wylhub/jellyfin:latest",
      state: "running",
      status: "Up 5 days (healthy)",
      created: now - 3600 * 120,
      ports: [{ ip: "0.0.0.0", private_port: 8096, public_port: 8096, proto: "tcp" }],
    },
    {
      id: "e5f6a7b8c9d0789012345678901234567890abcd",
      name: "dpanel",
      image: "dpanel/dpanel:latest",
      state: "exited",
      status: "Exited (0) 3 days ago",
      created: now - 3600 * 200,
      ports: [],
    },
    // ---- compose 项目 myapp-stack 的三个服务容器（部分运行，便于走查状态展示） ----
    {
      id: "f6a7b8c9d0e1789012345678901234567890abcd",
      name: "myapp-stack-web-1",
      image: "nginx:1.27-alpine",
      state: "running",
      status: "Up 20 minutes",
      created: now - 3600 * 3,
      ports: [{ ip: "0.0.0.0", private_port: 80, public_port: 8080, proto: "tcp" }],
      compose_project: "myapp-stack",
      compose_service: "web",
    },
    {
      id: "a7b8c9d0e1f2789012345678901234567890abcd",
      name: "myapp-stack-api-1",
      image: "registry.cn-hangzhou.aliyuncs.com/wylhub/gin-vue3-blog:latest",
      state: "running",
      status: "Up 20 minutes",
      created: now - 3600 * 3,
      ports: [{ ip: "0.0.0.0", private_port: 8080, public_port: 8081, proto: "tcp" }],
      compose_project: "myapp-stack",
      compose_service: "api",
    },
    {
      id: "b8c9d0e1f2a3789012345678901234567890abcd",
      name: "myapp-stack-db-1",
      image: "registry.cn-hangzhou.aliyuncs.com/wylhub/postgres:17-alpine",
      state: "exited",
      status: "Exited (0) 8 minutes ago",
      created: now - 3600 * 3,
      ports: [],
      compose_project: "myapp-stack",
      compose_service: "db",
    },
  ];

  const images = [
    { id: "sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff", tags: ["goharbor/harbor-core:v2.13.2"], size: 409_000_000, created: now - 86400 * 3 },
    { id: "sha256:222233334444555566667777888899990000aaaabbbbccccddddeeeeffff1111", tags: ["goharbor/harbor-db:v2.13.2"], size: 566_000_000, created: now - 86400 * 3 },
    { id: "sha256:33334444555566667777888899990000aaaabbbbccccddddeeeeffff11112222", tags: ["goharbor/redis-photon:v2.13.2"], size: 341_000_000, created: now - 86400 * 3 },
    { id: "sha256:4444555566667777888899990000aaaabbbbccccddddeeeeffff111122223333", tags: ["goharbor/nginx-photon:v2.13.2"], size: 311_000_000, created: now - 86400 * 3 },
    { id: "sha256:555566667777888899990000aaaabbbbccccddddeeeeffff1111222233334444", tags: ["registry.cn-hangzhou.aliyuncs.com/wylhub/gin-vue3-blog:latest"], size: 288_000_000, created: now - 86400 * 15 },
    { id: "sha256:66667777888899990000aaaabbbbccccddddeeeeffff11112222333344445555", tags: ["registry.cn-hangzhou.aliyuncs.com/wylhub/nexus3:3.93.2"], size: 1_130_000_000, created: now - 86400 * 30 },
    { id: "sha256:7777888899990000aaaabbbbccccddddeeeeffff111122223333444455556666", tags: ["registry.cn-hangzhou.aliyuncs.com/wylhub/postgres:17-alpine"], size: 399_000_000, created: now - 86400 * 30 },
    { id: "sha256:888899990000aaaabbbbccccddddeeeeffff1111222233334444555566667777", tags: ["registry.aliyuncs.com/openspug/spug:latest"], size: 1_050_000_000, created: now - 86400 * 60 },
    { id: "sha256:99990000aaaabbbbccccddddeeeeffff11112222333344445555666677778888", tags: ["dpanel/dpanel:latest"], size: 339_000_000, created: now - 86400 * 10 },
    { id: "sha256:aaaa0000bbbbccccddddeeeeffff111122223333444455556666777788889999", tags: ["nginx:1.27-alpine", "nginx:latest"], size: 43_200_000, created: now - 86400 * 5 },
    { id: "sha256:bbbb0000ccccddddeeeeffff1111222233334444555566667777888899990000", tags: [], size: 88_500_000, created: now - 86400 * 90 },
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
    ncpu: 8,
    mem_total: 62.58 * 1024 * 1024 * 1024,
    driver: "overlay2",
    docker_root_dir: "/var/lib/docker",
    kernel_version: "7.0.0-30-generic",
    os_name: "Ubuntu 24.04.4 LTS",
    os_type: "linux",
    logging_driver: "json-file",
    plugins_volume: ["local"],
    plugins_network: ["bridge", "host", "ipvlan", "macvlan", "null", "overlay"],
    host: "unix:///var/run/docker.sock",
  };

  // ---- 设置 / 镜像加速 / 空间清理 ----
  const settings = {
    theme: "system",
    docker_socket: "",
    containers_refresh_secs: 10,
    images_refresh_secs: 20,
    logs_default_tail: 1000,
    logs_timestamps: false,
    terminal_shell: "bash",
    mirror_custom: ["https://docker.example.dev"],
  };

  // ---- 编排（docker compose）----
  const composeProjectDir = (name) => `/home/user/${name}`;

  /** 从容器数组实时聚合 compose 项目，与真实后端的标签分组口径一致 */
  function composeProjects() {
    const byProject = new Map();
    for (const c of containers) {
      if (!c.compose_project) continue;
      if (!byProject.has(c.compose_project)) {
        byProject.set(c.compose_project, {
          name: c.compose_project,
          working_dir: composeProjectDir(c.compose_project),
          config_files: [`${composeProjectDir(c.compose_project)}/compose.yaml`],
          services: [],
          running_count: 0,
          total_count: 0,
        });
      }
      const p = byProject.get(c.compose_project);
      p.services.push({
        name: c.compose_service ?? c.name,
        container_id: c.id,
        state: c.state,
        status: c.status,
        image: c.image,
        ports: c.ports,
      });
      p.total_count++;
      if (c.state === "running") p.running_count++;
    }
    return [...byProject.values()];
  }

  const composeYamlSample = `services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "8080:80"
    depends_on:
      - api
  api:
    image: registry.cn-hangzhou.aliyuncs.com/wylhub/gin-vue3-blog:latest
    environment:
      DATABASE_URL: postgres://app:secret@db:5432/app
  db:
    image: registry.cn-hangzhou.aliyuncs.com/wylhub/postgres:17-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
`;

  /** 模拟一次 compose CLI 流式输出，结束时按动作翻转 mock 容器状态 */
  function fakeComposeStream(args, project, action) {
    const sid = `sid-compose-${Math.random().toString(36).slice(2, 8)}`;
    streams[sid] = args;
    const verb = { up: "Up", up_build: "Up", restart: "Restart", stop: "Stop", down: "Down" }[action] ?? action;
    const steps = [
      { stream: "out", data: `# Running with docker compose (mock)`, code: null, error: null },
      { stream: "out", data: `[+] ${verb} 3/3`, code: null, error: null },
      { stream: "out", data: ` ✔ Container ${project}-web-1  ${verb === "Down" ? "Removed" : "Started"}`, code: null, error: null },
      { stream: "out", data: ` ✔ Container ${project}-api-1  ${verb === "Down" ? "Removed" : "Started"}`, code: null, error: null },
    ];
    let i = 0;
    const timer = setInterval(() => {
      if (streams[sid] === undefined) return clearInterval(timer);
      if (i < steps.length) {
        push(args.onOutput, steps[i++]);
        return;
      }
      clearInterval(timer);
      delete streams[sid];
      // 模拟动作效果（action 与后端 build_action_args 的小写枚举一致）
      if (verb === "Up" || verb === "Restart") {
        for (const c of containers) {
          if (c.compose_project === project) {
            c.state = "running";
            c.status = "Up Less than a second";
          }
        }
      } else if (verb === "Stop") {
        for (const c of containers) {
          if (c.compose_project === project && c.state === "running") {
            c.state = "exited";
            c.status = "Exited (0) 1 second ago";
          }
        }
      } else if (verb === "Down") {
        for (let j = containers.length - 1; j >= 0; j--) {
          if (containers[j].compose_project === project) containers.splice(j, 1);
        }
      }
      push(args.onOutput, { stream: "exit", data: "0", code: 0, error: null });
    }, 350);
    return Promise.resolve(sid);
  }

  const daemonConfig = {
    exists: true,
    registry_mirrors: ["https://docker.m.daocloud.io"],
    live_restore: false,
    other_keys: ["insecure-registries"],
  };

  const diskUsage = {
    dangling_images: { count: 3, size: 88_500_000 },
    unused_images: { count: 4, size: 679_800_000 },
    stopped_containers: { count: 1, size: 0 },
    unused_volumes: { count: 2, size: 214_000_000 },
    build_cache: { count: 7, size: 512_000_000 },
    total_reclaimable: 679_800_000 + 214_000_000 + 512_000_000,
  };

  // ---- 系统概览：host_stats（累计计数器每次采样递增）与 system_df ----
  let hostTick = 0;
  const hostCounters = { cpu: 0, sys: 0, net_rx: 0, net_tx: 0, blk_read: 0, blk_write: 0 };
  function hostStats() {
    hostTick++;
    // 累计值：每次采样叠加随机增量，前端差分后呈现波动的速率曲线
    // cpu 增量相对 system_cpu（8 核 × 2s ≈ 1.6e8）模拟 0.3%-2% 的轻负载
    hostCounters.cpu += Math.floor((0.5 + Math.random() * 2.7) * 1e6);
    hostCounters.sys += Math.floor(8 * 2e7);
    hostCounters.net_rx += Math.floor(Math.random() * 180_000);
    hostCounters.net_tx += Math.floor(Math.random() * 60_000);
    hostCounters.blk_read += Math.floor(Math.random() * 900_000);
    hostCounters.blk_write += Math.floor(Math.random() * 1_600_000);
    return {
      online_cpus: 8,
      cpu_total: hostCounters.cpu,
      system_cpu: hostCounters.sys,
      mem_used: 3.04 * 1024 * 1024 * 1024 + Math.sin(hostTick / 6) * 120 * 1024 * 1024,
      net_rx: hostCounters.net_rx,
      net_tx: hostCounters.net_tx,
      block_read: hostCounters.blk_read,
      block_write: hostCounters.blk_write,
      containers_running: containers.filter((c) => c.state === "running").length,
    };
  }

  const systemDf = {
    images_size: images.reduce((a, i) => a + i.size, 0),
    images_count: images.length,
    containers_size: 2.59 * 1024 * 1024 * 1024,
    containers_count: containers.length,
    volumes_size: 35.47 * 1024 * 1024,
    volumes_count: 3,
    build_cache_size: 551.21 * 1024 * 1024,
    containers: [
      { name: "jellyfin", size: 1.02 * 1024 * 1024 * 1024 },
      { name: "nexus3", size: 743 * 1024 * 1024 },
      { name: "pg-prod", size: 512 * 1024 * 1024 },
      { name: "redis-prod", size: 187 * 1024 * 1024 },
      { name: "myapp-stack-web-1", size: 96 * 1024 * 1024 },
      { name: "myapp-stack-api-1", size: 64 * 1024 * 1024 },
      { name: "dpanel", size: 12 * 1024 * 1024 },
    ],
    images: images.map((i) => ({
      name: i.tags[0] ?? "<none>:<none>",
      size: i.size,
    })),
    volumes: [
      { name: "pgdata", size: 28.2 * 1024 * 1024 },
      { name: "nexus-data", size: 5.1 * 1024 * 1024 },
      { name: "jellyfin-config", size: 2.17 * 1024 * 1024 },
    ],
  };

  let tick = 0;
  const statsTick = () => {
    tick++;
    const wave = Math.sin(tick / 5) * 0.5 + 0.5;
    const memUsage = 320 * 1024 * 1024 + wave * 90 * 1024 * 1024;
    const memLimit = 4 * 1024 * 1024 * 1024;
    return {
      cpu_percent: 12 + wave * 46,
      mem_usage: memUsage,
      mem_limit: memLimit,
      mem_percent: (memUsage / memLimit) * 100,
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
        case "create_container": {
          const spec = args.spec ?? {};
          const id =
            (spec.image || "created").replace(/[^a-z0-9]/gi, "").slice(0, 10) +
            Date.now().toString(16) +
            "0".repeat(64);
          containers.push({
            id: id.slice(0, 64),
            name: spec.name || `auto-${Math.random().toString(36).slice(2, 8)}`,
            image: spec.image,
            state: "running",
            status: "Up Less than a second",
            created: Math.floor(Date.now() / 1000),
            ports: (spec.ports ?? []).map((p) => ({
              ip: "0.0.0.0",
              private_port: p.container,
              public_port: p.host,
              proto: p.proto ?? "tcp",
            })),
            compose_project: null,
            compose_service: null,
          });
          return Promise.resolve(id.slice(0, 64));
        }
        case "list_networks":
          return Promise.resolve([
            { id: "net-bridge000000000000000000000000000000000000000000000", name: "bridge", driver: "bridge" },
            { id: "net-compose00000000000000000000000000000000000000000000", name: "myapp-stack_default", driver: "bridge" },
            { id: "net-host000000000000000000000000000000000000000000000000", name: "host", driver: "host" },
            { id: "net-none000000000000000000000000000000000000000000000000", name: "none", driver: "null" },
          ]);
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
          const st = streams[sid];
          delete streams[sid];
          // compose 流被取消时补发终止消息，让前端把运行态收尾
          if (st?.onOutput) {
            push(st.onOutput, { stream: "exit", data: "", code: null, error: "操作已取消" });
          }
          return Promise.resolve();
        }
        case "exec_input":
        case "exec_resize":
          return Promise.resolve();
        case "get_settings":
          return Promise.resolve(settings);
        case "set_settings":
          Object.assign(settings, args.settings);
          return Promise.resolve(settings);
        case "read_daemon_config":
          return Promise.resolve(daemonConfig);
        case "apply_mirrors":
          daemonConfig.registry_mirrors = [...args.mirrors];
          daemonConfig.exists = true;
          return new Promise((resolve) => setTimeout(resolve, 600));
        case "generate_mirrors_command":
          return Promise.resolve(
            `printf '%s' '{"registry-mirrors":${JSON.stringify(args.mirrors)}}' | sudo tee /etc/docker/daemon.json >/dev/null && sudo systemctl restart docker`,
          );
        case "restart_docker":
          return new Promise((resolve) => setTimeout(resolve, 1200));
        case "test_mirror":
          return new Promise((resolve) =>
            setTimeout(() => resolve(60 + Math.floor(Math.random() * 700)), 250),
          );
        case "disk_usage":
          return Promise.resolve(diskUsage);
        case "host_stats":
          return Promise.resolve(hostStats());
        case "system_df":
          return Promise.resolve(systemDf);

        // ---- 编排（docker compose）----
        case "list_compose_projects":
          return Promise.resolve(composeProjects());
        case "compose_cli_info":
          return Promise.resolve({ available: true, version: "v5.5.0", source: "plugin" });
        case "compose_action":
          return fakeComposeStream(args, args.project, args.action);
        case "compose_deploy":
          return fakeComposeStream(args, args.projectName || "myapp", "Up");
        case "read_compose_file":
          return Promise.resolve(composeYamlSample);
        case "write_compose_file":
          return new Promise((resolve) => setTimeout(resolve, 400));
        case "plugin:dialog|open":
          return Promise.resolve("/home/user/myapp-stack/compose.yaml");

        case "cleanup":
          return new Promise((resolve) =>
            setTimeout(() => {
              const items = args.kinds.map((kind) => ({
                kind,
                removed: diskUsage[kind]?.count ?? 0,
                space_reclaimed: diskUsage[kind]?.size ?? 0,
                error: null,
              }));
              for (const kind of args.kinds) {
                if (diskUsage[kind]) diskUsage[kind] = { count: 0, size: 0 };
              }
              diskUsage.total_reclaimable =
                diskUsage.unused_images.size +
                diskUsage.unused_volumes.size +
                diskUsage.build_cache.size;
              resolve({ items, total_reclaimed: items.reduce((a, i) => a + i.space_reclaimed, 0) });
            }, 800),
          );
        case "plugin:app|version":
          return Promise.resolve("0.2.0-mock");
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
