/** @param {number} value */
const pad = (value) => String(value).padStart(2, "0");

/** @param {number} ms @param {string} format */
export function timestampLabel(ms, format) {
  const date = new Date(ms);
  const hour = date.getHours();
  const minutes = pad(date.getMinutes());
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (format === "iso") return `${day}T${pad(hour)}:${minutes}`;
  if (format === "24h") return `${day} ${pad(hour)}:${minutes}`;
  if (format === "12h") return `${day} ${hour % 12 || 12}:${minutes} ${hour < 12 ? "AM" : "PM"}`;
  return date.toLocaleString();
}

/** @param {unknown} value @param {{timeMode: string, dateFormat: string}} preferences @param {number} now */
export function eventTime(value, { timeMode, dateFormat }, now, credit = false) {
  const timestamp = typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return credit ? "Expiry not reported" : null;
  if (timestamp <= now) return credit ? "Expired" : "Reset due";
  const verb = credit ? "Expires" : "Resets";
  if (timeMode === "timestamp") return `${verb} ${timestampLabel(timestamp, dateFormat)}`;
  const minutes = Math.ceil((timestamp - now) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  const parts = [days && `${days}d`, hours && `${hours}h`, minutes % 60 && `${minutes % 60}m`].filter(Boolean);
  return `${verb} in ${parts.join(" ")}`;
}
