import { describe, expect, it } from "vitest";
import { defaultExportName, suggestPushTarget } from "./shared";
import type { ImageDto } from "../../types/docker";

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
