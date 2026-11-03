import { Temporal } from "temporal-polyfill";
import { validDeadline } from "../deadline.js";
import { AgentValidationError } from "./errors";

// Do not interpret a timezone-free timestamp using the Runner/Worker host zone.
export function normalizeAgentDeadline(value: string): string {
  try {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(
        value,
      )
    )
      throw Error();
    const instant = Temporal.Instant.from(value);
    const result = new Date(instant.epochMilliseconds).toISOString();
    if (!validDeadline(result)) throw Error();
    return result;
  } catch {
    throw new AgentValidationError(
      "VALIDATION_ERROR",
      "截止时间必须是有效且带时区的日期时间。",
    );
  }
}

export type RelativeDeadline = {
  daysFromNow: number;
  time: string;
  timeZone?: string;
};

// Relative language is resolved to structured calendar fields by the caller.
// An explicit reference instant makes retries deterministic. Never guess a DST
// gap or fold: require the caller to provide a different time or absolute instant.
export function resolveRelativeDeadline(
  input: RelativeDeadline,
  now: string,
): string {
  try {
    if (
      !input ||
      !Number.isSafeInteger(input.daysFromNow) ||
      Math.abs(input.daysFromNow) > 36600 ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)
    )
      throw Error();
    const timeZone = input.timeZone ?? "Asia/Shanghai";
    const reference = Temporal.Instant.from(
      normalizeAgentDeadline(now),
    ).toZonedDateTimeISO(timeZone);
    const local = reference
      .toPlainDate()
      .add({ days: input.daysFromNow })
      .toPlainDateTime(input.time);
    const instant = local
      .toZonedDateTime(timeZone, { disambiguation: "reject" })
      .toInstant();
    return normalizeAgentDeadline(instant.toString());
  } catch {
    throw new AgentValidationError(
      "VALIDATION_ERROR",
      "相对日期、时区或当地时间无效，请指定明确时间。",
    );
  }
}
