export function latestOnly(): { begin: () => number; isCurrent: (ticket: number) => boolean } {
  let last = 0;
  return { begin: () => ++last, isCurrent: ticket => ticket === last };
}
