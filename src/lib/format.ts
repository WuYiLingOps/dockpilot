import type { PortDto } from "../types/docker";

export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function timeAgo(unixSeconds: number): string {
  if (!unixSeconds) return "-";
  const diff = Date.now() / 1000 - unixSeconds;
  const m = Math.floor(diff / 60);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.floor(mo / 12)} 年前`;
}

export function shortId(id: string): string {
  return id ? id.slice(0, 12) : "-";
}

/** RFC3339 时间字符串（卷/网络/构建缓存的 created 字段）转 unix 秒；无效时返回 0（timeAgo 显示 "-"） */
export function rfc3339ToUnix(s: string | null | undefined): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

/**
 * 依据镜像引用的路径前缀归组（registry/命名空间），用于来源筛选：
 *   goharbor/harbor-core:v2.13.2                          → "goharbor"
 *   registry.cn-hangzhou.aliyuncs.com/wylhub/redis:7-alpine → "registry.cn-hangzhou.aliyuncs.com/wylhub"
 *   nginx:1.27-alpine（无前缀，Docker Hub 官方）             → "docker.io"
 *   无标签（悬空镜像）                                      → "<none>"
 */
export function imageGroup(imageRef: string | undefined): string {
  if (!imageRef) return "<none>";
  const parts = imageRef.split("/");
  return parts.length === 1 ? "docker.io" : parts.slice(0, -1).join("/");
}

/** imageGroup 返回值的展示名 */
export function imageGroupLabel(group: string): string {
  if (group === "docker.io") return "Docker Hub（无前缀）";
  if (group === "<none>") return "悬空镜像（无标签）";
  return group;
}

/**
 * 镜像引用的短展示名：去掉 registry/命名空间前缀，只留「仓库名:标签」。
 *   registry.cn-hangzhou.aliyuncs.com/wylhub/redis:7-alpine → redis:7-alpine
 *   goharbor/harbor-core:v2.13.2                            → harbor-core:v2.13.2
 *   nginx:1.27-alpine                                       → nginx:1.27-alpine
 * 完整引用请保留在 title/详情等处展示。
 */
export function imageShortRef(ref: string): string {
  const slash = ref.lastIndexOf("/");
  return slash === -1 ? ref : ref.slice(slash + 1);
}

export function formatPorts(ports: PortDto[]): string {
  if (!ports.length) return "-";
  const parts = ports.map((p) => {
    if (p.public_port != null) {
      return `${p.ip || "0.0.0.0"}:${p.public_port}→${p.private_port}${
        p.proto ? `/${p.proto}` : ""
      }`;
    }
    return `${p.private_port}${p.proto ? `/${p.proto}` : ""}`;
  });
  const shown = parts.slice(0, 3).join(", ");
  return parts.length > 3 ? `${shown} 等 ${parts.length} 项` : shown;
}
