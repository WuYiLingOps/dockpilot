/** 与 src-tauri/src/settings.rs 的 AppSettings 对应 */

export type ThemeMode = "system" | "light" | "dark";
export type TerminalShell = "bash" | "sh" | "ash";

export interface AppSettings {
  theme: ThemeMode;
  docker_socket: string;
  containers_refresh_secs: number;
  images_refresh_secs: number;
  logs_default_tail: number;
  logs_timestamps: boolean;
  terminal_shell: TerminalShell;
  mirror_custom: string[];
}
