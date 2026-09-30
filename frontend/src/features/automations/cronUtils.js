// Small helper to let the UI offer a plain time-picker + day checkboxes while
// storing/scheduling a standard 5-field cron expression under the hood.
// Only meant to round-trip expressions this UI itself generates.

export const DAY_LABELS = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

// `dayOfMonth` (1-28), when set, switches to a monthly schedule on that day
// and ignores `days`; capped at 28 so it fires in every month, February too.
export function buildCronExpression({ hour, minute, days, dayOfMonth }) {
  if (dayOfMonth) return `${minute} ${hour} ${dayOfMonth} * *`;
  const dayField = !days || days.length === 0 || days.length === 7 ? '*' : [...days].sort().join(',');
  return `${minute} ${hour} * * ${dayField}`;
}

export function parseCronExpression(expression) {
  if (!expression) return { hour: 22, minute: 0, days: [], dayOfMonth: null };
  const [minute, hour, domField, , dayField] = expression.split(' ');
  const days = !dayField || dayField === '*' ? [] : dayField.split(',').map(Number);
  const dayOfMonth = domField && domField !== '*' ? Number(domField) || null : null;
  return { hour: Number(hour) || 0, minute: Number(minute) || 0, days, dayOfMonth };
}
