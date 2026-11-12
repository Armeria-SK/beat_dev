export const VARIANTS = ['toast'] as const;
export type VariantName = typeof VARIANTS[number];

export function pickVariant(name: VariantName, search: string): 'a' | 'b' {
  return new URLSearchParams(search).get(`v.${name}`) === 'b' ? 'b' : 'a';
}

export const variant = (name: VariantName): 'a' | 'b' => pickVariant(name, location.search);
