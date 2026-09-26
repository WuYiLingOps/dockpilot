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
      status: "Up 2 days (unhealthy)",
      health: "unhealthy",
      created: now - 3600 * 50,
      ports: [{ ip: "0.0.0.0", private_port: 8081, public_port: 8081, proto: "tcp" }],
    },
    {
      id: "d4e5f6a7b8c9789012345678901234567890abcd",
      name: "jellyfin",
      image: "registry.cn-hangzhou.aliyuncs.com/wylhub/jellyfin:latest",
      state: "running",
      status: "Up 5 days (healthy)",
      health: "healthy",
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
    connections: [
      {
        id: "local",
        name: "本地",
        kind: "local",
        socket_path: "",
        host: "",
        cert_path: "",
        key_path: "",
        remote_socket: "",
      },
      {
        id: "mock-ssh-1",
        name: "测试服务器",
        kind: "ssh",
        socket_path: "",
        host: "user@192.168.1.66",
        cert_path: "",
        key_path: "",
        remote_socket: "",
        jump_host: "user@192.168.1.1",
      },
    ],
    active_connection_id: "local",
    containers_refresh_secs: 10,
    images_refresh_secs: 20,
    logs_default_tail: 1000,
    logs_timestamps: false,
    terminal_shell: "bash",
    mirror_custom: ["https://docker.example.dev"],
    notifications_enabled: true,
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
    unused_volumes: { count: 2, size: 214_400_000 },
    build_cache: { count: 2, size: 166_210_000 },
    total_reclaimable: 679_800_000 + 214_400_000 + 166_210_000,
  };

  // ---- 存储和网络：卷 / 网络 / 构建缓存种子数据 ----
  const iso = (unixSecs) => new Date(unixSecs * 1000).toISOString();

  const volumes = [
    { name: "pgdata", driver: "local", scope: "local", mountpoint: "/var/lib/docker/volumes/pgdata/_data", created: iso(now - 86400 * 30), size: 28.2 * 1024 * 1024, ref_count: 2, in_use: true, used_by: ["pg-prod", "myapp-stack-db-1"], labels: [] },
    { name: "nexus-data", driver: "local", scope: "local", mountpoint: "/var/lib/docker/volumes/nexus-data/_data", created: iso(now - 86400 * 60), size: 5.1 * 1024 * 1024, ref_count: 1, in_use: true, used_by: ["nexus3"], labels: [] },
    { name: "jellyfin-config", driver: "local", scope: "local", mountpoint: "/var/lib/docker/volumes/jellyfin-config/_data", created: iso(now - 86400 * 120), size: 2.17 * 1024 * 1024, ref_count: 1, in_use: true, used_by: ["jellyfin"], labels: [] },
    { name: "backup-tmp", driver: "local", scope: "local", mountpoint: "/var/lib/docker/volumes/backup-tmp/_data", created: iso(now - 86400 * 9), size: 187 * 1024 * 1024, ref_count: 0, in_use: false, used_by: [], labels: [{ key: "dockpilot.demo", value: "unused" }] },
    { name: "old-cache", driver: "local", scope: "local", mountpoint: "/var/lib/docker/volumes/old-cache/_data", created: iso(now - 86400 * 45), size: 27.4 * 1024 * 1024, ref_count: 0, in_use: false, used_by: [], labels: [] },
  ];

  /** 生成网络的已连接容器明细（仅运行中的容器会挂在网络端点上） */
  const netMember = (ipBase, names) =>
    containers
      .filter((c) => names.includes(c.name) && c.state === "running")
      .map((c, i) => ({
        name: c.name,
        id: c.id,
        ipv4: `${ipBase}.0.${2 + i}/16`,
        mac: `02:42:ac:${Number(ipBase.split(".")[1]).toString(16).padStart(2, "0")}:00:${(2 + i).toString(16).padStart(2, "0")}`,
      }));

  const networks = [
    {
      id: "f1e2d3c4b5a6" + "0".repeat(52),
      name: "bridge",
      driver: "bridge",
      scope: "local",
      internal: false,
      attachable: false,
      enable_ipv6: false,
      created: iso(now - 86400 * 90),
      subnet: "172.17.0.0/16",
      gateway: "172.17.0.1",
      built_in: true,
      labels: [],
      containers: netMember("172.17", ["redis-prod", "pg-prod", "nexus3", "jellyfin"]),
    },
    {
      id: "a9b8c7d6e5f4" + "0".repeat(52),
      name: "host",
      driver: "host",
      scope: "local",
      internal: false,
      attachable: false,
      enable_ipv6: false,
      created: iso(now - 86400 * 90),
      subnet: null,
      gateway: null,
      built_in: true,
      labels: [],
      containers: [],
    },
    {
      id: "102030405060" + "0".repeat(52),
      name: "none",
      driver: "null",
      scope: "local",
      internal: false,
      attachable: false,
      enable_ipv6: false,
      created: iso(now - 86400 * 90),
      subnet: null,
      gateway: null,
      built_in: true,
      labels: [],
      containers: [],
    },
    {
      id: "c0ffee00dead" + "0".repeat(52),
      name: "myapp-stack_default",
      driver: "bridge",
      scope: "local",
      internal: false,
      attachable: false,
      enable_ipv6: false,
      created: iso(now - 86400 * 3),
      subnet: "172.18.0.0/16",
      gateway: "172.18.0.1",
      built_in: false,
      labels: [{ key: "com.docker.compose.project", value: "myapp-stack" }],
      containers: netMember("172.18", ["myapp-stack-web-1", "myapp-stack-api-1"]),
    },
  ];

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
    volumes_size: volumes.reduce((a, v) => a + v.size, 0),
    volumes_count: volumes.length,
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
    volumes: volumes.map((v) => ({ name: v.name, size: v.size })),
    build_cache: [
      { id: "b1c2d3e4f5a6789012345678901234567890abcd0000000000000000000000", typ: "regular", description: "goharbor v2.13.2 构建层", size: 289_000_000, created_at: iso(now - 86400 * 2), in_use: true, shared: true, usage_count: 4 },
      { id: "c2d3e4f5a6b7789012345678901234567890abcd0000000000000000000000", typ: "regular", description: "nginx:1.27 alpine layers", size: 96_000_000, created_at: iso(now - 86400 * 5), in_use: true, shared: true, usage_count: 2 },
      { id: "d3e4f5a6b7c8789012345678901234567890abcd0000000000000000000000", typ: "exec.cachemount", description: "apt 缓存挂载", size: 121_000_000, created_at: iso(now - 86400 * 11), in_use: false, shared: false, usage_count: 1 },
      { id: "e4f5a6b7c8d9789012345678901234567890abcd0000000000000000000000", typ: "source", description: "本地源码上下文", size: 45_210_000, created_at: iso(now - 86400 * 20), in_use: false, shared: false, usage_count: 0 },
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
        case "container_health": {
          const c = containers.find((x) => x.id === args.id);
          if (!c || !c.health || c.health === "none") {
            return Promise.resolve({ status: "none", failing_streak: 0, log: [] });
          }
          const failed = c.health === "unhealthy";
          return Promise.resolve({
            status: c.health,
            failing_streak: failed ? 3 : 0,
            log: [
              {
                exit_code: failed ? 1 : 0,
                start: new Date((now - 55) * 1000).toISOString(),
                output: failed
                  ? "curl: (7) Failed to connect to localhost port 8081: Connection refused (mock)"
                  : "OK (mock)",
              },
            ],
          });
        }
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
            health: null,
          });
          return Promise.resolve(id.slice(0, 64));
        }
        case "list_networks":
          return Promise.resolve(
            [...networks].sort((a, b) => a.name.localeCompare(b.name)),
          );
        case "list_volumes":
          return Promise.resolve(volumes);
        case "create_volume": {
          const spec = args.spec ?? {};
          const name = (spec.name ?? "").trim();
          volumes.unshift({
            name,
            driver: spec.driver ?? "local",
            scope: "local",
            mountpoint: `/var/lib/docker/volumes/${name}/_data`,
            created: new Date().toISOString(),
            size: 0,
            ref_count: 0,
            in_use: false,
            used_by: [],
            labels: (spec.labels ?? []).map((l) => ({ key: l.key, value: l.value })),
          });
          return Promise.resolve();
        }
        case "remove_volume": {
          const v = volumes.find((x) => x.name === args.name);
          if (!v) return Promise.reject(`卷 ${args.name} 不存在`);
          if (v.used_by.length > 0 && !args.force) {
            return Promise.reject(
              `卷 ${args.name} 正在被 ${v.used_by.length} 个容器使用，请先卸载相关容器`,
            );
          }
          volumes.splice(volumes.indexOf(v), 1);
          return Promise.resolve();
        }
        case "create_network": {
          const spec = args.spec ?? {};
          const name = (spec.name ?? "").trim();
          if (networks.some((n) => n.name === name)) {
            return Promise.reject(`创建网络失败: network with name ${name} already exists`);
          }
          const id = "net" + Math.random().toString(16).slice(2, 10) + "0".repeat(52);
          networks.push({
            id,
            name,
            driver: spec.driver ?? "bridge",
            scope: "local",
            internal: !!spec.internal,
            attachable: !!spec.attachable,
            enable_ipv6: !!spec.enable_ipv6,
            created: new Date().toISOString(),
            subnet: spec.subnet ?? null,
            gateway: spec.gateway ?? null,
            built_in: false,
            labels: (spec.labels ?? []).map((l) => ({ key: l.key, value: l.value })),
            containers: [],
          });
          return Promise.resolve(id);
        }
        case "remove_network": {
          if (["bridge", "host", "none"].includes(args.name)) {
            return Promise.reject("内置网络不可删除");
          }
          const idx = networks.findIndex((n) => n.name === args.name);
          if (idx === -1) return Promise.reject(`网络 ${args.name} 不存在`);
          if (networks[idx].containers.length > 0) {
            return Promise.reject(
              `删除网络失败: 网络 ${args.name} 仍有活跃端点，请先断开容器`,
            );
          }
          networks.splice(idx, 1);
          return Promise.resolve();
        }
        case "connect_network": {
          const net = networks.find((n) => n.name === args.network);
          const c = containers.find(
            (x) => x.name === args.container || x.id === args.container,
          );
          if (!net || !c) return Promise.reject("连接网络失败: 网络或容器不存在");
          if (net.containers.some((x) => x.name === c.name)) {
            return Promise.reject(`连接网络失败: 容器 ${c.name} 已在该网络中`);
          }
          net.containers.push({
            name: c.name,
            id: c.id,
            ipv4: "172.20.0.9/16",
            mac: "02:42:ac:14:00:09",
          });
          return Promise.resolve();
        }
        case "disconnect_network": {
          const net = networks.find((n) => n.name === args.network);
          if (!net) return Promise.reject("断开网络失败: 网络不存在");
          net.containers = net.containers.filter(
            (x) => x.name !== args.container && x.id !== args.container,
          );
          return Promise.resolve();
        }
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
        case "switch_connection": {
          const profile = settings.connections.find((c) => c.id === args.id);
          if (!profile) return Promise.reject(`连接配置不存在: ${args.id}`);
          settings.active_connection_id = profile.id;
          daemonConfig.host =
            profile.kind === "local"
              ? `unix://${profile.socket_path || "/var/run/docker.sock"}`
              : profile.kind === "tls"
                ? `https://${profile.host}`
                : profile.kind === "ssh"
                  ? `ssh://${profile.host}`
                  : `tcp://${profile.host}`;
          return new Promise((resolve) => setTimeout(() => resolve(profile), 500));
        }
        case "test_connection":
          // 模拟测试：ssh/tls/tcp 类型按地址是否含 .1. 决定可达性，便于演示两种结果
          return new Promise((resolve) =>
            setTimeout(() => {
              const reachable = !args.profile.host || !args.profile.host.includes(".0.");
              if (reachable) {
                resolve({
                  ok: true,
                  latency_ms: 40 + Math.floor(Math.random() * 600),
                  version: "27.3.1",
                  error: "",
                });
              } else {
                resolve({
                  ok: false,
                  latency_ms: null,
                  version: "",
                  error: "连接不可达（mock）",
                });
              }
            }, 400),
          );
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
        case "plugin:dialog|save":
          return Promise.resolve("/home/user/container-export.log");
        case "export_container_logs":
          return Promise.resolve(5 * 1024);

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
