const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function normalizeDate(value, fieldName) {
  if (value === undefined || value === null || value === "") return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`${fieldName} must be a valid date/time`);
  return date.toISOString();
}

function normalizeWeek(week) {
  if (week === undefined || week === null) return undefined;
  const result = Object.fromEntries(DAYS.map((day) => [day, false]));
  if (Array.isArray(week)) {
    for (const rawDay of week) {
      const day = String(rawDay).toLowerCase();
      if (!DAYS.includes(day)) throw new Error(`Unknown schedule weekday: ${rawDay}`);
      result[day] = true;
    }
    return result;
  }
  if (typeof week === "object") {
    for (const day of DAYS) result[day] = Boolean(week[day]);
    return result;
  }
  throw new Error("schedule.week must be an object or array of weekday names");
}

export function normalizeSchedule(schedule) {
  if (schedule === undefined || schedule === null) return undefined;
  if (typeof schedule !== "object" || Array.isArray(schedule)) {
    throw new Error("schedule must be an object");
  }

  const normalized = {
    startDateTime: normalizeDate(schedule.startDateTime ?? schedule.startsAt ?? schedule.start, "schedule.startDateTime"),
    endDateTime: normalizeDate(schedule.endDateTime ?? schedule.endsAt ?? schedule.end, "schedule.endDateTime"),
    week: normalizeWeek(schedule.week ?? schedule.weekdays)
  };

  if (
    normalized.startDateTime &&
    normalized.endDateTime &&
    new Date(normalized.startDateTime).getTime() >= new Date(normalized.endDateTime).getTime()
  ) {
    throw new Error("schedule.startDateTime must be before schedule.endDateTime");
  }

  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}

export function toBackendSchedule(schedule) {
  if (!schedule) return undefined;
  return {
    ...(schedule.startDateTime ? { startDateTime: new Date(schedule.startDateTime) } : {}),
    ...(schedule.endDateTime ? { endDateTime: new Date(schedule.endDateTime) } : {}),
    ...(schedule.week ? { week: schedule.week } : {})
  };
}
