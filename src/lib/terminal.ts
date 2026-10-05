/** shell 自动降级链：容器内不存在当前 shell 时依次回退（Alpine 无 bash 等），ash 之后止步 */
const SHELL_FALLBACK: Record<string, string> = { bash: "sh", sh: "ash", ash: "" };

/**
 * exec 启动失败时返回下一个应尝试的 shell（无需降级返回 null）。
 * 失败信息有两个来源：daemon 同步报错在 reason 里；更常见的是异步失败——
 * OCI 错误作为输出流推给前端后再关闭流（redis:alpine 实测路径），
 * 此时 Ended 原因只是「进程已退出」，必须检查已收到的输出头部。
 * 刻意不匹配 "No such file"：普通命令输出（如 ls 报错）也可能含该字样，会误触发降级。
 */
export function fallbackShell(
  shell: string,
  reason: string,
  outputHead: string,
): string | null {
  const next = SHELL_FALLBACK[shell];
  if (!next) return null;
  return /executable file not found|OCI runtime exec failed/i.test(`${reason}\n${outputHead}`)
    ? next
    : null;
}

/** 已收输出是否为 exec 启动失败（用于把含糊的「进程已退出」换算成准确原因） */
export function isExecStartFailure(outputHead: string): boolean {
  return /executable file not found|OCI runtime exec failed/i.test(outputHead);
}
