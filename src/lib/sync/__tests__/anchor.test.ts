import { describe, expect, it } from "vitest";

import type { ProviderSyncAnchor, SyncedFile } from "../../../types/sync";
import { createSyncedFileSignature, decideRemoteChanged } from "../anchor";

const anchor = (over: Partial<ProviderSyncAnchor> = {}): ProviderSyncAnchor => ({
  signature: "sig-1",
  version: 3,
  updatedAt: 100,
  resourceId: "gist-1",
  observedAt: 100,
  ...over,
});

const file = (over: Partial<SyncedFile> = {}): SyncedFile => ({
  meta: {
    version: 3,
    updatedAt: 100,
    deviceId: "d1",
    appVersion: "0.3.4",
    iv: "iv",
    salt: "salt",
    algorithm: "AES-256-GCM",
    kdf: "PBKDF2",
    kdfIterations: 600000,
  },
  payload: "cipher",
  ...over,
});

describe("锚点决策", () => {
  it("无锚点 + 远端无文件 → 未变化", () => {
    expect(decideRemoteChanged({ currentSignature: null, currentResourceId: null, anchor: null, hasRemoteFile: false })).toEqual({
      remoteChanged: false,
      reason: "no-anchor-no-remote",
    });
  });

  it("无锚点 + 远端有数据 → 已变化（首次同步走合并）", () => {
    expect(decideRemoteChanged({ currentSignature: "x", currentResourceId: "gist-1", anchor: null, hasRemoteFile: true }).remoteChanged).toBe(true);
  });

  it("无锚点 + 远端文件不可读 → 已变化（暴露错误而非静默覆盖）", () => {
    expect(decideRemoteChanged({ currentSignature: null, currentResourceId: "gist-1", anchor: null, hasRemoteFile: true }).reason).toBe(
      "unreadable-remote",
    );
  });

  it("resourceId 漂移 → 已变化", () => {
    const d = decideRemoteChanged({ currentSignature: "sig-1", currentResourceId: "gist-2", anchor: anchor(), hasRemoteFile: true });
    expect(d.remoteChanged).toBe(true);
    expect(d.reason).toBe("resource-id-changed");
  });

  it("签名不一致 → 已变化", () => {
    const d = decideRemoteChanged({ currentSignature: "sig-2", currentResourceId: "gist-1", anchor: anchor(), hasRemoteFile: true });
    expect(d.remoteChanged).toBe(true);
    expect(d.reason).toBe("signature-mismatch");
  });

  it("签名与资源一致 → 未变化（no-op 短路）", () => {
    expect(decideRemoteChanged({ currentSignature: "sig-1", currentResourceId: "gist-1", anchor: anchor(), hasRemoteFile: true })).toEqual({
      remoteChanged: false,
      reason: "anchor-matches",
    });
  });
});

describe("云端文件签名", () => {
  it("签名可复现且随内容变化", async () => {
    const a = await createSyncedFileSignature(file());
    const b = await createSyncedFileSignature(file());
    expect(a).toBe(b);
    const changed = await createSyncedFileSignature(file({ payload: "cipher-2" }));
    expect(changed).not.toBe(a);
    expect(await createSyncedFileSignature(null)).toBeNull();
  });
});
