export interface PaginatedResult<T> {
  items: T[];
  pagination: {
    cursor: string | null;
    hasNext: boolean;
    limit: number;
  };
}

export function paginate<T extends { id?: string; createdAt?: string }>(
  items: T[],
  limit: number,
  cursor?: string | null,
): PaginatedResult<T> {
  let startIndex = 0;
  if (cursor) {
    const idx = items.findIndex((i) => i.id === cursor || i.createdAt === cursor);
    startIndex = idx >= 0 ? idx + 1 : 0;
  }
  const slice = items.slice(startIndex, startIndex + limit);
  const hasNext = startIndex + limit < items.length;
  const nextCursor = hasNext && slice.length > 0 ? (slice[slice.length - 1].id ?? slice[slice.length - 1].createdAt ?? null) : null;
  return {
    items: slice,
    pagination: { cursor: nextCursor, hasNext, limit },
  };
}