const BERLIN_TIME_ZONE = "Europe/Berlin";

/** Return the calendar date in Berlin, regardless of the viewer's time zone. */
export function berlinDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BERLIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

/** Add whole calendar days without letting the viewer's local time zone shift the date. */
export function addCalendarDays(dateKey: string, amount: number): string {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateKey;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + amount)
  );
  return date.toISOString().slice(0, 10);
}

export function berlinTimeLabel(value: string): string | null {
  if (!value) return null;
  const localMatch = value.match(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/);
  if (localMatch && !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return `${localMatch[1]}:${localMatch[2]}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: BERLIN_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
