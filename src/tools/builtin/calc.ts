import { Type } from '@sinclair/typebox';
import type { Language } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';
import { evaluate, formatNumber, type CalcErrorCode } from './calc-core.ts';
import { addToDate, convertZone, diffDates, nowIn, weekdayOf, type DateErrorCode } from './date-core.ts';

const WEEKDAY_KEYS = ['date.weekday.0', 'date.weekday.1', 'date.weekday.2', 'date.weekday.3', 'date.weekday.4', 'date.weekday.5', 'date.weekday.6'] as const;
const weekdayName = (weekday: number, language: Language): string => toolText(language, WEEKDAY_KEYS[weekday]!);

const validZone = (zone: string): boolean => {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
};

const fail = (error: unknown, ctx: ToolContext): ToolOutput => {
  const language = languageOf(ctx.config);
  return { content: error instanceof Error ? toolText(language, 'failed', { detail: error.message }) : toolText(language, 'failed', { detail: String(error) }), isError: true };
};

export const calculate: ToolDef<{ expression: string }> = {
  name: 'calculate',
  description: 'Calculate. + - * /, %, ^ (power), parentheses, sqrt abs round(x,digits) floor ceil min max log ln exp sin cos tan, pi e. Use this instead of calculating in your head.',
  input: Type.Object({
    expression: Type.String({ minLength: 1, maxLength: 500 }),
  }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'agent'],
  async execute(input, ctx) {
    try {
      const language = languageOf(ctx.config);
      const result = evaluate(input.expression);
      if (!result.ok) return { content: toolText(language, `calc.error.${result.code as CalcErrorCode}`, { at: result.at ?? '?' }), isError: true };
      return { content: toolText(language, 'calc.result', { expression: input.expression, value: formatNumber(result.value) }) };
    } catch (error) { return fail(error, ctx); }
  },
};

export const dateCalc: ToolDef<{
  op: 'now' | 'add' | 'diff' | 'weekday' | 'convert';
  date?: string; to?: string; datetime?: string;
  timezone?: string; to_timezone?: string;
  days?: number; weeks?: number; months?: number; years?: number;
}> = {
  name: 'date_calc',
  description: 'Date and time calculation. op: now (the current date and time; if timezone is omitted, the time zone in the settings) / add (add days, weeks, months, years to date; negative values subtract) / diff (the number of days and of weekdays from date to to) / weekday (the day of the week of date) / convert (datetime from timezone to to_timezone). Dates are YYYY-MM-DD, date-times are YYYY-MM-DDTHH:mm.',
  input: Type.Object({
    op: Type.Union([Type.Literal('now'), Type.Literal('add'), Type.Literal('diff'), Type.Literal('weekday'), Type.Literal('convert')]),
    date: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    datetime: Type.Optional(Type.String()),
    timezone: Type.Optional(Type.String()),
    to_timezone: Type.Optional(Type.String()),
    days: Type.Optional(Type.Integer()),
    weeks: Type.Optional(Type.Integer()),
    months: Type.Optional(Type.Integer()),
    years: Type.Optional(Type.Integer()),
  }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'agent'],
  async execute(input, ctx) {
    try {
      const language = languageOf(ctx.config);
      const tz = input.timezone ?? ctx.config.timezone;
      const missing = (field: string): ToolOutput => ({ content: toolText(language, 'date.error.missing', { field }), isError: true });
      const dateError = (code: DateErrorCode, field: string): ToolOutput => ({ content: toolText(language, `date.error.${code}`, { field }), isError: true });
      switch (input.op) {
        case 'now': {
          const result = nowIn(tz, Date.now());
          if (!result.ok) return dateError(result.code, 'timezone');
          const { date, time, weekday, offset } = result.value;
          return { content: toolText(language, 'date.now', { date, time, weekday: weekdayName(weekday, language), timezone: tz, offset }) };
        }
        case 'add': {
          if (!input.date) return missing('date');
          const amount: { days?: number; weeks?: number; months?: number; years?: number } = {};
          if (input.days !== undefined) amount.days = input.days;
          if (input.weeks !== undefined) amount.weeks = input.weeks;
          if (input.months !== undefined) amount.months = input.months;
          if (input.years !== undefined) amount.years = input.years;
          const result = addToDate(input.date, amount);
          if (!result.ok) return dateError(result.code, 'date');
          const wd = weekdayOf(result.value);
          const weekday = wd.ok ? weekdayName(wd.value, language) : '';
          return { content: toolText(language, 'date.add', { date: result.value, weekday }) };
        }
        case 'diff': {
          if (!input.date) return missing('date');
          if (!input.to) return missing('to');
          const result = diffDates(input.date, input.to);
          if (!result.ok) return dateError(result.code, weekdayOf(input.date).ok ? 'to' : 'date');
          return { content: toolText(language, 'date.diff', { from: input.date, to: input.to, days: result.value.days, weekdays: result.value.weekdays }) };
        }
        case 'weekday': {
          if (!input.date) return missing('date');
          const result = weekdayOf(input.date);
          if (!result.ok) return dateError(result.code, 'date');
          return { content: toolText(language, 'date.weekday', { date: input.date, weekday: weekdayName(result.value, language) }) };
        }
        case 'convert': {
          if (!input.datetime) return missing('datetime');
          if (!input.to_timezone) return missing('to_timezone');
          const result = convertZone(input.datetime, tz, input.to_timezone);
          if (!result.ok) {
            const field = result.code === 'bad_timezone' ? (validZone(tz) ? 'to_timezone' : 'timezone') : 'datetime';
            return dateError(result.code, field);
          }
          return { content: toolText(language, 'date.convert', { datetime: result.value.datetime, timezone: input.to_timezone, offset: result.value.offset }) };
        }
      }
    } catch (error) { return fail(error, ctx); }
  },
};
