export function isWebClientLocation(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  // Why: tests and non-DOM callers stub a partial window; an absent location must
  // read as "not the web client" instead of throwing.
  const location = (window as unknown as { location?: { pathname?: string } }).location
  return (
    Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__) ||
    Boolean(location?.pathname?.endsWith('/web-index.html'))
  )
}
