import type { EntityType } from './db/database.types';

// БД использует единственное число (enum entity_type), amoCRM API и фронт — множественное.
const SINGULAR_TO_PLURAL: Record<EntityType, string> = {
  contact: 'contacts',
  company: 'companies',
  lead: 'leads',
};

const PLURAL_TO_SINGULAR: Record<string, EntityType> = {
  contacts: 'contact',
  companies: 'company',
  leads: 'lead',
};

export function toPlural(t: EntityType): string {
  return SINGULAR_TO_PLURAL[t];
}

export function toSingular(plural: string): EntityType | null {
  return PLURAL_TO_SINGULAR[plural] ?? null;
}

export function isCompany(t: EntityType): boolean {
  return t === 'company';
}
