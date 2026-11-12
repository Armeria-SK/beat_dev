import type { PersonaWrite } from '../api.ts';
import type { ModelForm } from '../onboarding.ts';

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

export const REACHABLE = new Set(['ok', 'too_small', 'exceeds_model', 'unknown']);

export interface OnboardEsc { anytime: boolean; tag: string }
export const ONBOARD_ESC_A: OnboardEsc = { anytime: false, tag: 'a' };
export const ONBOARD_ESC_B: OnboardEsc = { anytime: true, tag: 'onboarding-b-esc-anytime' };

export const canEscape = (rule: OnboardEsc, replay: boolean): boolean => rule.anytime || replay;
