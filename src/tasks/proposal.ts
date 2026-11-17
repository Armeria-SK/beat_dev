export interface Proposal {
  kind: 'feature' | 'bug';
  why: string;
  area: string[];
  size: 'S' | 'M' | 'L';
  goal: string | null;
  evidence: string | null;
  ledger: string | null;
}

export const PROPOSAL_LIMITS = { why: 400, areas: 10, area: 200, goal: 200, evidence: 2000, ledger: 64 } as const;

const KEYS = ['kind', 'why', 'area', 'size', 'goal', 'evidence', 'ledger'] as const;

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max;
const optional = (value: unknown, max: number): boolean => value === null || text(value, max);

export function proposalProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not an object';
  const p = value as Record<string, unknown>;
  const extra = Object.keys(p).find(key => !(KEYS as readonly string[]).includes(key));
  if (extra !== undefined) return `unknown field "${extra}"`;
  if (p.kind !== 'feature' && p.kind !== 'bug') return 'kind must be feature or bug';
  if (!text(p.why, PROPOSAL_LIMITS.why)) return `why must be 1 to ${PROPOSAL_LIMITS.why} characters`;
  if (!Array.isArray(p.area) || p.area.length > PROPOSAL_LIMITS.areas || !p.area.every(a => text(a, PROPOSAL_LIMITS.area))) {
    return `area must be up to ${PROPOSAL_LIMITS.areas} paths of up to ${PROPOSAL_LIMITS.area} characters`;
  }
  if (p.size !== 'S' && p.size !== 'M' && p.size !== 'L') return 'size must be S, M or L';
  if (!optional(p.goal, PROPOSAL_LIMITS.goal)) return `goal must be null or up to ${PROPOSAL_LIMITS.goal} characters`;
  if (!optional(p.evidence, PROPOSAL_LIMITS.evidence)) return `evidence must be null or up to ${PROPOSAL_LIMITS.evidence} characters`;
  if (!optional(p.ledger, PROPOSAL_LIMITS.ledger)) return `ledger must be null or up to ${PROPOSAL_LIMITS.ledger} characters`;
  return null;
}

export function readProposal(raw: string | null | undefined): Proposal | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (proposalProblem(value) !== null) return null;
  const p = value as Proposal;
  return { kind: p.kind, why: p.why, area: [...p.area], size: p.size, goal: p.goal, evidence: p.evidence, ledger: p.ledger };
}
