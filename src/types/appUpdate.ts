/** 与 src-tauri/src/app_update.rs 的 UpdateCheckDto 对应 */

/** 当前平台匹配到的安装包附件（后端 UpdateAssetDto） */
export interface AppUpdateAsset {
  name: string;
  url: string;
  size: number;
}

/** 后端 check_update 返回：GitHub 最新 release 与当前版本的比较结果 */
export interface AppUpdateInfo {
  current_version: string;
  /** 最新版本号（后端已去 v 前缀） */
  latest_version: string;
  has_update: boolean;
  /** GitHub release body（markdown，前端做纯文本摘要展示） */
  release_notes: string;
  /** 该 release 页面（无匹配附件时的跳转兜底） */
  html_url: string;
  /** RFC3339 发布时间，原样透传由前端格式化 */
  published_at: string;
  /** 当前平台匹配到的安装包（未匹配为 null，回落跳转 Releases 页） */
  download: AppUpdateAsset | null;
}

/** 下载进度（后端 DownloadProgress；total 为 0 表示长度未知） */
export interface DownloadProgress {
  downloaded: number;
  total: number;
}
