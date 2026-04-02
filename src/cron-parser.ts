/**
 * Minimal cron expression parser (no external dependencies).
 * Supports: minute, hour, day-of-month, month, day-of-week
 * Syntax: standard cron (0-59, 0-23, 1-31, 1-12, 0-6)
 * Features: wildcard, ranges (1-5), steps, lists (1,3,5)
 */

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    let start: number;
    let end: number;

    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map((n) => parseInt(n, 10));
      start = a;
      end = b;
    } else {
      start = parseInt(range, 10);
      end = start;
    }

    for (let i = start; i <= end; i += step) {
      if (i >= min && i <= max) {
        values.add(i);
      }
    }
  }

  return values;
}

export function parseCronExpression(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  try {
    return {
      minutes: parseField(parts[0], 0, 59),
      hours: parseField(parts[1], 0, 23),
      daysOfMonth: parseField(parts[2], 1, 31),
      months: parseField(parts[3], 1, 12),
      daysOfWeek: parseField(parts[4], 0, 6),
    };
  } catch {
    return null;
  }
}

export function cronMatchesDate(expression: string, date: Date): boolean {
  const fields = parseCronExpression(expression);
  if (!fields) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-indexed
  const dayOfWeek = date.getDay(); // 0 = Sunday

  return (
    fields.minutes.has(minute) &&
    fields.hours.has(hour) &&
    fields.daysOfMonth.has(dayOfMonth) &&
    fields.months.has(month) &&
    fields.daysOfWeek.has(dayOfWeek)
  );
}
