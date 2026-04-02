import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  parseYaml,
} from "obsidian";
import { cronMatchesDate } from "./cron-parser";
import {
  CronJob,
  CronRunnerSettings,
  DEFAULT_SETTINGS,
} from "./types";

export default class CronRunnerPlugin extends Plugin {
  settings: CronRunnerSettings = DEFAULT_SETTINGS;
  private intervalId: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new CronRunnerSettingTab(this.app, this));

    this.addCommand({
      id: "run-cron-check",
      name: "Check and run due crons now",
      callback: () => this.checkAndRunCrons(),
    });

    this.addCommand({
      id: "list-crons",
      name: "List all cron jobs",
      callback: () => this.listCrons(),
    });

    // Start the interval once layout is ready
    this.app.workspace.onLayoutReady(() => {
      this.startInterval();
      this.log("Cron Runner started — checking every " + this.settings.intervalSeconds + "s");
    });
  }

  onunload(): void {
    this.stopInterval();
    this.log("Cron Runner stopped");
  }

  private startInterval(): void {
    this.stopInterval();
    this.intervalId = window.setInterval(
      () => this.checkAndRunCrons(),
      this.settings.intervalSeconds * 1000
    );
    this.registerInterval(this.intervalId);
  }

  private stopInterval(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  restartInterval(): void {
    this.startInterval();
  }

  private log(msg: string): void {
    if (this.settings.debug) {
      console.log(`[CronRunner] ${msg}`);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Parse all cron files from the configured folder.
   */
  async getCronJobs(): Promise<CronJob[]> {
    const folder = this.app.vault.getAbstractFileByPath(this.settings.cronFolder);
    if (!folder || !(folder instanceof TFolder)) {
      this.log(`Cron folder "${this.settings.cronFolder}" not found`);
      return [];
    }

    const jobs: CronJob[] = [];

    for (const file of folder.children) {
      if (!(file instanceof TFile) || file.extension !== "md") continue;

      try {
        const content = await this.app.vault.read(file);
        const job = this.parseCronFile(file, content);
        if (job) jobs.push(job);
      } catch (e) {
        this.log(`Error reading ${file.path}: ${e}`);
      }
    }

    return jobs;
  }

  private parseCronFile(file: TFile, content: string): CronJob | null {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    let fm: Record<string, unknown>;
    try {
      fm = parseYaml(fmMatch[1]);
    } catch {
      this.log(`Invalid YAML in ${file.path}`);
      return null;
    }

    const cron = fm["cron"] as string | undefined;
    if (!cron) return null;

    const actionType = (fm["action_type"] as string) || "command";
    const action = fm["action"] as string | undefined;
    if (!action) return null;

    return {
      filePath: file.path,
      name: (fm["name"] as string) || file.basename,
      cron,
      enabled: fm["enabled"] !== false, // default true
      actionType: actionType as CronJob["actionType"],
      action,
      outputFolder: fm["output_folder"] as string | undefined,
      lastRun: fm["last_run"] as string | undefined,
    };
  }

  /**
   * Main loop: check each cron and run if due.
   */
  async checkAndRunCrons(): Promise<void> {
    const now = new Date();
    const jobs = await this.getCronJobs();

    this.log(`Checking ${jobs.length} cron(s) at ${now.toLocaleTimeString()}`);

    for (const job of jobs) {
      if (!job.enabled) continue;

      // Skip if already ran this minute
      if (job.lastRun) {
        const lastRun = new Date(job.lastRun);
        if (
          lastRun.getFullYear() === now.getFullYear() &&
          lastRun.getMonth() === now.getMonth() &&
          lastRun.getDate() === now.getDate() &&
          lastRun.getHours() === now.getHours() &&
          lastRun.getMinutes() === now.getMinutes()
        ) {
          continue;
        }
      }

      if (cronMatchesDate(job.cron, now)) {
        this.log(`Cron matched: ${job.name} (${job.cron})`);
        await this.executeJob(job, now);
      }
    }
  }

  private async executeJob(job: CronJob, now: Date): Promise<void> {
    try {
      switch (job.actionType) {
        case "command":
          await this.executeCommand(job);
          break;
        case "templater":
          await this.executeTemplater(job);
          break;
        case "create-note":
          await this.executeCreateNote(job, now);
          break;
        case "shell":
          await this.executeShell(job);
          break;
        case "notice":
          new Notice(job.action, 5000);
          break;
        default:
          this.log(`Unknown action type: ${job.actionType}`);
          return;
      }

      // Update last_run in frontmatter
      await this.updateLastRun(job, now);

      if (this.settings.showNotices) {
        new Notice(`Cron executed: ${job.name}`);
      }
    } catch (e) {
      console.error(`[CronRunner] Error executing ${job.name}:`, e);
      new Notice(`Cron error: ${job.name} — ${e}`);
    }
  }

  private async executeCommand(job: CronJob): Promise<void> {
    this.log(`Executing command: ${job.action}`);
    // @ts-ignore — executeCommandById exists but isn't in the public API types
    await this.app.commands.executeCommandById(job.action);
  }

  private async executeTemplater(job: CronJob): Promise<void> {
    this.log(`Executing Templater template: ${job.action}`);
    const templateFile = this.app.vault.getAbstractFileByPath(job.action);
    if (!templateFile || !(templateFile instanceof TFile)) {
      throw new Error(`Template not found: ${job.action}`);
    }

    // Use Templater's internal API if available
    // @ts-ignore
    const templater = this.app.plugins.plugins["templater-obsidian"];
    if (!templater) {
      throw new Error("Templater plugin is not installed or enabled");
    }

    const outputFolder = job.outputFolder || "00_Inbox";
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const newFileName = `${outputFolder}/${job.name}-${timestamp}.md`;

    // @ts-ignore — Templater internal API
    const content = await templater.templater.read_and_parse_template({
      target_file: templateFile,
      run_mode: 0,
    });

    await this.app.vault.create(newFileName, content || "");
  }

  private async executeCreateNote(job: CronJob, now: Date): Promise<void> {
    const outputFolder = job.outputFolder || "00_Inbox";
    const dateStr = now.toISOString().slice(0, 10);
    const fileName = `${outputFolder}/${job.name}-${dateStr}.md`;

    // Use action as template content (supports simple text)
    const existing = this.app.vault.getAbstractFileByPath(fileName);
    if (existing) {
      this.log(`Note already exists: ${fileName}, skipping`);
      return;
    }

    const folder = this.app.vault.getAbstractFileByPath(outputFolder);
    if (!folder) {
      await this.app.vault.createFolder(outputFolder);
    }

    await this.app.vault.create(fileName, job.action);
    this.log(`Created note: ${fileName}`);
  }

  private async executeShell(job: CronJob): Promise<void> {
    if (!this.settings.allowShell) {
      throw new Error("Shell execution is disabled. Enable it in Cron Runner settings.");
    }

    this.log(`Executing shell command: ${job.action}`);

    // Use Node.js child_process (desktop only)
    const { exec } = require("child_process") as typeof import("child_process");

    return new Promise((resolve, reject) => {
      exec(job.action, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          this.log(`Shell error: ${stderr}`);
          reject(new Error(`Shell command failed: ${stderr || error.message}`));
        } else {
          this.log(`Shell output: ${stdout}`);
          resolve();
        }
      });
    });
  }

  /**
   * Update the last_run field in the cron file's frontmatter.
   */
  private async updateLastRun(job: CronJob, now: Date): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(job.filePath);
    if (!file || !(file instanceof TFile)) return;

    const content = await this.app.vault.read(file);
    const isoString = now.toISOString();

    let newContent: string;
    if (content.match(/^last_run:/m)) {
      newContent = content.replace(/^last_run:.*$/m, `last_run: "${isoString}"`);
    } else {
      // Insert last_run before the closing ---
      newContent = content.replace(/\n---/, `\nlast_run: "${isoString}"\n---`);
    }

    await this.app.vault.modify(file, newContent);
  }

  /**
   * List all cron jobs in a notice.
   */
  private async listCrons(): Promise<void> {
    const jobs = await this.getCronJobs();
    if (jobs.length === 0) {
      new Notice(`No cron jobs found in "${this.settings.cronFolder}/"`);
      return;
    }

    const lines = jobs.map(
      (j) =>
        `${j.enabled ? "✅" : "⏸"} ${j.name}\n   ${j.cron} → ${j.actionType}:${j.action}`
    );
    new Notice(lines.join("\n\n"), 10000);
  }
}

class CronRunnerSettingTab extends PluginSettingTab {
  plugin: CronRunnerPlugin;

  constructor(app: App, plugin: CronRunnerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Cron Runner Settings" });

    new Setting(containerEl)
      .setName("Cron folder")
      .setDesc("Folder containing cron definition files (relative to vault root)")
      .addText((text) =>
        text
          .setPlaceholder("Crons")
          .setValue(this.plugin.settings.cronFolder)
          .onChange(async (value) => {
            this.plugin.settings.cronFolder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Check interval (seconds)")
      .setDesc("How often to check for due crons")
      .addText((text) =>
        text
          .setPlaceholder("60")
          .setValue(String(this.plugin.settings.intervalSeconds))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (num && num >= 10) {
              this.plugin.settings.intervalSeconds = num;
              await this.plugin.saveSettings();
              this.plugin.restartInterval();
            }
          })
      );

    new Setting(containerEl)
      .setName("Show notices")
      .setDesc("Display a notification when a cron job runs")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showNotices)
          .onChange(async (value) => {
            this.plugin.settings.showNotices = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Allow shell commands")
      .setDesc("Enable execution of shell commands (security risk — only enable if you trust your cron files)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.allowShell)
          .onChange(async (value) => {
            this.plugin.settings.allowShell = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debug mode")
      .setDesc("Log debug info to the developer console")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debug)
          .onChange(async (value) => {
            this.plugin.settings.debug = value;
            await this.plugin.saveSettings();
          })
      );

    // Help section
    containerEl.createEl("h3", { text: "Cron file format" });
    const pre = containerEl.createEl("pre");
    pre.setText(`---
name: "My Cron Job"
cron: "0 9 * * 1-5"
enabled: true
action_type: command
action: "app:open-today"
---

# My Cron Job
Runs every weekday at 9am and opens today's daily note.

## Action types
- command: run an Obsidian command by ID
- templater: render a Templater template
- create-note: create a note with content from action field
- notice: show a notification in Obsidian
- shell: execute a shell command (desktop only, must be enabled in settings)`);
  }
}
