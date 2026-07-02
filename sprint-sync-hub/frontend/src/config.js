export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
export const API_KEY  = import.meta.env.VITE_API_KEY || '';

/** Auth header for every backend request. Empty object if no key is configured. */
export function apiHeaders(extra = {}) {
  return API_KEY ? { 'x-api-key': API_KEY, ...extra } : extra;
}
