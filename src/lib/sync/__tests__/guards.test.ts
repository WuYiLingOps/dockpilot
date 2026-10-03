import { describe, expect, it } from "vitest";

import type { ConnectionProfile, RegistryProfile, SshIdentity, SshKeyEntry } from "../../../types/settings";
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
    key_id: "",
  identity_id: "",
    remote_socket: "",
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

  it("SSH 钥匙串/身份元数据丢失同样拦截", () => {
    const key = (id: string): SshKeyEntry => ({ id, label: id, fingerprint: "", public_key: "", created_at: 0 });
    const ident = (id: string): SshIdentity => ({ id, label: id, username: "root", key_id: "", created_at: 0 });
    const base = {
      ...payload(conns(10)),
      ssh_keys: [key("k1"), key("k2"), key("k3")],
      ssh_identities: [ident("i1"), ident("i2"), ident("i3")],
    };

    // 钥匙串全丢（身份完好）→ 拦截并报告 ssh_keys
    const keyFinding = detectSuspiciousShrink(
      { ...payload(conns(10)), ssh_identities: base.ssh_identities },
      base,
    );
    expect(keyFinding.suspicious).toBe(true);
    if (keyFinding.suspicious) expect(keyFinding.entityType).toBe("ssh_keys");

    // 身份全丢（钥匙串完好）→ 拦截并报告 ssh_identities
    const idFinding = detectSuspiciousShrink(
      { ...payload(conns(10)), ssh_keys: base.ssh_keys },
      base,
    );
    expect(idFinding.suspicious).toBe(true);
    if (idFinding.suspicious) expect(idFinding.entityType).toBe("ssh_identities");

    // 单条删除（3→2，丢失 1 条）不拦
    expect(
      detectSuspiciousShrink(
        {
          ...payload(conns(10)),
          ssh_keys: base.ssh_keys,
          ssh_identities: [ident("i1"), ident("i2")],
        },
        base,
      ),
    ).toEqual({ suspicious: false });
  });
});
