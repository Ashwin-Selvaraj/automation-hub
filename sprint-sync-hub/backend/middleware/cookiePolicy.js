'use strict';

/**
 * How the employee session cookies are issued, and whether that can work for
 * the way this deployment is split across hosts.
 *
 * The dashboard and the API are usually separate hosts (a Vercel frontend and a
 * Railway API, say). A cookie is only sent on a fetch the page makes to another
 * *site* if it is SameSite=None — and a SameSite=Lax cookie set by a response to
 * that fetch is dropped on arrival. With the Lax cookies this app used to
 * always issue, sign-in on a split-site deployment failed twice over: the
 * login-state cookie never stuck ("Missing OAuth callback data"), and even a
 * session cookie set by the top-level redirect back from Slack was never sent on
 * the dashboard's later requests, so /me answered 401 forever.
 *
 * "Site" is the registrable domain (scheme aside, ports ignored): app.example.com
 * and api.example.com are the same site, while a.vercel.app and b.railway.app, or
 * localhost and 127.0.0.1, are not.
 */

// Domains where every subdomain belongs to a different customer, so
// "a.vercel.app" and "b.vercel.app" are different sites. This is a deliberately
// short list of the hosts this app is deployed to, not the full Public Suffix
// List — anything else resolves as the last two labels, and the setting can be
// overridden explicitly with EMPLOYEE_COOKIE_SAMESITE.
const SHARED_SUFFIXES = [
  'vercel.app', 'railway.app', 'up.railway.app', 'netlify.app', 'herokuapp.com', 'onrender.com',
  'fly.dev', 'pages.dev', 'workers.dev', 'github.io', 'azurewebsites.net', 'web.app',
  'firebaseapp.com', 'appspot.com', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com',
  // Two-label country suffixes
  'co.uk', 'org.uk', 'co.in', 'org.in', 'net.in', 'com.au', 'co.nz', 'co.za', 'com.br', 'co.jp',
];

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[.*\]$/;

/** The "site" of a hostname: its registrable domain, or the host itself for IPs and localhost. */
function siteOf(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || IP_RE.test(host) || !host.includes('.')) return host;

  const suffix = SHARED_SUFFIXES
    .filter((s) => host === s || host.endsWith(`.${s}`))
    .sort((a, b) => b.length - a.length)[0];
  const labels = host.split('.');
  if (suffix) {
    const extra = suffix.split('.').length;
    return labels.slice(-(extra + 1)).join('.');
  }
  return labels.slice(-2).join('.');
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

/** Whether two URLs are on the same site. Null when either cannot be read. */
function sameSite(urlA, urlB) {
  const a = hostOf(urlA);
  const b = hostOf(urlB);
  if (!a || !b) return null;
  return siteOf(a) === siteOf(b);
}

/**
 * Decides SameSite and Secure for the employee cookies.
 *
 * EMPLOYEE_COOKIE_SAMESITE=lax|none forces a value. Left unset it follows the
 * deployment: Lax when FRONTEND_URL and the API (taken from
 * SLACK_OIDC_REDIRECT_URI) share a site, None when they do not, and Lax when
 * either is unset, which is the local-development case.
 *
 * `warnings` is for the operator, printed once at boot.
 */
function resolveCookiePolicy(env = process.env) {
  const warnings = [];
  const production = env.NODE_ENV === 'production';
  const frontend = env.FRONTEND_URL;
  const api = env.SLACK_OIDC_REDIRECT_URI;
  const crossSite = sameSite(frontend, api) === false;

  const requested = String(env.EMPLOYEE_COOKIE_SAMESITE || '').trim().toLowerCase();
  if (requested && !['lax', 'none'].includes(requested)) {
    // A typo here would silently leave sign-in broken, so refuse to start.
    throw new Error(`EMPLOYEE_COOKIE_SAMESITE must be "lax" or "none", got "${env.EMPLOYEE_COOKIE_SAMESITE}"`);
  }

  let sameSiteValue;
  let reason;
  if (requested) {
    sameSiteValue = requested === 'none' ? 'None' : 'Lax';
    reason = 'set by EMPLOYEE_COOKIE_SAMESITE';
    if (sameSiteValue === 'Lax' && crossSite) {
      warnings.push(
        `FRONTEND_URL (${frontend}) and the API (${api}) are on different sites, so Lax cookies will not be sent ` +
        'and employee sign-in will fail. Put both under one domain, or set EMPLOYEE_COOKIE_SAMESITE=none.'
      );
    }
  } else if (crossSite) {
    sameSiteValue = 'None';
    reason = 'the dashboard and the API are on different sites';
  } else {
    sameSiteValue = 'Lax';
    reason = 'the dashboard and the API share a site (or this is local development)';
  }

  if (sameSiteValue === 'None') {
    warnings.push(
      'SameSite=None cookies are blocked as third-party cookies by Safari and by Firefox\'s strict mode, and ' +
      'by Chrome when a user has switched that on. Serving the dashboard and the API from one domain ' +
      '(app.example.com and api.example.com) is the reliable fix.'
    );
  }

  // SameSite=None is rejected by browsers without Secure, whatever the environment.
  const secure = production || sameSiteValue === 'None';
  if (sameSiteValue === 'None' && !production && !/^https:|^http:\/\/(localhost|127\.0\.0\.1)/.test(String(api || ''))) {
    warnings.push('SameSite=None needs HTTPS to work in browsers; the API URL is plain http.');
  }

  return { sameSite: sameSiteValue, secure, reason, crossSite, warnings };
}

module.exports = { resolveCookiePolicy, sameSite, siteOf };
