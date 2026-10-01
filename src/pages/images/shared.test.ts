import { describe, expect, it } from "vitest";
import {
  defaultExportName,
  refRegistryDomain,
  resolvePullCredential,
  suggestPushTarget,
} from "./shared";
import type { ImageDto } from "../../types/docker";
import type { RegistryProfile } from "../../types/settings";

function img(id: string, tags: string[]): ImageDto {
  return { id, tags } as ImageDto;
}

describe("defaultExportName", () => {
  it("单镜像按标签命名，非法字符替换为 -", () => {
    expect(defaultExportName([img("abc", ["myrepo/myapp:v1"])])).toBe("myrepo-myapp-v1.tar");
  });

  it("单镜像带 sha256 前缀时剥掉前缀", () => {
    expect(defaultExportName([img("abc", ["sha256:0123abcd.ef"])])).toBe("0123abcd.ef.tar");
  });

  it("无标签单镜像回退镜像 ID", () => {
    expect(defaultExportName([img("0123456789abcdef", [])])).toBe("0123456789ab.tar");
  });

  it("批量导出用日期命名", () => {
    expect(defaultExportName([img("a", ["x:1"]), img("b", ["y:2"])])).toMatch(
      /^docker-images-\d{8}\.tar$/,
    );
  });
});

describe("suggestPushTarget", () => {
  it("带 registry host 时剥掉 host 前缀并拆 tag", () => {
    expect(suggestPushTarget("registry.cn-hangzhou.aliyuncs.com/wylhub/redis:7-alpine")).toEqual({
      repository: "wylhub/redis",
      tag: "7-alpine",
    });
  });

  it("带端口的 host 同样剥掉", () => {
    expect(suggestPushTarget("harbor.local:5000/team/app:v2")).toEqual({
      repository: "team/app",
      tag: "v2",
    });
  });

  it("localhost 视为 host", () => {
    expect(suggestPushTarget("localhost/cache/img")).toEqual({
      repository: "cache/img",
      tag: "latest",
    });
  });

  it("无 host 的官方镜像整体作为仓库名", () => {
    expect(suggestPushTarget("nginx:1.27-alpine")).toEqual({
      repository: "nginx",
      tag: "1.27-alpine",
    });
    expect(suggestPushTarget("myapp")).toEqual({ repository: "myapp", tag: "latest" });
  });

  it("namespace/repo 无 tag 时 tag 回退 latest", () => {
    expect(suggestPushTarget("wylhub/redis")).toEqual({
      repository: "wylhub/redis",
      tag: "latest",
    });
  });
});

const registry = (partial: Partial<RegistryProfile>): RegistryProfile =>
  ({
    id: "r1",
    name: "hub",
    kind: "generic",
    registry: "docker.io",
    username: "u",
    secret_backend: "keyring",
    skip_tls_verify: false,
    created_at: 1,
    ...partial,
  }) as RegistryProfile;

describe("refRegistryDomain", () => {
  it("官方镜像（单段/官方域名前缀缺失）归到 docker.io", () => {
    expect(refRegistryDomain("nginx")).toBe("docker.io");
    expect(refRegistryDomain("nginx:1.27")).toBe("docker.io");
    expect(refRegistryDomain("nginx@sha256:abcd")).toBe("docker.io");
  });

  it("首段形如域名且有多段时取该段", () => {
    expect(refRegistryDomain("registry.cn-hangzhou.aliyuncs.com/wylhub/redis:7")).toBe(
      "registry.cn-hangzhou.aliyuncs.com",
    );
    expect(refRegistryDomain("localhost:5000/app:1")).toBe("localhost:5000");
    expect(refRegistryDomain("harbor.local:8443/proj/app@sha256:abcd")).toBe(
      "harbor.local:8443",
    );
  });
});

describe("resolvePullCredential", () => {
  const registries = [
    registry({ id: "hub", registry: "docker.io" }),
    registry({ id: "harbor", kind: "harbor", registry: "harbor.local:8443" }),
  ];

  it("官方镜像命中 Docker Hub 凭据", () => {
    expect(resolvePullCredential("nginx:latest", registries)?.id).toBe("hub");
  });

  it("带端口域名精确命中对应凭据", () => {
    expect(resolvePullCredential("harbor.local:8443/proj/app", registries)?.id).toBe(
      "harbor",
    );
  });

  it("无匹配凭据时返回 null（匿名拉取）", () => {
    expect(resolvePullCredential("quay.io/foo/bar", registries)).toBeNull();
    expect(resolvePullCredential("nginx", [])).toBeNull();
  });
});
