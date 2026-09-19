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
