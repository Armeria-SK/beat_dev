import type { PersonaWrite } from '../api.ts';
import { resumeStep, setupProviderConfig, STEPS, type ModelForm, type OnboardingSteps } from '../onboarding.ts';
import { accessWidening, keyEntryAccess, type Access } from '../settings/access.ts';
import type { Config } from '../settings/model.ts';
import { routeHash } from './routes.ts';

export const ONBOARD_STEPS = ['name', 'agent', 'style', 'model', 'hello'] as const;
export type OnboardStep = typeof ONBOARD_STEPS[number];

export const STYLES = ['calm', 'friendly', 'direct', 'none'] as const;
export type StyleId = typeof STYLES[number];

export const PROVIDERS = ['anthropic', 'openai', 'custom'] as const;
export type ProviderChoice = typeof PROVIDERS[number];

export const OPENAI_URL = 'https://api.openai.com/v1';

export function nameInput(name: string): PersonaWrite {
  const value = name.trim();
  return value ? { userName: value, callMe: value } : {};
}

export function agentInput(botName: string, current: string): PersonaWrite {
  const value = botName.trim();
  return value && value !== current ? { botName: value } : {};
}

export function styleInput(style: StyleId | null): PersonaWrite {
  return style && style !== 'none' ? { style } : {};
}

export function canContinue(step: OnboardStep, state: { name: string; agent: string; style: StyleId | null; passed: boolean }): boolean {
  switch (step) {
    case 'name': return state.name.trim() !== '';
    case 'agent': return state.agent.trim() !== '';
    case 'style': return state.style !== null;
    case 'model': return state.passed;
    case 'hello': return true;
  }
}

export function escapeAction(state: { busy: boolean; confirming: boolean }): 'ignore' | 'cancelConfirm' | 'close' {
  if (state.busy) return 'ignore';
  return state.confirming ? 'cancelConfirm' : 'close';
}

export interface ConnectForm { provider: ProviderChoice; model: string; baseUrl: string; context: string; key: string }

export const emptyConnect = (provider: ProviderChoice = 'anthropic'): ConnectForm =>
  ({ provider, model: '', baseUrl: provider === 'custom' ? 'http://127.0.0.1:8000/v1' : '', context: provider === 'anthropic' ? '' : '32768', key: '' });

export function connectProblem(form: ConnectForm, keySet: boolean): 'model' | 'baseUrl' | 'context' | 'key' | null {
  if (!form.model.trim()) return 'model';
  if (form.provider === 'custom' && !/^https?:\/\/\S+$/iu.test(form.baseUrl.trim())) return 'baseUrl';
  if (form.provider !== 'anthropic') {
    const n = Number(form.context);
    if (!(Number.isInteger(n) && n >= 1024 && n <= 10_000_000)) return 'context';
  }
  if (form.provider !== 'custom' && !keySet && !form.key.trim()) return 'key';
  return null;
}

export function modelFormOf(form: ConnectForm): ModelForm {
  if (form.provider === 'anthropic') return { source: 'anthropic', model: form.model.trim(), baseUrl: '', server: 'generic', contextLength: '', apiKeyEnv: '' };
  if (form.provider === 'openai') return { source: 'openai', model: form.model.trim(), baseUrl: OPENAI_URL, server: 'openai', contextLength: form.context.trim(), apiKeyEnv: '' };
  return { source: 'openai', model: form.model.trim(), baseUrl: form.baseUrl.trim(), server: 'generic', contextLength: form.context.trim(), apiKeyEnv: '' };
}

export function listPlan(latest: Config, form: ConnectForm): { config: Config; providerId: string; items: Access[] } {
  const built = setupProviderConfig(latest, modelFormOf(form));
  const provider = (built.config.providers as Array<Record<string, any>>).find(p => p.id === built.providerId);
  return { ...built, items: [...accessWidening(latest, built.config), ...(form.key.trim() && provider ? keyEntryAccess(provider) : [])] };
}

export const REACHABLE = new Set(['ok', 'too_small', 'exceeds_model', 'unknown']);

export const resumeIndex = (steps: OnboardingSteps): number => STEPS.indexOf(resumeStep(steps));

export const opensOnLoad = (done: boolean, putOff: boolean): boolean => !done && !putOff;

export const setupPending = (done: boolean | null, open: boolean): boolean => done === false && !open;

export const ONBOARD_DONE_HASH = routeHash({ view: 'newProduct' });
