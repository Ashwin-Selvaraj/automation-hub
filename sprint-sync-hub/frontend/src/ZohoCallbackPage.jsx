import React, { useState, useEffect } from 'react';
import { API_BASE, apiHeaders } from './config.js';

/**
 * ZohoCallbackPage
 *
 * Rendered when the browser is at /zoho/callback after Zoho redirects.
 * Reads ?code= from the URL, sends it to the backend to exchange for a
 * refresh token, and shows the result.
 */
export default function ZohoCallbackPage() {
  const [status, setStatus] = useState('loading'); // loading | success | error
  const [message, setMessage] = useState('');
  const [detail, setDetail]   = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code   = params.get('code');
    const error  = params.get('error');

    if (error) {
      setStatus('error');
      setMessage('Zoho returned an error');
      setDetail(error + (params.get('error_description') ? ': ' + params.get('error_description') : ''));
      return;
    }

    if (!code) {
      setStatus('error');
      setMessage('No authorization code in the URL');
      setDetail('Expected ?code=... in the redirect URL. Try the authorization URL again.');
      return;
    }

    // Exchange the code for a refresh token
    fetch(`${API_BASE}/api/zoho/oauth/exchange`, {
      method:  'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body:    JSON.stringify({ code }),
    })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok || !body.success) {
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        return body;
      })
      .then((body) => {
        setStatus('success');
        setMessage(body.message || 'Token saved successfully');
        setDetail(`Scopes granted: ${body.scopesGranted}`);
      })
      .catch((err) => {
        setStatus('error');
        setMessage('Token exchange failed');
        setDetail(err.message);
      });
  }, []);

  const styles = {
    page: {
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#F9FAFB',
      fontFamily: 'Inter, system-ui, sans-serif',
    },
    card: {
      background: '#fff',
      border: '1px solid #E5E7EB',
      borderRadius: 12,
      boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
      padding: 40,
      maxWidth: 480,
      width: '90%',
      textAlign: 'center',
    },
    icon: { fontSize: 48, marginBottom: 16 },
    title: { fontSize: 20, fontWeight: 700, color: '#111827', marginBottom: 8 },
    msg:   { fontSize: 14, color: '#374151', marginBottom: 12, lineHeight: 1.6 },
    detail: { fontSize: 12, color: '#6B7280', background: '#F3F4F6', padding: '8px 12px', borderRadius: 6, marginBottom: 24, wordBreak: 'break-all', textAlign: 'left' },
    btn:   {
      display: 'inline-block',
      padding: '10px 24px',
      background: '#2563EB',
      color: '#fff',
      borderRadius: 8,
      fontWeight: 600,
      fontSize: 14,
      textDecoration: 'none',
      cursor: 'pointer',
      border: 'none',
    },
    spinner: { fontSize: 32, animation: 'spin 1s linear infinite', display: 'inline-block', marginBottom: 16 },
  };

  return (
    <div style={styles.page}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <div style={styles.card}>
        {status === 'loading' && (
          <>
            <div style={styles.spinner}>⏳</div>
            <div style={styles.title}>Exchanging token with Zoho…</div>
            <div style={styles.msg}>Please wait a moment.</div>
          </>
        )}

        {status === 'success' && (
          <>
            <div style={styles.icon}>✅</div>
            <div style={styles.title}>Zoho connected successfully!</div>
            <div style={styles.msg}>{message}</div>
            {detail && <div style={styles.detail}>{detail}</div>}
            <div style={{ ...styles.msg, background: '#FFF7ED', border: '1px solid #FDE68A', borderRadius: 8, padding: '12px 16px', marginBottom: 24 }}>
              ⚠️ <strong>Restart the backend server</strong> to apply the new token, then attendance will show real check-in data.
            </div>
            <a href="/" style={styles.btn}>Back to Dashboard →</a>
          </>
        )}

        {status === 'error' && (
          <>
            <div style={styles.icon}>❌</div>
            <div style={styles.title}>Something went wrong</div>
            <div style={styles.msg}>{message}</div>
            {detail && <div style={styles.detail}>{detail}</div>}
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button style={styles.btn} onClick={() => window.location.href = '/'}>
                Back to Dashboard
              </button>
              <button
                style={{ ...styles.btn, background: '#6B7280' }}
                onClick={async () => {
                  const r = await fetch(`${API_BASE}/api/zoho/oauth/url`, { headers: apiHeaders() });
                  const { authUrl } = await r.json();
                  window.location.href = authUrl;
                }}
              >
                Try Again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
