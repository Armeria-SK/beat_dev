import type { NewTask, Project } from '../api.ts';
import { ALL_PRODUCTS, matchesFilter, NO_PRODUCT, productOf, type ProductFilter, type ProductOption } from './products.ts';

export const inFilter = <R extends { project_id?: string | null }>(rows: readonly R[], filter: ProductFilter): R[] => rows.filter(row => matchesFilter(row.project_id, filter));

export function settleFilter(filter: ProductFilter, projects: readonly Project[]): ProductFilter {
  if (filter === ALL_PRODUCTS || filter === NO_PRODUCT) return filter;
  return projects.some(p => p.id === filter && p.archived_at === null) ? filter : ALL_PRODUCTS;
}

export const productName = (projects: readonly Project[], id: string | null | undefined): string | null => productOf(projects, id)?.name ?? null;

export const optionLabel = (option: ProductOption, all: string, none: string): string =>
  (option.key === ALL_PRODUCTS ? all : option.key === NO_PRODUCT ? none : `${option.name ?? option.key}${option.waiting > 0 ? ` · ${option.waiting}` : ''}`);

export const newTaskProduct = (filter: ProductFilter): string | null => (filter === ALL_PRODUCTS || filter === NO_PRODUCT ? null : filter);

export const withProduct = (task: NewTask, projectId: string | null): NewTask => (projectId ? { ...task, projectId } : task);

export interface ProductLine { name: string | null; archived: boolean }

export function productLine(id: string | null | undefined, active: readonly Project[], archived: readonly Project[]): ProductLine | null {
  if (!id) return null;
  const live = active.find(p => p.id === id && p.archived_at === null);
  if (live) return { name: live.name, archived: false };
  return { name: productName(archived, id), archived: true };
}
