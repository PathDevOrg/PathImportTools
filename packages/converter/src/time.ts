export function parseImportTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})([+-])(\d{2})(\d{2})$/.exec(trimmed);
  if (compact) {
    const [, year, month, day, hour, minute, second, sign, offsetHour, offsetMinute] = compact;
    const utcMillis = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
    const offsetSeconds = Number(offsetHour) * 3600 + Number(offsetMinute) * 60;
    const signedOffset = sign === "+" ? offsetSeconds : -offsetSeconds;
    return Math.floor((utcMillis - signedOffset * 1000) / 1000);
  }

  const compactNoZone = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(trimmed);
  if (compactNoZone) {
    const [, year, month, day, hour, minute, second] = compactNoZone;
    return Math.floor(Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ) / 1000);
  }

  const normalized = trimmed.endsWith("Z") ? trimmed : trimmed;
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.floor(parsed / 1000);
}

export function extractTimezoneOffsetSeconds(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const match = /T\d{6}([+-])(\d{2})(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const [, sign, hours, minutes] = match;
  const offset = Number(hours) * 3600 + Number(minutes) * 60;
  return sign === "+" ? offset : -offset;
}
