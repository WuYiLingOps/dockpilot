import { describe, expect, it } from "vitest";

import { fallbackShell, isExecStartFailure } from "./terminal";

const OCI_ERR =
  'OCI runtime exec failed: exec failed: unable to start container process: exec: "bash": executable file not found in $PATH: unknown';

describe("终端 shell 自动降级", () => {
  it("start_exec 同步报错（原因含 executable file not found）时降级", () => {
    expect(
      fallbackShell("bash", '终端启动失败: exec: "bash": executable file not found in $PATH', ""),
    ).toBe("sh");
  });

  it("daemon 经输出流异步回传 OCI 错误时也能降级（redis:alpine 实测路径）", () => {
    expect(fallbackShell("bash", "进程已退出", OCI_ERR)).toBe("sh");
    expect(fallbackShell("sh", "进程已退出", OCI_ERR)).toBe("ash");
  });

  it("ash 之后无降级；用户正常 exit（输出无错误特征）不降级", () => {
    expect(fallbackShell("ash", "进程已退出", OCI_ERR)).toBeNull();
    expect(fallbackShell("bash", "进程已退出", "root@host:/# exit\r\n")).toBeNull();
  });

  it("普通命令输出中的 No such file 不触发降级", () => {
    expect(
      fallbackShell("bash", "进程已退出", "ls: cannot access 'x': No such file or directory"),
    ).toBeNull();
  });

  it("isExecStartFailure 识别 OCI 错误输出、放行正常会话输出", () => {
    expect(isExecStartFailure(OCI_ERR)).toBe(true);
    expect(isExecStartFailure("root@host:/# exit\r\n")).toBe(false);
  });
});
