import { describe, expect, it } from "vitest";

import {
  reduce,
  shouldRunStartupCheck,
  UP_TO_DATE_RESET_MS,
  UPDATE_CHECK_INTERVAL_MS,
  type AppUpdateState,
} from "./appUpdate";
import type { AppUpdateInfo } from "../types/appUpdate";

const DAY = 24 * 60 * 60 * 1000;

const info = (hasUpdate: boolean): AppUpdateInfo => ({
  current_version: "1.0.5",
  latest_version: hasUpdate ? "1.1.0" : "1.0.5",
  has_update: hasUpdate,
  release_notes: "修复若干问题",
  html_url: "https://github.com/WuYiLingOps/dockpilot/releases/tag/v1.1.0",
  published_at: "2026-10-01T00:00:00Z",
  download: hasUpdate
    ? {
        name: "dockpilot_1.1.0_amd64.deb",
        url: "https://github.com/WuYiLingOps/dockpilot/releases/download/v1.1.0/dockpilot_1.1.0_amd64.deb",
        size: 1024,
      }
    : null,
});

const idleState: AppUpdateState = {
  status: "idle",
  latest: null,
  error: null,
  lastCheckAt: null,
  downloadProgress: null,
  downloadedPath: null,
};

describe("启动检查节流", () => {
  it("从未检查过（无记录）时应检查", () => {
    expect(shouldRunStartupCheck(null, 1000)).toBe(true);
  });

  it("距上次检查不足 24h 时跳过，达到 24h 时检查", () => {
    expect(shouldRunStartupCheck(0, DAY - 1)).toBe(false);
    expect(shouldRunStartupCheck(0, DAY)).toBe(true);
    expect(shouldRunStartupCheck(0, 3 * DAY)).toBe(true);
  });

  it("节流间隔常量为 24 小时", () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("检查更新状态机", () => {
  it("开始检查进入 checking 并清除错误", () => {
    const s = reduce({ ...idleState, status: "error", error: "旧的错误" }, { type: "check-started" });
    expect(s.status).toBe("checking");
    expect(s.error).toBeNull();
  });

  it("手动检查发现更新进入 available 并记录 lastCheckAt", () => {
    const s = reduce(idleState, {
      type: "check-succeeded",
      info: info(true),
      at: 123,
      manual: true,
    });
    expect(s.status).toBe("available");
    expect(s.lastCheckAt).toBe(123);
    expect(s.latest?.latest_version).toBe("1.1.0");
  });

  it("手动检查已是最新进入 up-to-date", () => {
    const s = reduce(idleState, {
      type: "check-succeeded",
      info: info(false),
      at: 123,
      manual: true,
    });
    expect(s.status).toBe("up-to-date");
  });

  it("启动检查已是最新静默回 idle（仅记录 lastCheckAt）", () => {
    const s = reduce(idleState, {
      type: "check-succeeded",
      info: info(false),
      at: 123,
      manual: false,
    });
    expect(s.status).toBe("idle");
    expect(s.lastCheckAt).toBe(123);
  });

  it("手动检查失败进入 error 并保留文案；启动检查失败静默回 idle", () => {
    const checking: AppUpdateState = { ...idleState, status: "checking" };
    const manual = reduce(checking, { type: "check-failed", error: "网络错误", manual: true });
    expect(manual.status).toBe("error");
    expect(manual.error).toBe("网络错误");

    const startup = reduce(checking, { type: "check-failed", error: "网络错误", manual: false });
    expect(startup.status).toBe("idle");
    expect(startup.error).toBeNull();
  });

  it("reset 回 idle（保留 lastCheckAt 供「上次检查」展示）", () => {
    const available: AppUpdateState = {
      ...idleState,
      status: "up-to-date",
      lastCheckAt: 123,
    };
    const s = reduce(available, { type: "reset" });
    expect(s.status).toBe("idle");
    expect(s.lastCheckAt).toBe(123);
  });

  it("「已是最新」停留时长常量为 5 秒", () => {
    expect(UP_TO_DATE_RESET_MS).toBe(5000);
  });
});

describe("下载状态机", () => {
  const available: AppUpdateState = {
    ...idleState,
    status: "available",
    latest: info(true),
  };

  it("download-started 进入 downloading 并清空进度", () => {
    const s = reduce(
      { ...available, downloadProgress: { downloaded: 1, total: 2 } },
      { type: "download-started" },
    );
    expect(s.status).toBe("downloading");
    expect(s.downloadProgress).toBeNull();
    expect(s.error).toBeNull();
  });

  it("download-progress 更新进度", () => {
    const started = reduce(available, { type: "download-started" });
    const s = reduce(started, { type: "download-progress", downloaded: 512, total: 1024 });
    expect(s.status).toBe("downloading");
    expect(s.downloadProgress).toEqual({ downloaded: 512, total: 1024 });
  });

  it("download-finished 进入 downloaded 并记录落盘路径", () => {
    const started = reduce(available, { type: "download-started" });
    const s = reduce(started, { type: "download-finished", path: "/tmp/updates/a.deb" });
    expect(s.status).toBe("downloaded");
    expect(s.downloadedPath).toBe("/tmp/updates/a.deb");
    expect(s.downloadProgress).toBeNull();
  });

  it("download-failed 回到 available 供重试（错误经 toast 呈现）", () => {
    const started = reduce(available, { type: "download-started" });
    const s = reduce(started, { type: "download-failed" });
    expect(s.status).toBe("available");
    expect(s.downloadProgress).toBeNull();
    expect(s.latest).not.toBeNull();
  });

  it("install-started 进入 installing；install-failed 回到 downloaded 供重试", () => {
    const downloaded: AppUpdateState = {
      ...available,
      status: "downloaded",
      downloadedPath: "/tmp/updates/a.deb",
    };
    const s = reduce(downloaded, { type: "install-started" });
    expect(s.status).toBe("installing");

    const f = reduce(s, { type: "install-failed" });
    expect(f.status).toBe("downloaded");
    expect(f.downloadedPath).toBe("/tmp/updates/a.deb");
  });
});
