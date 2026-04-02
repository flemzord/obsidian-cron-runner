# Cron Runner

Schedule recurring tasks in Obsidian using simple markdown files with cron expressions.

## How it works

1. Create a folder in your vault (default: `Crons/`)
2. Add markdown files with a cron schedule in the frontmatter
3. The plugin checks every minute and runs matching jobs automatically

## Cron file format

```yaml
---
name: "My Scheduled Task"
cron: "0 9 * * 1-5"
enabled: true
action_type: command
action: "daily-notes"
---

# My Scheduled Task

Description of what this cron does (optional, for your reference).
```

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `cron` | Yes | Standard cron expression (minute, hour, day, month, weekday) |
| `action_type` | Yes | One of: `command`, `notice`, `create-note`, `templater`, `shell` |
| `action` | Yes | The action target (see below) |
| `name` | No | Display name (defaults to filename) |
| `enabled` | No | `true` or `false` (defaults to `true`) |
| `output_folder` | No | Output folder for `create-note` and `templater` actions |
| `last_run` | Auto | Updated automatically after each execution |

### Cron expression syntax

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, Sunday=0)
│ │ │ │ │
* * * * *
```

Supports: `*` (any), ranges (`1-5`), steps (`*/5`), lists (`1,3,5`).

### Action types

#### `command`
Execute any Obsidian command by its ID. You can find command IDs in Settings > Hotkeys.

```yaml
action_type: command
action: "daily-notes"
```

#### `notice`
Display a notification inside Obsidian.

```yaml
action_type: notice
action: "Time to take a break!"
```

#### `create-note`
Create a new note with the content specified in the `action` field.

```yaml
action_type: create-note
action: "# Daily Standup\n\n- What I did yesterday:\n- What I'll do today:\n- Blockers:"
output_folder: "Meetings"
```

#### `templater`
Render a Templater template and create a new note. Requires the [Templater](https://github.com/SilentVoid13/Templater) plugin.

```yaml
action_type: templater
action: "Templates/meeting.md"
output_folder: "Meetings"
```

#### `shell`
Execute a shell command. **Desktop only.** Use with caution.

```yaml
action_type: shell
action: "echo 'backup' >> /tmp/cron.log"
```

> **Security warning:** Shell commands run with the same permissions as Obsidian. Only use commands you trust.

## Examples

### Open daily note every weekday at 9am
```yaml
---
name: "Open Daily Note"
cron: "0 9 * * 1-5"
enabled: true
action_type: command
action: "daily-notes"
---
```

### Git backup every 2 hours
```yaml
---
name: "Git Backup"
cron: "0 */2 * * *"
enabled: true
action_type: command
action: "obsidian-git:commit"
---
```

### Reminder every 30 minutes
```yaml
---
name: "Drink Water"
cron: "*/30 9-17 * * 1-5"
enabled: true
action_type: notice
action: "Stay hydrated! Drink some water."
---
```

## Commands

- **Check and run due crons now** — manually trigger a cron check
- **List all cron jobs** — show all configured crons in a notice

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Cron folder | `Crons` | Vault folder containing cron files |
| Check interval | `60s` | How often to check for due crons (min: 10s) |
| Show notices | `true` | Display a notification when a cron runs |
| Debug mode | `false` | Log debug info to the developer console |

## Installation

### From Obsidian Community Plugins
1. Open Settings > Community Plugins > Browse
2. Search for "Cron Runner"
3. Install and enable

### Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/flemzord/obsidian-cron-runner/releases)
2. Create a folder `.obsidian/plugins/cron-runner/` in your vault
3. Copy the files into that folder
4. Enable "Cron Runner" in Settings > Community Plugins

## License

MIT
