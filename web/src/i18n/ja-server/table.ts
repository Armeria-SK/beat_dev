export type JaTable<C extends { readonly tables: { readonly en: Record<string, string> } }> = Partial<Record<keyof C['tables']['en'], string>>;
