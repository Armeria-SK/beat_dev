export const VARIANTS = ['agent', 'narrow', 'motion', 'idle'] as const;
export type VariantName = typeof VARIANTS[number];

export const B_IDLE_LINE = 'Asleep';

export function pickVariant(name: VariantName, search: string): 'a' | 'b' {
  return new URLSearchParams(search).get(`v.${name}`) === 'b' ? 'b' : 'a';
}

export const variant = (name: VariantName): 'a' | 'b' => pickVariant(name, location.search);
