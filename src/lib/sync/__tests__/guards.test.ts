import { describe, expect, it } from "vitest";

import type { ConnectionProfile, RegistryProfile } from "../../../types/settings";
import type { SyncPayload } from "../../../types/sync";
import { detectSuspiciousShrink } from "../guards";

const conns = (n: number): ConnectionProfile[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    name: `连接${i}`,
    kind: "local",
    socket_path: "",
    host: "",
    cert_path: "",
    key_path: "",
    remote_socket: "",
    jump_host: "",
    auth: "key",
    secret_backend: "",
  }));

const regs = (n: number): RegistryProfile[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    name: `仓库${i}`,
    kind: "generic",
    registry: `reg${i}.example.com`,
    username: "u",
    secret_backend: "",
    skip_tls_verify: false,
    created_at: 0,
  }));

const payload = (connections: ConnectionProfile[], registries: RegistryProfile[] = []): SyncPayload => ({
  connections,
  registries,
  settings: undefined,
  syncedAt: 0,
});

describe("收缩检测", () => {
  it("正常增减不触发", () => {
    const base = payload(conns(10));
    expect(detectSuspiciousShrink(payload(conns(9)), base)).toEqual({ suspicious: false });
    expect(detectSuspiciousShrink(payload(conns(12)), base)).toEqual({ suspicious: false });
  });

  it("相对收缩 ≥30% 且 ≥2 条时拦截", () => {
    const base = payload(conns(10));
    const finding = detectSuspiciousShrink(payload(conns(6)), base);
    expect(finding.suspicious).toBe(true);
    if (finding.suspicious) {
      expect(finding.reason).toBe("bulk-shrink");
      expect(finding.lost).toBe(4);
    }
    // 少于 2 条不拦（正常单条删除）
    expect(detectSuspiciousShrink(payload(conns(9)), base)).toEqual({ suspicious: false });
  });

  it("绝对收缩 ≥10 条直接拦截（大库小比例）", () => {
    const base = payload(conns(200));
    const finding = detectSuspiciousShrink(payload(conns(188)), base);
    expect(finding.suspicious).toBe(true);
    if (finding.suspicious) expect(finding.reason).toBe("large-shrink");
  });

  it("registries 独立检测", () => {
    const base = payload(conns(10), regs(5));
    const finding = detectSuspiciousShrink(payload(conns(10), regs(1)), base);
    expect(finding.suspicious).toBe(true);
    if (finding.suspicious) expect(finding.entityType).toBe("registries");
  });

  it("base 缺失时以远端为参照并标记 viaRemote", () => {
    const remote = payload(conns(10));
    const finding = detectSuspiciousShrink(payload(conns(3)), null, remote);
    expect(finding.suspicious).toBe(true);
    if (finding.suspicious) {
      expect(finding.viaRemote).toBe(true);
      expect(finding.baseCount).toBe(10);
    }
  });

  it("base 与远端都缺失时不拦截", () => {
    expect(detectSuspiciousShrink(payload([]), null, null)).toEqual({ suspicious: false });
  });
});
