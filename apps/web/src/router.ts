/**
 * Routing.
 *
 * Small on purpose: four views and a couple of parameters do not justify a
 * dependency, and the whole thing is one file that could be swapped for a router
 * library later without touching a single page.
 *
 * Paths are real URLs (`/canvas/<projectId>`), not hashes, so a canvas can be
 * linked to and reloaded — the server already falls back to the SPA entry for
 * unknown paths.
 */
import { useEffect, useState } from 'react'

/** One matched route. */
export type Route =
  | { name: 'home' }
  | { name: 'projects' }
  | { name: 'assets' }
  | { name: 'workflows' }
  | { name: 'canvas'; projectId: string }
  | { name: 'notFound'; path: string }

/** Route table, matched in order. `:name` captures one path segment. */
const ROUTES: { pattern: string; name: Route['name'] }[] = [
  { pattern: '/', name: 'home' },
  { pattern: '/projects', name: 'projects' },
  { pattern: '/assets', name: 'assets' },
  { pattern: '/workflows', name: 'workflows' },
  { pattern: '/canvas/:projectId', name: 'canvas' },
]

/** Split a path into segments, ignoring empty ones. */
function segments(path: string): string[] {
  return path.split('/').filter((part) => part !== '')
}

/**
 * Match a path against the table.
 * @param path - pathname to match.
 * @returns the route, or a notFound marker.
 */
export function matchRoute(path: string): Route {
  const parts = segments(path)
  for (const entry of ROUTES) {
    const pattern = segments(entry.pattern)
    if (pattern.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < pattern.length; i += 1) {
      const token = pattern[i] as string
      const value = parts[i] as string
      if (token.startsWith(':')) params[token.slice(1)] = decodeURIComponent(value)
      else if (token !== value) { ok = false; break }
    }
    if (!ok) continue
    if (entry.name === 'canvas') return { name: 'canvas', projectId: params.projectId ?? '' }
    return { name: entry.name } as Route
  }
  return { name: 'notFound', path }
}

/**
 * Navigate to a path (optionally with a query string).
 *
 * `pushState` never fires a navigation event by itself, so the change is
 * announced explicitly — the router listens for both that and the browser's own
 * back/forward. The comparison uses path *and* query, so `/projects?ws=a` and
 * `/projects?ws=b` are two different destinations.
 * @param path - target path, query string included.
 */
export function navigate(path: string): void {
  if (window.location.pathname + window.location.search === path) return
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** Read the current route and re-render when it changes. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => matchRoute(window.location.pathname))
  useEffect(() => {
    const update = (): void => { setRoute(matchRoute(window.location.pathname)) }
    window.addEventListener('popstate', update)
    return () => { window.removeEventListener('popstate', update) }
  }, [])
  return route
}

/**
 * Read the current query string and re-render when it changes.
 *
 * The route table matches paths only; page-level scoping ("which workspace am I
 * looking at") rides on the query so that a filtered view is still a linkable
 * URL rather than hidden component state.
 * @returns the current search params.
 */
export function useSearch(): URLSearchParams {
  const [search, setSearch] = useState(() => window.location.search)
  useEffect(() => {
    const update = (): void => { setSearch(window.location.search) }
    window.addEventListener('popstate', update)
    return () => { window.removeEventListener('popstate', update) }
  }, [])
  return new URLSearchParams(search)
}
