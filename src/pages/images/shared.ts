import { shortId } from "../../lib/format";
import type { ImageDto } from "../../types/docker";
import type { RegistryProfile } from "../../types/settings";

/** 保存对话框默认文件名：单镜像按标签生成（非法字符转 -），批量用日期 */
export function defaultExportName(imgs: ImageDto[]): string {
  if (imgs.length === 1) {
    const base = (imgs[0].tags[0] || shortId(imgs[0].id))
      .replace(/^sha256:/, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-");
    return `${base}.tar`;
  }
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `docker-images-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.tar`;
}

/** 从本地镜像引用推导推送目标建议：去掉与已知仓库一致的 host 前缀，拆出 tag */
export function suggestPushTarget(reference: string): { repository: string; tag: string } {
  const colon = reference.lastIndexOf(":");
  const hasTag = colon > reference.lastIndexOf("/") && colon >= 0;
  const repo = hasTag ? reference.slice(0, colon) : reference;
  const t = hasTag ? reference.slice(colon + 1) : "latest";
  const segments = repo.split("/");
  // 首段形如域名（含 . 或 : 端口 或 localhost）时视为 registry host，去掉后作为仓库名
  const first = segments[0] ?? "";
  const hostLike = segments.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  const repository = hostLike ? segments.slice(1).join("/") : repo;
  return { repository: repository || repo, tag: t || "latest" };
}

const HUB_HOSTS = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

/** 与后端 ref_registry_domain 同规则：提取镜像引用的 registry 域名（无域名前缀 = Docker Hub 官方镜像） */
export function refRegistryDomain(reference: string): string {
  const name = reference.split("@")[0] ?? reference;
  const segments = name.split("/");
  const first = segments[0] ?? "";
  return segments.length > 1 &&
    (first.includes(".") || first.includes(":") || first === "localhost")
    ? first
    : "docker.io";
}

function sameRegistry(a: string, b: string): boolean {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (HUB_HOSTS.has(na) && HUB_HOSTS.has(nb)) return true;
  return na === nb;
}

/** 拉取将自动使用的凭据：按镜像引用的 registry 域名匹配已保存凭据（无匹配 = 匿名拉取） */
export function resolvePullCredential(
  reference: string,
  registries: RegistryProfile[],
): RegistryProfile | null {
  const domain = refRegistryDomain(reference);
  return registries.find((r) => sameRegistry(r.registry, domain)) ?? null;
}
