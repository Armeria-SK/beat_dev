// 本の [u12] / [n3] の短い呼び名（beat が会話の中で使うのと同じ）。
export const memoryRef = (item: { book: string; id: number }): string => `[${item.book === 'user' ? 'u' : 'n'}${item.id}]`;
