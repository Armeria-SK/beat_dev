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

const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const LINE_BREAKS = /[\r\n\t]/gu;

const textProblem = (name: string, value: unknown, max: number, multiline = false): string | null => {
  if (typeof value !== 'string') return `${name} must be text`;
  if (value.trim() === '') return `${name} is empty`;
  if (value.length > max) return `${name} must be up to ${max} characters`;
  if (UNSAFE_TEXT.test(multiline ? value.replace(LINE_BREAKS, ' ') : value)) return `${name} has control or invisible characters`;
  return null;
};
const optionalProblem = (name: string, value: unknown, max: number, multiline = false): string | null => (value === null ? null : textProblem(name, value, max, multiline));

export function proposalProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not an object';
  const p = value as Record<string, unknown>;
  const extra = Object.keys(p).find(key => !(KEYS as readonly string[]).includes(key));
  if (extra !== undefined) return `unknown field "${extra}"`;
  if (p.kind !== 'feature' && p.kind !== 'bug') return 'kind must be feature or bug';
  const why = textProblem('why', p.why, PROPOSAL_LIMITS.why);
  if (why !== null) return why;
  if (!Array.isArray(p.area) || p.area.length > PROPOSAL_LIMITS.areas) return `area must be a list of up to ${PROPOSAL_LIMITS.areas} paths`;
  for (const area of p.area) {
    const problem = textProblem('area', area, PROPOSAL_LIMITS.area);
    if (problem !== null) return problem;
  }
  if (p.size !== 'S' && p.size !== 'M' && p.size !== 'L') return 'size must be S, M or L';
  return optionalProblem('goal', p.goal, PROPOSAL_LIMITS.goal)
    ?? optionalProblem('evidence', p.evidence, PROPOSAL_LIMITS.evidence, true)
    ?? optionalProblem('ledger', p.ledger, PROPOSAL_LIMITS.ledger);
}

export function readProposal(raw: string | null | undefined): Proposal | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (proposalProblem(value) !== null) return null;
  const p = value as Proposal;
  return { kind: p.kind, why: p.why, area: [...p.area], size: p.size, goal: p.goal, evidence: p.evidence, ledger: p.ledger };
}
