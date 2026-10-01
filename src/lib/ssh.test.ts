import { describe, expect, it } from "vitest";
import { friendlySshError, parseHostKeyChange } from "./ssh";

describe("parseHostKeyChange", () => {
  const payload = {
    dest: "[10.0.0.5]:2222",
    stored: "SHA256:aaaa",
    new: "SHA256:bbbb",
    algo: "ssh-ed25519",
  };

  it("解析后端结构化指纹变更错误", () => {
    const err = `[HOST_KEY_CHANGED]${JSON.stringify(payload)}`;
    expect(parseHostKeyChange(err)).toEqual(payload);
  });

  it("错误文本含其他前缀内容时仍能定位载荷", () => {
    const err = `SSH 认证失败: 前置说明 [HOST_KEY_CHANGED]${JSON.stringify(payload)}`;
    expect(parseHostKeyChange(err)?.new).toBe("SHA256:bbbb");
  });

  it("非指纹变更错误返回 null", () => {
    expect(parseHostKeyChange("SSH 连接失败: 连接超时")).toBeNull();
    expect(parseHostKeyChange("")).toBeNull();
  });

  it("载荷缺字段或非 JSON 返回 null", () => {
    expect(parseHostKeyChange("[HOST_KEY_CHANGED]not json")).toBeNull();
    expect(parseHostKeyChange('[HOST_KEY_CHANGED]{"dest":"h"}')).toBeNull();
    expect(
      parseHostKeyChange(
        `[HOST_KEY_CHANGED]${JSON.stringify({ ...payload, algo: 123 })}`,
      ),
    ).toBeNull();
  });
});

describe("friendlySshError", () => {
  it("指纹变更错误转为人话", () => {
    const err = `[HOST_KEY_CHANGED]${JSON.stringify({
      dest: "h",
      stored: "S1",
      new: "S2",
      algo: "ssh-ed25519",
    })}`;
    expect(friendlySshError(err)).toContain("h");
    expect(friendlySshError(err)).toContain("指纹已变更");
    expect(friendlySshError(err)).not.toContain("[HOST_KEY_CHANGED]");
  });

  it("普通错误原样返回", () => {
    expect(friendlySshError("SSH 认证失败: 密码错误")).toBe("SSH 认证失败: 密码错误");
  });
});
