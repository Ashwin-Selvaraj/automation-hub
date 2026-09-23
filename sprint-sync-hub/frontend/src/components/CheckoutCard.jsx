import React, { useCallback, useEffect, useState } from 'react';
import Card, { SectionHeader } from './Card.jsx';
import Button from './Button.jsx';
import Badge from './Badge.jsx';
import Spinner from './Spinner.jsx';
import { theme } from '../theme.js';
import {
  getEmployeeSession,
  startSlackSignIn,
  getEmployeeZohoStatus,
  startEmployeeZohoConnect,
  disconnectEmployeeZoho,
  validateEmployeeCheckout,
} from '../api.js';

const { colors } = theme;

export default function CheckoutCard() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [session, setSession] = useState(null);
  const [csrfToken, setCsrfToken] = useState('');
  const [zoho, setZoho] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const auth = await getEmployeeSession();
      setSession(auth.employee);
      setCsrfToken(auth.csrfToken);
      const status = await getEmployeeZohoStatus();
      setZoho(status);
    } catch (err) {
      if (err.status === 401) {
        setSession(null);
        setZoho(null);
      } else {
        setError({ message: err.message, retryable: err.retryable !== false });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const zohoResult = params.get('zoho_connection');
    if (params.has('zoho_connection') || params.has('employee_auth')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    load().then(() => {
      if (zohoResult === 'identity_mismatch') {
        setError({ message: 'The Zoho email did not match your verified Slack email.', retryable: true });
      } else if (zohoResult === 'failed') {
        setError({ message: 'Zoho connection failed. Please try again.', retryable: true });
      }
    });
  }, [load]);

  async function redirectAction(kind, action) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      const { authUrl } = await action();
      window.location.assign(authUrl);
    } catch (err) {
      setError({ message: err.message, retryable: true });
      setBusy(null);
    }
  }

  async function checkUpdate() {
    if (busy || !zoho?.connected) return;
    setBusy('validate');
    setError(null);
    try {
      setResult(await validateEmployeeCheckout(csrfToken));
    } catch (err) {
      setResult(null);
      setError({ message: err.message, retryable: err.retryable !== false, action: 'validate' });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (busy) return;
    setBusy('disconnect');
    setError(null);
    try {
      await disconnectEmployeeZoho(csrfToken);
      setZoho({ connected: false, status: 'not_connected' });
      setResult(null);
    } catch (err) {
      setError({ message: err.message, retryable: true });
    } finally {
      setBusy(null);
    }
  }

  const noticeStyle = {
    padding: '12px 14px',
    borderRadius: 6,
    fontSize: 13,
    lineHeight: 1.5,
    marginTop: 14,
  };

  return (
    <Card>
      <SectionHeader>Checkout reminder</SectionHeader>
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: colors.gray600, fontSize: 13 }}>
          <Spinner size={18} /> Loading your connection…
        </div>
      ) : !session ? (
        <div>
          <div style={{ fontSize: 14, color: colors.gray900, marginBottom: 6 }}>Sign in to identify your Slack update.</div>
          <div style={{ fontSize: 12, color: colors.gray600, marginBottom: 14 }}>
            Your Slack member ID is used to check only your own post.
          </div>
          <Button
            disabled={Boolean(busy)}
            onClick={() => redirectAction('slack', startSlackSignIn)}
          >
            {busy === 'slack' ? 'Opening Slack…' : 'Sign in with Slack'}
          </Button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div>
              <div style={{ fontSize: 14, color: colors.gray900, fontWeight: 600 }}>{session.name}</div>
              <div style={{ fontSize: 12, color: colors.gray600, marginTop: 2 }}>
                {zoho?.connected ? 'Zoho People connected.' : 'Zoho People not connected.'}
              </div>
            </div>
            <Badge variant={zoho?.connected ? 'success' : zoho?.status === 'revoked' ? 'error' : 'warning'}>
              {zoho?.connected ? 'Connected' : zoho?.status === 'revoked' ? 'Reconnect required' : 'Not connected'}
            </Badge>
          </div>

          {!zoho?.connected && (
            <div style={{ marginTop: 14 }}>
              <Button
                disabled={Boolean(busy)}
                onClick={() => redirectAction('zoho', () => startEmployeeZohoConnect(csrfToken))}
              >
                {busy === 'zoho' ? 'Opening Zoho…' : zoho?.status === 'revoked' ? 'Reconnect Zoho People' : 'Connect Zoho People'}
              </Button>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <Button disabled={!zoho?.connected || Boolean(busy)} onClick={checkUpdate}>
              {busy === 'validate' ? 'Checking…' : 'Check & Checkout'}
            </Button>
            {zoho?.connected && (
              <Button variant="secondary" size="sm" disabled={Boolean(busy)} onClick={disconnect}>
                Disconnect Zoho
              </Button>
            )}
          </div>

          {result?.code === 'UPDATE_FOUND' && (
            <div role="status" style={{ ...noticeStyle, background: colors.green50, color: colors.green600 }}>
              <div>{result.message}</div>
              <Button
                style={{ marginTop: 10 }}
                onClick={() => window.open(result.checkoutUrl, '_blank', 'noopener,noreferrer')}
              >
                Proceed to Zoho Checkout
              </Button>
            </div>
          )}

          {result?.code === 'UPDATE_MISSING' && (
            <div role="status" style={{ ...noticeStyle, background: colors.amber50, color: colors.amber600 }}>
              <div>{result.message}</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <Button variant="secondary" onClick={() => window.open(result.slackChannelUrl, '_blank', 'noopener,noreferrer')}>
                  Open Slack Channel
                </Button>
                <Button disabled={Boolean(busy)} onClick={checkUpdate}>Check Again</Button>
              </div>
            </div>
          )}

          {error && (
            <div role="alert" style={{ ...noticeStyle, background: colors.red50, color: colors.red600 }}>
              <div>{error.message}</div>
              {error.retryable && (
                <Button
                  variant="secondary"
                  size="sm"
                  style={{ marginTop: 8 }}
                  onClick={error.action === 'validate' ? checkUpdate : load}
                >
                  Retry
                </Button>
              )}
            </div>
          )}

          <div style={{ fontSize: 11, color: colors.gray400, marginTop: 14, lineHeight: 1.45 }}>
            This reminder validates today’s Slack update and opens Zoho People. It does not record attendance or prevent checkout directly in Zoho.
          </div>
        </>
      )}
    </Card>
  );
}
