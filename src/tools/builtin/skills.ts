import { Type } from '@sinclair/typebox';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { askBeforeRegister, growSkills, SkillError, type SkillStore } from '../skills/store.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

function store(ctx: ToolContext): SkillStore {
  const skills = ctx.services?.skills;
  if (!skills) throw new SkillError('skill.unavailable');
  return skills;
}
const fail = (error: unknown, ctx: ToolContext): ToolOutput => {
  const language = languageOf(ctx.config);
  return { content: error instanceof SkillError ? error.text(language) : toolText(language, 'failed', { detail: (error as Error).message }), isError: true };
};

export const skillView: ToolDef<{ name: string }> = {
  name: 'skill_view',
  description: 'Read the body of a skill (a procedure). Before doing work that is in the "Skills (procedures)" list in the system prompt, check the procedure with this first.',
  input: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'review', 'agent'],
  async execute(input, ctx) {
    try {
      const s = store(ctx);
      const language = languageOf(ctx.config);
      // 登録した名前だけ読める。フォルダに直接置かれただけの SKILL.md は、中身を返さない
      const skill = s.getRegistered(input.name);
      if (!skill && s.get(input.name)) return { content: toolText(language, 'skill.unregistered', { name: input.name }), isError: true };
      if (!skill) {
        const names = s.listRegistered().map(k => k.name);
        return { content: toolText(language, 'skill.unknown', { name: input.name, detail: names.length ? toolText(language, 'skill.available', { names: names.join(', ') }) : toolText(language, 'skill.none') }), isError: true };
      }
      // 振り返りで読んだだけでは「使った」に数えない
      if (ctx.kind !== 'review') s.recordUse(skill.name);
      return { content: `# ${skill.name}\n${skill.description}\n\n${skill.body}` };
    } catch (error) { return fail(error, ctx); }
  },
};

const DRAFT_HOW = [
  'To fix an existing skill, write its full text under the same name (prefer fixing an existing skill over making a new one).',
  'name uses lowercase English letters, digits and hyphens. description is "when to use it" in one sentence. body is the procedure, concretely. reason is why you are making or fixing it.',
  'When fixing one, change is required: 1-3 short lines, "before → now" (e.g. "3-day forecast only → use a 10-day page").',
];
const DRAFT_ASK = ['Write a reusable procedure as a draft skill (a procedure). It does not take effect until the user approves it.', ...DRAFT_HOW].join(' ');
const DRAFT_AUTO = ["Write a reusable procedure as a skill (a procedure). It is registered right away without the user's review, unless this run or this conversation read outside content or this is a task's run (then it waits for the user's approval), and the user can undo it from the skill's History.", ...DRAFT_HOW].join(' ');

export const skillDraft: ToolDef<{ name: string; description: string; body: string; reason: string; change?: string | null }> = {
  name: 'skill_draft',
  description: DRAFT_ASK,
  describe: config => (askBeforeRegister(config) ? DRAFT_ASK : DRAFT_AUTO),
  input: Type.Object({
    name: Type.String({ minLength: 1, maxLength: 63, pattern: '^[a-z0-9][a-z0-9-]*$' }),
    description: Type.String({ minLength: 1, maxLength: 300 }),
    body: Type.String({ minLength: 1, maxLength: 20_000 }),
    reason: Type.String({ minLength: 1, maxLength: 1000 }),
    change: Type.Optional(Type.Union([Type.String({ maxLength: 400 }), Type.Null()])),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    if (!growSkills(ctx.config) || ctx.services?.skills?.growing === false) return { content: toolText(languageOf(ctx.config), 'skill.growth_off'), isError: true };
    try {
      const s = store(ctx);
      const existing = s.getRegistered(input.name);
      const change = input.change?.trim() ?? '';
      if (existing && !change) return { content: toolText(languageOf(ctx.config), 'skill.change_missing', { name: input.name }), isError: true };
      const autoOk = !ctx.taint?.tainted && !s.sawOutside(ctx.conversationId);
      const draft = s.draft({ name: input.name, description: input.description, body: input.body, reason: input.reason, ...(existing ? { change } : {}), conversationId: ctx.conversationId, runId: ctx.runId, autoOk, fromReview: ctx.kind === 'review' });
      const language = languageOf(ctx.config);
      if (draft.status === 'approved') return { content: toolText(language, existing ? 'skill.registered_auto_edit' : 'skill.registered_auto_new', { name: draft.name, id: draft.id }) };
      return { content: toolText(language, 'skill.drafted', { name: draft.name, kind: toolText(language, existing ? 'skill.kind_edit' : 'skill.kind_new'), id: draft.id }) };
    } catch (error) { return fail(error, ctx); }
  },
};
