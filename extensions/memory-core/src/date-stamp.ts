// Canonical YYYY-MM-DD stamp used by dated memory artifacts (flush files,
// Fragments). The timezone is the configured user timezone; the ISO fallback
// preserves historical behavior when Intl parts are unavailable.
export function formatDateStampInTimezone(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Canonical 24-hour HH:MM entry time for dated Fragment day files, in the
 * configured user timezone. h23 keeps midnight at "00" across ICU locales.
 */
export function formatTimeOfDayInTimezone(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (hour && minute) {
    return `${hour}:${minute}`;
  }
  return new Date(nowMs).toISOString().slice(11, 16);
}
