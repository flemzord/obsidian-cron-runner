import {
  App,
  FuzzySuggestModal,
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

    this.addCommand({
      id: "run-single-cron",
      name: "Run a cron job manually",
      callback: () => this.showCronPicker(),
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

    // For claude action type, the body is the prompt — action is optional
    if (!action && actionType !== "claude") return null;

    return {
      filePath: file.path,
      name: (fm["name"] as string) || file.basename,
      cron,
      enabled: fm["enabled"] !== false, // default true
      actionType: actionType as CronJob["actionType"],
      action: action || "",
      body: content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim(),
      outputFolder: fm["output_folder"] as string | undefined,
      model: fm["model"] as string | undefined,
      allowedTools: fm["allowed_tools"] as string[] | undefined,
      maxTurns: fm["max_turns"] as number | undefined,
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
        case "claude":
          this.executeClaude(job);
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

  private executeClaude(job: CronJob): void {
    this.log(`Executing Claude prompt: ${job.name}`);

    const { spawn } = require("child_process") as typeof import("child_process");

    // Use body content as prompt, fall back to action field for external file path
    let promptContent = job.body || "";
    if (!promptContent && job.action) {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      const promptPath = path.resolve(job.action);
      if (!fs.existsSync(promptPath)) {
        new Notice(`Cron error: ${job.name} — prompt file not found: ${job.action}`);
        return;
      }
      promptContent = fs.readFileSync(promptPath, "utf-8");
    }

    if (!promptContent) {
      new Notice(`Cron error: ${job.name} — no prompt content found`);
      return;
    }

    const model = job.model || this.settings.claudeDefaultModel;
    const claudeBin = this.settings.claudePath;

    // Build args
    const args: string[] = [
      "--print",
      "--model", model,
    ];

    if (job.maxTurns) {
      args.push("--max-turns", String(job.maxTurns));
    }

    if (job.allowedTools && job.allowedTools.length > 0) {
      for (const tool of job.allowedTools) {
        args.push("--allowedTools", tool);
      }
    }

    // Pass prompt content via stdin
    args.push("--");
    args.push(promptContent);

    const startTime = Date.now();
    new Notice(`Cron: ${job.name} — Claude started (model: ${model})`);

    const child = spawn(claudeBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 600000, // 10 min max
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code: number | null) => {
      const duration = Math.round((Date.now() - startTime) / 1000);

      if (code === 0) {
        this.log(`Claude finished in ${duration}s. Output: ${stdout.slice(0, 500)}`);
        new Notice(`Cron: ${job.name} — Claude finished (${duration}s)`, 8000);

        // Log output to the cron logs folder
        this.saveCronLog(job, stdout, duration);
      } else {
        this.log(`Claude failed (code ${code}): ${stderr}`);
        new Notice(`Cron error: ${job.name} — Claude failed (code ${code})`, 10000);
      }
    });

    child.on("error", (err: Error) => {
      this.log(`Claude spawn error: ${err.message}`);
      new Notice(`Cron error: ${job.name} — ${err.message}`, 10000);
    });
  }

  private async saveCronLog(job: CronJob, output: string, duration: number): Promise<void> {
    const logFolder = `${this.settings.cronFolder}/logs`;
    const folder = this.app.vault.getAbstractFileByPath(logFolder);
    if (!folder) {
      await this.app.vault.createFolder(logFolder);
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 16).replace(":", "");
    const safeName = job.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const logPath = `${logFolder}/${dateStr}-${timeStr}-${safeName}.md`;

    const logContent = [
      "---",
      `name: "${job.name}"`,
      `date: "${now.toISOString()}"`,
      `duration: ${duration}`,
      `model: "${job.model || this.settings.claudeDefaultModel}"`,
      `prompt: "${job.action}"`,
      "---",
      "",
      `# ${job.name} — ${dateStr}`,
      "",
      output,
    ].join("\n");

    await this.app.vault.create(logPath, logContent);
    this.log(`Log saved: ${logPath}`);
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

  private async showCronPicker(): Promise<void> {
    const jobs = await this.getCronJobs();
    if (jobs.length === 0) {
      new Notice(`No cron jobs found in "${this.settings.cronFolder}/"`);
      return;
    }
    new CronPickerModal(this.app, jobs, (job) => {
      this.executeJob(job, new Date()).then(() => this.updateLastRun(job, new Date()));
    }).open();
  }
}

class CronPickerModal extends FuzzySuggestModal<CronJob> {
  private jobs: CronJob[];
  private onChoose: (job: CronJob) => void;

  constructor(app: App, jobs: CronJob[], onChoose: (job: CronJob) => void) {
    super(app);
    this.jobs = jobs;
    this.onChoose = onChoose;
    this.setPlaceholder("Pick a cron job to run...");
  }

  getItems(): CronJob[] {
    return this.jobs;
  }

  getItemText(job: CronJob): string {
    const status = job.enabled ? "ON" : "OFF";
    return `[${status}] ${job.name} — ${job.cron} (${job.actionType})`;
  }

  onChooseItem(job: CronJob): void {
    new Notice(`Running: ${job.name}...`);
    this.onChoose(job);
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

    containerEl.createEl("h3", { text: "Claude Integration" });

    new Setting(containerEl)
      .setName("Claude CLI path")
      .setDesc("Path to the Claude CLI binary")
      .addText((text) =>
        text
          .setPlaceholder("claude")
          .setValue(this.plugin.settings.claudePath)
          .onChange(async (value) => {
            this.plugin.settings.claudePath = value || "claude";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default Claude model")
      .setDesc("Model used when not specified in the cron file")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("sonnet", "Sonnet")
          .addOption("opus", "Opus")
          .addOption("haiku", "Haiku")
          .setValue(this.plugin.settings.claudeDefaultModel)
          .onChange(async (value) => {
            this.plugin.settings.claudeDefaultModel = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Advanced" });

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
- claude: run a Claude CLI prompt from a file (async, logs output)
- shell: execute a shell command (desktop only, must be enabled in settings)

## Claude action example
action_type: claude
action: "/path/to/prompt.md"
model: sonnet
max_turns: 5
allowed_tools:
  - mcp__slack
  - mcp__notion`);
  }
}
