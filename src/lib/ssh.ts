/** SSH 连接的前端辅助纯函数 */

/** 后端 [HOST_KEY_CHANGED] 结构化错误的载荷（对应 ssh_client.rs 的 SshError::HostKeyChanged） */
export interface HostKeyChange {
  /** known_hosts 主机标识：22 端口为 host，非 22 为 [host]:port */
  dest: string;
  /** 原记录指纹 */
  stored: string;
  /** 本次连接实测的新指纹 */
  new: string;
  /** 主机密钥算法（ssh-ed25519 / rsa-sha2-256 …） */
  algo: string;
}

const HOST_KEY_PREFIX = "[HOST_KEY_CHANGED]";

/** 从错误文本中解析主机指纹变更载荷；非指纹变更错误返回 null */
export function parseHostKeyChange(error: string): HostKeyChange | null {
  const idx = error.indexOf(HOST_KEY_PREFIX);
  if (idx === -1) return null;
  try {
    const payload = JSON.parse(error.slice(idx + HOST_KEY_PREFIX.length)) as Partial<HostKeyChange>;
    if (
      typeof payload.dest === "string" &&
      typeof payload.stored === "string" &&
      typeof payload.new === "string" &&
      typeof payload.algo === "string"
    ) {
      return payload as HostKeyChange;
    }
  } catch {
    // 非法 JSON 按普通错误处理
  }
  return null;
}

/** 剥离 [HOST_KEY_CHANGED] 前缀后的人类可读错误（解析失败时返回原文） */
export function friendlySshError(error: string): string {
  const change = parseHostKeyChange(error);
  if (!change) return error;
  return `主机 ${change.dest} 的密钥指纹已变更（${change.algo}），需确认后才能继续连接`;
}
