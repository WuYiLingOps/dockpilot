import { afterAll, describe, expect, it } from "vitest";
import { interpolate, resolveLang } from "./index";
import { zh } from "./zh";
import { en } from "./en";

const realNavigator = globalThis.navigator;

/** 临时替换 navigator.language，测毕还原（不依赖宿主真实值：runner 为 en-US、本地可能为 zh-*） */
function withNavigatorLanguage(lang: string | undefined, fn: () => void) {
  Object.defineProperty(globalThis, "navigator", {
    value: lang === undefined ? undefined : { language: lang },
    configurable: true,
  });
  try {
    fn();
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      value: realNavigator,
      configurable: true,
    });
  }
}

afterAll(() => {
  Object.defineProperty(globalThis, "navigator", {
    value: realNavigator,
    configurable: true,
  });
});

describe("resolveLang", () => {
  it("显式语言直接生效", () => {
    expect(resolveLang("zh")).toBe("zh");
    expect(resolveLang("en")).toBe("en");
  });
  it("显式语言优先于系统语言", () => {
    withNavigatorLanguage("en-US", () => {
      expect(resolveLang("zh")).toBe("zh");
    });
  });
  it("system 按系统语言解析：zh* → 中文，其他 → 英文", () => {
    withNavigatorLanguage("zh-CN", () => {
      expect(resolveLang("system")).toBe("zh");
    });
    withNavigatorLanguage("en-US", () => {
      expect(resolveLang("system")).toBe("en");
    });
    withNavigatorLanguage("fr", () => {
      expect(resolveLang("system")).toBe("en");
    });
  });
  it("无 navigator 或无 language 值时回落中文（基准语言）", () => {
    withNavigatorLanguage(undefined, () => {
      expect(resolveLang("system")).toBe("zh");
    });
    withNavigatorLanguage("", () => {
      expect(resolveLang("")).toBe("zh");
      expect(resolveLang("system")).toBe("zh");
    });
  });
});

describe("词典完整性", () => {
  it("en 词典与 zh 词典 key 完全一致（同形校验兜底，编译期之外的运行期保证）", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });
  it("两侧词条均为非空字符串", () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(String(value).length, `zh.${key}`).toBeGreaterThan(0);
    }
    for (const [key, value] of Object.entries(en)) {
      expect(String(value).length, `en.${key}`).toBeGreaterThan(0);
    }
  });
});

describe("interpolate", () => {
  it("替换命名占位符", () => {
    expect(
      interpolate("容器 {name} 已退出（exit code {code}）", { name: "web", code: 137 }),
    ).toBe("容器 web 已退出（exit code 137）");
  });
  it("未提供的占位符原样保留，多余参数被忽略", () => {
    expect(interpolate("值 {missing}", { other: 1 })).toBe("值 {missing}");
    expect(interpolate("纯文本", { other: 1 })).toBe("纯文本");
  });
});
