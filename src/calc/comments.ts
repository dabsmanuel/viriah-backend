export interface CommentEntry {
  author: string;
  minAverage: number;
  maxAverage: number;
  text: string;
}

/**
 * Suggested comments (Document 3, section 8.6). Take the entries for that author whose band contains the average.
 * With several, choose by the student's position in the class list modulo the number of entries, so neighbours
 * do not all get the same sentence. The choice is repeatable. Staff can edit before saving.
 */
export function suggestComment(entries: CommentEntry[], author: string, average: number | null, indexInClass: number): string | null {
  if (average === null) return null;
  const matching = entries.filter((e) => e.author === author && average >= e.minAverage && average <= e.maxAverage);
  if (!matching.length) return null;
  return matching[((indexInClass % matching.length) + matching.length) % matching.length].text;
}
