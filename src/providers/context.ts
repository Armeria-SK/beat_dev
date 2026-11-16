import { DEFAULT_LANGUAGE, type Language } from '../config/schema.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import { providerText, type ProviderMessageKey } from '../shared/messages/providers.ts';
import type { ProbeResult, ProviderError } from './types.ts';

export interface ContextFacts {
  modelId: string;
  server: string;
  required: number;
  declared?: number | undefined;
  measured?: number | undefined;
  modelMax?: number | undefined;
  maxOutput?: number | undefined;
  trustModelMax?: boolean | undefined;
  hint?: string | undefined;
  unmeasuredNote?: ProviderMessageKey | undefined;
  unknownHint?: ProviderMessageKey | undefined;
  capabilities?: string[] | undefined;
  language?: Language | undefined;
  now?: number;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function probeText(language: Language, key: ProviderMessageKey, params: MessageParams = {}, messageParams: MessageParams = params): Pick<ProbeResult, 'message' | 'messageCode' | 'messageParams'> {
  return { message: providerText(language, key, params), messageCode: `provider.${key}`, messageParams };
}

export const MAX_SERVER_NUMBER = 10_000_000;

export function serverNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SERVER_NUMBER ? value : undefined;
}

export function evaluateContext(facts: ContextFacts): ProbeResult {
  const f = { ...facts, measured: serverNumber(facts.measured), modelMax: serverNumber(facts.modelMax), maxOutput: serverNumber(facts.maxOutput) };
  const language = f.language ?? DEFAULT_LANGUAGE;
  const base = {
    modelId: f.modelId, server: f.server, required: f.required, checkedAt: f.now ?? Date.now(),
    ...(f.declared === undefined ? {} : { declared: f.declared }),
    ...(f.measured === undefined ? {} : { measured: f.measured }),
    ...(f.modelMax === undefined ? {} : { modelMax: f.modelMax }),
    ...(f.maxOutput === undefined ? {} : { maxOutput: f.maxOutput }),
    ...(f.capabilities === undefined ? {} : { capabilities: f.capabilities }),
  };
  if (f.declared !== undefined && f.modelMax !== undefined && f.declared > f.modelMax) {
    return {
      ...base, status: 'exceeds_model', effective: f.modelMax,
      ...probeText(language, 'probe.exceeds_model', { declared: fmt(f.declared), modelMax: fmt(f.modelMax) }),
      hint: providerText(language, 'hint.exceeds_model', { modelMax: fmt(f.modelMax) }),
    };
  }
  const trustMax = f.trustModelMax !== false || f.declared !== undefined || f.measured !== undefined;
  const candidates = [f.declared, f.measured, trustMax ? f.modelMax : undefined].filter((n): n is number => typeof n === 'number' && n > 0);
  if (!candidates.length) {
    return {
      ...base, status: 'unknown',
      ...probeText(language, 'probe.unknown'),
      hint: providerText(language, f.unknownHint ?? 'hint.unknown'),
    };
  }
  const effective = Math.min(...candidates);
  if (effective < f.required) {
    const [sourceKind, sourceValue] = f.measured !== undefined ? ['measured', f.measured] as const : f.declared !== undefined ? ['declared', f.declared] as const : ['limit', effective] as const;
    const source = providerText(language, `probe.source.${sourceKind}`, { n: fmt(sourceValue) });
    return {
      ...base, status: 'too_small', effective,
      ...probeText(language, 'probe.too_small', { effective: fmt(effective), required: fmt(f.required), source }, { effective: fmt(effective), required: fmt(f.required), sourceKind, n: fmt(sourceValue) }),
      ...(f.hint === undefined ? {} : { hint: f.hint }),
    };
  }
  const note = f.measured === undefined && f.unmeasuredNote ? providerText(language, 'probe.note', { note: providerText(language, f.unmeasuredNote) }) : '';
  return { ...base, status: 'ok', effective, ...probeText(language, 'probe.ok', { effective: fmt(effective), note }, { effective: fmt(effective), ...(note && f.unmeasuredNote ? { noteCode: `provider.${f.unmeasuredNote}` } : {}) }) };
}

type HintKind = 'lmstudio' | 'llamacpp' | 'vllm' | 'tabbyapi' | 'generic' | 'hosted';

export function contextHint(language: Language, kind: HintKind, required: number): string {
  return providerText(language, `hint.${kind}`, { required: fmt(required) });
}

export function errorProbeText(error: ProviderError, language: Language): Pick<ProbeResult, 'message' | 'messageCode' | 'messageParams'> {
  return { message: error.text(language), ...(error.code ? { messageCode: `provider.${error.code}`, messageParams: error.params } : {}) };
}
