import { describe, expect, it } from "vitest";
import {
  firstLine,
  formatBytes,
  formatPorts,
  imageGroup,
  imageGroupLabel,
  imageShortRef,
  rfc3339ToUnix,
  shortId,
  timeAgo,
} from "./format";
import type { PortDto } from "../types/docker";

describe("firstLine", () => {
  it("多行消息取首行并去除首尾空白", () => {
    expect(firstLine("  连接失败\n原因: 超时\n  ")).toBe("连接失败");
  });

  it("单行原样返回；首行为空时回退原文", () => {
    expect(firstLine("仅一行")).toBe("仅一行");
    // split 首段为空 → trim 后为空 → 回退完整原文
    expect(firstLine("\n\nsecond")).toBe("\n\nsecond");
    expect(firstLine("")).toBe("");
  });
});

describe("formatBytes", () => {
  it("按 1024 进位", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 5)).toBe("1.0 PB");
  });

  it("超大值停在最大单位", () => {
    expect(formatBytes(1024 ** 7)).toBe(`${(1024 ** 2).toFixed(1)} PB`);
  });

  it("非法输入显示 -", () => {
    expect(formatBytes(-1)).toBe("-");
    expect(formatBytes(Number.NaN)).toBe("-");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("-");
  });
});

describe("shortId", () => {
  it("截断到 12 位，空值回退 -", () => {
    expect(shortId("sha256:abcdef1234567890")).toBe("sha256:abcde");
    expect(shortId("")).toBe("-");
  });
});

describe("rfc3339ToUnix", () => {
  it("标准 RFC3339 转 unix 秒", () => {
    expect(rfc3339ToUnix("1970-01-01T00:00:01Z")).toBe(1);
  });

  it("空值与无效串返回 0", () => {
    expect(rfc3339ToUnix(null)).toBe(0);
    expect(rfc3339ToUnix(undefined)).toBe(0);
    expect(rfc3339ToUnix("not-a-date")).toBe(0);
  });
});

describe("timeAgo", () => {
  it("0 值显示 -", () => {
    expect(timeAgo(0)).toBe("-");
  });

  it("未来或当前时间显示 刚刚", () => {
    expect(timeAgo(Date.now() / 1000 + 3600)).toBe("刚刚");
  });

  it("按分钟/小时/天递进", () => {
    const now = Date.now() / 1000;
    expect(timeAgo(now - 90)).toBe("1 分钟前");
    expect(timeAgo(now - 2 * 3600)).toBe("2 小时前");
    expect(timeAgo(now - 3 * 86400)).toBe("3 天前");
  });
});

describe("imageGroup / imageGroupLabel / imageShortRef", () => {
  it("按引用前缀归组", () => {
    expect(imageGroup("goharbor/harbor-core:v2.13.2")).toBe("goharbor");
    expect(
      imageGroup("registry.cn-hangzhou.aliyuncs.com/wylhub/redis:7-alpine"),
    ).toBe("registry.cn-hangzhou.aliyuncs.com/wylhub");
    expect(imageGroup("nginx:1.27-alpine")).toBe("docker.io");
    expect(imageGroup(undefined)).toBe("<none>");
  });

  it("归组标签转展示名", () => {
    expect(imageGroupLabel("docker.io")).toBe("Docker Hub（无前缀）");
    expect(imageGroupLabel("<none>")).toBe("悬空镜像（无标签）");
    expect(imageGroupLabel("goharbor")).toBe("goharbor");
  });

  it("短引用去掉前缀只留 仓库名:标签", () => {
    expect(imageShortRef("registry.cn-hangzhou.aliyuncs.com/wylhub/redis:7-alpine")).toBe(
      "redis:7-alpine",
    );
    expect(imageShortRef("nginx:1.27-alpine")).toBe("nginx:1.27-alpine");
  });
});

describe("formatPorts", () => {
  it("空列表显示 -", () => {
    expect(formatPorts([])).toBe("-");
  });

  it("有映射时输出 ip:port→port/proto", () => {
    const ports: PortDto[] = [
      { ip: "0.0.0.0", public_port: 8080, private_port: 80, proto: "tcp" },
    ];
    expect(formatPorts(ports)).toBe("0.0.0.0:8080→80/tcp");
  });

  it("无映射时只输出容器端口；超过 3 条折叠计数", () => {
    const exposed: PortDto[] = [{ ip: null, public_port: null, private_port: 443, proto: "tcp" }];
    expect(formatPorts(exposed)).toBe("443/tcp");

    const many: PortDto[] = Array.from({ length: 5 }, (_, i) => ({
      ip: "0.0.0.0",
      public_port: 8000 + i,
      private_port: 80 + i,
      proto: "tcp",
    }));
    expect(formatPorts(many)).toBe(
      "0.0.0.0:8000→80/tcp, 0.0.0.0:8001→81/tcp, 0.0.0.0:8002→82/tcp 等 5 项",
    );
  });
});
