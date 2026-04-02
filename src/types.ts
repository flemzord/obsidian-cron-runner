export interface CronJob {
  /** Source file path in the vault */
  filePath: string;
  /** Display name (from frontmatter or filename) */
  name: string;
  /** Cron expression, e.g. every 5 minutes */
  cron: string;
  /** Whether the job is enabled */
  enabled: boolean;
  /** Action type */
  actionType: "command" | "templater" | "create-note" | "shell" | "notice" | "claude";
  /** Action target (command ID, template path, etc.) */
  action: string;
  /** Optional: output folder for create-note action */
  outputFolder?: string;
  /** Optional: Claude model to use */
  model?: string;
  /** Optional: allowed tools for Claude */
  allowedTools?: string[];
  /** Optional: max turns for Claude */
  maxTurns?: number;
  /** Body content of the cron file (after frontmatter) */
  body?: string;
  /** Last run timestamp (ISO string, stored in frontmatter) */
  lastRun?: string;
}

export interface CronRunnerSettings {
  /** Folder containing cron definition files */
  cronFolder: string;
  /** Check interval in seconds */
  intervalSeconds: number;
  /** Whether to show a notice on cron execution */
  showNotices: boolean;
  /** Allow shell command execution */
  allowShell: boolean;
  /** Path to Claude CLI binary */
  claudePath: string;
  /** Default model for Claude actions */
  claudeDefaultModel: string;
  /** Enable debug logging to console */
  debug: boolean;
}

export const DEFAULT_SETTINGS: CronRunnerSettings = {
  cronFolder: "Crons",
  intervalSeconds: 60,
  showNotices: true,
  allowShell: false,
  claudePath: "claude",
  claudeDefaultModel: "sonnet",
  debug: false,
};
