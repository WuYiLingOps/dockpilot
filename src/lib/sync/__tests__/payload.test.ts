import { describe, expect, it } from "vitest";

import type { AppSettings } from "../../../types/settings";
import { applySyncPayload, payloadFingerprint, toSyncPayload } from "../payload";

const localSettings = (): AppSettings => ({
  theme: "dark",
  docker_socket: "/legacy/sock",
  connections: [
    { id: "local", name: "本地", kind: "local", socket_path: "", host: "", cert_path: "", key_path: "", remote_socket: "", auth: "key", secret_backend: "" },
  ],
  active_connection_id: "local",
  containers_refresh_secs: 10,
  images_refresh_secs: 20,
  logs_default_tail: 1000,
  logs_timestamps: false,
  terminal_shell: "bash",
  notifications_enabled: true,
  auto_check_updates: true,
  close_action: "exit",
  debug_logging: false,
  log_retention_days: 14,
  registries: [
    { id: "r1", name: "本机仓库", kind: "harbor", registry: "harbor.local", username: "u", secret_backend: "file", skip_tls_verify: false, created_at: 1 },
  ],
  compose_projects: [],
  compose_scan_dirs: [],
});

describe("载荷映射", () => {
  it("toSyncPayload 剔除设备本地字段（secret_backend 置空）", () => {
    const p = toSyncPayload(localSettings());
    expect(p.registries[0].secret_backend).toBe("");
    expect(p.connections[0].id).toBe("local");
  });

  it("编排跟踪记录与扫描目录不入云同步载荷（路径机器/连接相关）", () => {
    const settings = {
      ...localSettings(),
      compose_projects: [
        { id: "t1", connection_id: "local", name: "app", working_dir: "/a", config_files: ["/a/compose.yaml"], source: "registered" as const, added_at: 1 },
      ],
      compose_scan_dirs: [{ id: "d1", connection_id: "local", path: "/stacks" }],
    };
    const p = toSyncPayload(settings);
    expect(p).not.toHaveProperty("compose_projects");
    expect(p).not.toHaveProperty("compose_scan_dirs");
  });

  it("applySyncPayload 保留本机 active_connection_id / docker_socket / 已有 secret_backend", () => {
    const settings = localSettings();
    const incoming = toSyncPayload(settings);
    incoming.connections = [
      ...incoming.connections,
      { id: "srv", name: "服务器", kind: "ssh", socket_path: "", host: "root@1.2.3.4", cert_path: "", key_path: "", remote_socket: "", auth: "key", secret_backend: "" },
    ];
    incoming.registries = [
      ...incoming.registries,
      { id: "r2", name: "云端新增仓库", kind: "aliyun", registry: "acr.aliyun.com", username: "u2", secret_backend: "keyring", skip_tls_verify: false, created_at: 2 },
    ];

    const next = applySyncPayload(settings, incoming);
    expect(next.active_connection_id).toBe("local");
    expect(next.docker_socket).toBe("/legacy/sock");
    expect(next.connections.map((c) => c.id)).toContain("srv");
    // 本机已有条目保留本机落点；新条目待首次录入密码时回填
    expect(next.registries.find((r) => r.id === "r1")?.secret_backend).toBe("file");
    expect(next.registries.find((r) => r.id === "r2")?.secret_backend).toBe("");
  });

  it("applySyncPayload 应用标量设置", () => {
    const settings = localSettings();
    const incoming = toSyncPayload(settings);
    incoming.settings = { ...incoming.settings, logs_default_tail: 5000, theme: "light" };
    const next = applySyncPayload(settings, incoming);
    expect(next.logs_default_tail).toBe(5000);
    expect(next.theme).toBe("light");
  });

  it("payloadFingerprint 忽略 syncedAt，对键顺序不敏感", () => {
    const a = toSyncPayload(localSettings());
    const b = toSyncPayload(localSettings());
    b.syncedAt = a.syncedAt + 1000; // syncedAt 取自 Date.now()，同毫秒时相同，手动错开
    expect(payloadFingerprint(a)).toBe(payloadFingerprint(b));

    const c = toSyncPayload(localSettings());
    c.settings = { ...c.settings, theme: "light" };
    expect(payloadFingerprint(c)).not.toBe(payloadFingerprint(a));
  });
});
