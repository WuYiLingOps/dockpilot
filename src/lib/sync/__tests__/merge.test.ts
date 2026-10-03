import { describe, expect, it } from "vitest";

import type { ConnectionProfile, SshIdentity, SshKeyEntry } from "../../../types/settings";
import type { SshCredentialSync, SyncPayload } from "../../../types/sync";
import { fingerprint, mergeSyncPayloads } from "../merge";

const conn = (id: string, name: string, host = ""): ConnectionProfile => ({
  id,
  name,
  kind: "local",
  socket_path: "",
  host,
  cert_path: "",
  key_path: "",
  key_id: "",
  identity_id: "",
  remote_socket: "",
  auth: "key",
  secret_backend: "",
});

const payload = (connections: ConnectionProfile[], overrides: Partial<SyncPayload> = {}): SyncPayload => ({
  connections,
  registries: [],
  settings: undefined,
  syncedAt: 0,
  ...overrides,
});

describe("实体三方合并（按 id）", () => {
  it("单侧新增：两侧新增都保留", () => {
    const base = payload([conn("a", "A")]);
    const local = payload([conn("a", "A"), conn("b", "B-local")]);
    const remote = payload([conn("a", "A"), conn("c", "C-remote")]);

    const r = mergeSyncPayloads(base, local, remote);
    expect(r.payload.connections.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
    expect(r.summary.added).toEqual({ local: 1, remote: 1 });
    expect(r.hadConflicts).toBe(false);
  });

  it("无 base（首次同步）时按 id 并集，重复 id 本地优先", () => {
    const local = payload([conn("a", "A-local"), conn("b", "B")]);
    const remote = payload([conn("a", "A-remote"), conn("c", "C")]);

    const r = mergeSyncPayloads(null, local, remote);
    expect(r.payload.connections.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
    expect(r.payload.connections.find((c) => c.id === "a")?.name).toBe("A-local");
    expect(r.hadConflicts).toBe(true); // a 双方都有且内容不同
  });

  it("单侧修改：保留修改侧", () => {
    const base = payload([conn("a", "A"), conn("b", "B")]);
    const local = payload([conn("a", "A-new"), conn("b", "B")]);
    const remote = payload([conn("a", "A"), conn("b", "B-new")]);

    const r = mergeSyncPayloads(base, local, remote);
    expect(r.payload.connections.find((c) => c.id === "a")?.name).toBe("A-new");
    expect(r.payload.connections.find((c) => c.id === "b")?.name).toBe("B-new");
    expect(r.hadConflicts).toBe(false);
    expect(r.summary.modified.local).toBe(1);
    expect(r.summary.modified.remote).toBe(1);
  });

  it("双改：本地优先并计冲突", () => {
    const base = payload([conn("a", "A")]);
    const local = payload([conn("a", "A-local")]);
    const remote = payload([conn("a", "A-remote")]);

    const r = mergeSyncPayloads(base, local, remote);
    expect(r.payload.connections[0].name).toBe("A-local");
    expect(r.hadConflicts).toBe(true);
  });

  it("本地删除 + 远端未动 → 删除；远端改过 → 保留远端修改", () => {
    const base = payload([conn("a", "A"), conn("b", "B")]);
    // 本地删除 b；远端 b 未动
    const local = payload([conn("a", "A")]);
    const remote = payload([conn("a", "A"), conn("b", "B")]);
    const r1 = mergeSyncPayloads(base, local, remote);
    expect(r1.payload.connections.map((c) => c.id)).toEqual(["a"]);

    // 本地删除 b；远端把 b 改了 → 保留修改（更安全）
    const remote2 = payload([conn("a", "A"), conn("b", "B-changed")]);
    const r2 = mergeSyncPayloads(base, local, remote2);
    expect(r2.payload.connections.map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(r2.payload.connections.find((c) => c.id === "b")?.name).toBe("B-changed");
    expect(r2.hadConflicts).toBe(true);
  });

  it("两侧都删除 → 移除", () => {
    const base = payload([conn("a", "A"), conn("b", "B")]);
    const local = payload([conn("a", "A")]);
    const remote = payload([conn("a", "A")]);
    const r = mergeSyncPayloads(base, local, remote);
    expect(r.payload.connections.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("标量设置合并", () => {
  it("单侧修改生效", () => {
    const base = payload([], { settings: { theme: "system", logs_default_tail: 100 } });
    const local = payload([], { settings: { theme: "dark", logs_default_tail: 100 } });
    const remote = payload([], { settings: { theme: "system", logs_default_tail: 5000 } });

    const r = mergeSyncPayloads(base, local, remote);
    expect(r.payload.settings?.theme).toBe("dark");
    expect(r.payload.settings?.logs_default_tail).toBe(5000);
  });

  it("双改：本地优先（首次合并时远端优先）", () => {
    const base = payload([], { settings: { theme: "system" } });
    const local = payload([], { settings: { theme: "dark" } });
    const remote = payload([], { settings: { theme: "light" } });

    expect(mergeSyncPayloads(base, local, remote).payload.settings?.theme).toBe("dark");
    expect(mergeSyncPayloads(null, local, remote).payload.settings?.theme).toBe("light");
  });
});

describe("fingerprint", () => {
  it("键顺序不影响指纹", () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe("SSH 凭证三方合并（profile_id/kind 复合 id）", () => {
  const cred = (target_id: string, kind: string, value: string): SshCredentialSync => ({
    target_id,
    kind,
    value,
  });

  it("单侧新增的凭证条目保留，合并结果剥离复合 id", () => {
    const base = payload([], { ssh_credentials: [cred("a", "password", "old")] });
    const local = payload([], { ssh_credentials: [cred("a", "password", "old"), cred("a", "key_pem", "PEM")] });
    const remote = payload([], { ssh_credentials: [cred("a", "password", "old")] });

    const r = mergeSyncPayloads(base, local, remote);
    expect(r.payload.ssh_credentials).toEqual([
      cred("a", "password", "old"),
      cred("a", "key_pem", "PEM"),
    ]);
    expect(r.hadConflicts).toBe(false);
  });

  it("两侧同条目都修改 → 本地优先并计冲突；单侧删除生效", () => {
    const base = payload([], { ssh_credentials: [cred("a", "password", "old")] });
    const local = payload([], { ssh_credentials: [cred("a", "password", "local-new")] });
    const remote = payload([], { ssh_credentials: [cred("a", "password", "remote-new")] });
    const r = mergeSyncPayloads(base, local, remote);
    expect(r.payload.ssh_credentials).toEqual([cred("a", "password", "local-new")]);
    expect(r.hadConflicts).toBe(true);

    // 本地删除（条目消失）而远端未改 → 删除生效
    const r2 = mergeSyncPayloads(base, payload([]), payload([], { ssh_credentials: [cred("a", "password", "old")] }));
    expect(r2.payload.ssh_credentials).toEqual([]);
  });
});

describe("SSH 钥匙串条目合并（按 id）", () => {
  const key = (id: string, label: string): SshKeyEntry => ({
    id,
    label,
    fingerprint: "SHA256:test",
    public_key: "",
    created_at: 1,
  });

  it("单侧新增的钥匙串条目保留", () => {
    const base = payload([]);
    const local = payload([], { ssh_keys: [key("k1", "本机导入")] });
    const remote = payload([], { ssh_keys: [key("k2", "云端导入")] });

    const r = mergeSyncPayloads(base, local, remote);
    expect(r.payload.ssh_keys?.map((k) => k.id).sort()).toEqual(["k1", "k2"]);
    expect(r.hadConflicts).toBe(false);
  });

  it("本机删除钥匙串条目、远端未改 → 删除生效（引用该条目的连接 key_id 由 sanitize 悬空清理）", () => {
    const base = payload([], { ssh_keys: [key("k1", "旧钥")] });
    const local = payload([]);
    const remote = payload([], { ssh_keys: [key("k1", "旧钥")] });

    const r = mergeSyncPayloads(base, local, remote);
    expect(r.payload.ssh_keys).toEqual([]);
  });
});

describe("SSH 身份元数据合并（按 id）", () => {
  const ident = (id: string, username: string): SshIdentity => ({
    id,
    label: id,
    username,
    key_id: "",
    created_at: 1,
  });

  it("新设备拉取：远端身份以 added.remote 并入合并载荷", () => {
    const local = payload([]);
    const remote = payload([], { ssh_identities: [ident("i1", "root")] });

    const r = mergeSyncPayloads(null, local, remote);
    expect(r.payload.ssh_identities).toEqual([ident("i1", "root")]);
    expect(r.summary.added.remote).toBe(1);
  });

  it("本机删除身份、远端未改 → 删除生效", () => {
    const base = payload([], { ssh_identities: [ident("i1", "root")] });
    const local = payload([]);
    const remote = payload([], { ssh_identities: [ident("i1", "root")] });

    const r = mergeSyncPayloads(base, local, remote);
    expect(r.payload.ssh_identities).toEqual([]);
  });
});
