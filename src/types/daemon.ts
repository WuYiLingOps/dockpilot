/** 与 src-tauri/src/daemon_config.rs 的 DaemonConfigDto 对应 */

export interface DaemonConfigDto {
  exists: boolean;
  registry_mirrors: string[];
  live_restore: boolean;
  other_keys: string[];
}

export interface UsageCategory {
  count: number;
  size: number;
}

/** 与 src-tauri/src/cleanup.rs 对应 */
export interface DiskUsageDto {
  dangling_images: UsageCategory;
  unused_images: UsageCategory;
  stopped_containers: UsageCategory;
  unused_volumes: UsageCategory;
  build_cache: UsageCategory;
  total_reclaimable: number;
}

export interface CleanupItemResult {
  kind: string;
  removed: number;
  space_reclaimed: number;
  error: string | null;
}

export interface CleanupResultDto {
  items: CleanupItemResult[];
  total_reclaimed: number;
}
