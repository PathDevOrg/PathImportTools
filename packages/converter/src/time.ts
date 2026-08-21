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
    const utcMillis = strictUtcMillis(year, month, day, hour, minute, second);
    const signedOffset = validOffsetSeconds(sign, offsetHour, offsetMinute);
    if (utcMillis === null || signedOffset === null) {
      return null;
    }
    return Math.floor((utcMillis - signedOffset * 1000) / 1000);
  }

  const compactNoZone = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(trimmed);
  if (compactNoZone) {
    const [, year, month, day, hour, minute, second] = compactNoZone;
    const utcMillis = strictUtcMillis(year, month, day, hour, minute, second);
    return utcMillis === null ? null : Math.floor(utcMillis / 1000);
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
    trimmed,
  );
  if (iso) {
    const [, year, month, day, hour, minute, second = "00", fraction = "", zone] = iso;
    const utcMillis = strictUtcMillis(year, month, day, hour, minute, second);
    if (utcMillis === null) {
      return null;
    }
    const fractionMillis = Number(fraction.padEnd(3, "0").slice(0, 3));
    let offsetSeconds = 0;
    if (zone && zone !== "Z") {
      const offset = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
      offsetSeconds = offset ? (validOffsetSeconds(offset[1]!, offset[2]!, offset[3]!) ?? Number.NaN) : Number.NaN;
    }
    if (!Number.isFinite(offsetSeconds)) {
      return null;
    }
    return Math.floor((utcMillis + fractionMillis - offsetSeconds * 1000) / 1000);
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    return null;
  }

  return null;
}

function strictUtcMillis(
  year: string,
  month: string,
  day: string,
  hour: string,
  minute: string,
  second: string,
): number | null {
  const components = [year, month, day, hour, minute, second].map(Number);
  const [yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue] = components;
  if (
    monthValue! < 1 ||
    monthValue! > 12 ||
    dayValue! < 1 ||
    hourValue! > 23 ||
    minuteValue! > 59 ||
    secondValue! > 59
  ) {
    return null;
  }
  const date = new Date(0);
  date.setUTCFullYear(yearValue!, monthValue! - 1, dayValue!);
  date.setUTCHours(hourValue!, minuteValue!, secondValue!, 0);
  return date.getUTCFullYear() === yearValue &&
    date.getUTCMonth() === monthValue! - 1 &&
    date.getUTCDate() === dayValue &&
    date.getUTCHours() === hourValue &&
    date.getUTCMinutes() === minuteValue &&
    date.getUTCSeconds() === secondValue
    ? date.getTime()
    : null;
}

export function extractTimezoneOffsetSeconds(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (parseImportTimestamp(trimmed) === null) {
    return null;
  }
  if (trimmed.endsWith("Z")) {
    return 0;
  }

  const match = /([+-])(\d{2}):?(\d{2})$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const [, sign, hours, minutes] = match;
  return validOffsetSeconds(sign, hours, minutes);
}

function validOffsetSeconds(sign: string, hours: string, minutes: string): number | null {
  const hour = Number(hours);
  const minute = Number(minutes);
  if (hour > 14 || minute >= 60 || (hour === 14 && minute > 0)) {
    return null;
  }
  const offset = hour * 3600 + minute * 60;
  return sign === "+" ? offset : -offset;
}
