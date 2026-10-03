import { describe, expect, it } from "vitest";

import type { SyncPayload, SyncedFile } from "../../../types/sync";
import {
  createMasterKeyConfig,
  decryptPayload,
  encryptPayload,
  unlockMasterKey,
  verifyPassword,
} from "../encryption";

const makePayload = (): SyncPayload => ({
  connections: [
    { id: "local", name: "本地", kind: "local", socket_path: "", host: "", cert_path: "", key_path: "", key_id: "", identity_id: "", remote_socket: "", auth: "key", secret_backend: "" },
    { id: "srv", name: "服务器", kind: "ssh", socket_path: "", host: "root@1.2.3.4", cert_path: "", key_path: "/home/id_rsa", key_id: "", identity_id: "", remote_socket: "", auth: "key", secret_backend: "" },
  ],
  registries: [{ id: "r1", name: "阿里云", kind: "aliyun", registry: "registry.cn-hangzhou.aliyuncs.com", username: "u", secret_backend: "keyring", skip_tls_verify: false, created_at: 1 }],
  settings: { theme: "dark", containers_refresh_secs: 10, logs_timestamps: true },
  syncedAt: 12345,
});

describe("加密往返", () => {
  it("encryptPayload → decryptPayload 还原原文", async () => {
    const payload = makePayload();
    const file: SyncedFile = await encryptPayload(payload, "正确密码", "device-1", "测试机", "0.3.4", 5);
    expect(file.meta.version).toBe(6);
    expect(file.meta.algorithm).toBe("AES-256-GCM");
    expect(file.payload).not.toContain("正确密码");

    const decoded = await decryptPayload(file, "正确密码");
    expect(decoded).toEqual(payload);
  });

  it("密码错误时解密失败", async () => {
    const file = await encryptPayload(makePayload(), "password-a", "d", "n", "0.3.4");
    await expect(decryptPayload(file, "password-b")).rejects.toThrow();
  });

  it("密文被篡改时解密失败（GCM 认证标签）", async () => {
    const file = await encryptPayload(makePayload(), "pw", "d", "n", "0.3.4");
    const bytes = Uint8Array.from(atob(file.payload), (c) => c.charCodeAt(0));
    bytes[0] ^= 0xff;
    const tampered: SyncedFile = { ...file, payload: btoa(String.fromCharCode(...bytes)) };
    await expect(decryptPayload(tampered, "pw")).rejects.toThrow();
  });

  it("每次加密使用新 salt + IV（密文不同）", async () => {
    const payload = makePayload();
    const a = await encryptPayload(payload, "pw", "d", "n", "0.3.4", 0);
    const b = await encryptPayload(payload, "pw", "d", "n", "0.3.4", 0);
    expect(a.meta.salt).not.toBe(b.meta.salt);
    expect(a.meta.iv).not.toBe(b.meta.iv);
    expect(a.payload).not.toBe(b.payload);
  });
});

describe("主密钥配置", () => {
  it("createMasterKeyConfig + unlockMasterKey 往返", async () => {
    const config = await createMasterKeyConfig("我的同步密码");
    expect(config.verificationHash).toBeTruthy();
    expect(JSON.stringify(config)).not.toContain("我的同步密码");

    const unlocked = await unlockMasterKey("我的同步密码", config);
    expect(unlocked).not.toBeNull();

    const wrong = await unlockMasterKey("错误密码", config);
    expect(wrong).toBeNull();
  });

  it("verifyPassword 校验正确/错误密码", async () => {
    const config = await createMasterKeyConfig("pw-123456");
    expect(await verifyPassword("pw-123456", config)).toBe(true);
    expect(await verifyPassword("pw-wrong", config)).toBe(false);
  });
});
