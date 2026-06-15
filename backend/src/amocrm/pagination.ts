/**
 * Обход страниц amoCRM по _links.next. Готово к этапу массового сканирования (scan_jobs);
 * в ядре не используется.
 */
export interface AmoLink {
  href: string;
}

export interface AmoListResponse<T> {
  _embedded?: Record<string, T[]>;
  _links?: { next?: AmoLink };
}

export async function* paginate<T>(
  fetchPage: (path: string) => Promise<AmoListResponse<T>>,
  firstPath: string,
  collection: string,
): AsyncGenerator<T[]> {
  let path: string | null = firstPath;
  while (path) {
    const page = await fetchPage(path);
    yield page._embedded?.[collection] ?? [];
    const next = page._links?.next?.href ?? null;
    if (!next) {
      path = null;
    } else {
      const u = new URL(next);
      path = u.pathname + u.search;
    }
  }
}
