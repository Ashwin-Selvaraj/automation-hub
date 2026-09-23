import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CheckoutCard from './CheckoutCard.jsx';

const api = vi.hoisted(() => ({
  getEmployeeSession: vi.fn(),
  startSlackSignIn: vi.fn(),
  getEmployeeZohoStatus: vi.fn(),
  startEmployeeZohoConnect: vi.fn(),
  disconnectEmployeeZoho: vi.fn(),
  validateEmployeeCheckout: vi.fn(),
}));

vi.mock('../api.js', () => api);

describe('CheckoutCard', () => {
  beforeEach(() => {
    api.getEmployeeSession.mockResolvedValue({
      employee: { name: 'Ashwin', email: 'ashwin@example.com' },
      csrfToken: 'csrf',
    });
    api.getEmployeeZohoStatus.mockResolvedValue({
      connected: true,
      status: 'connected',
      email: 'ashwin@example.com',
    });
    api.validateEmployeeCheckout.mockReset();
    api.startEmployeeZohoConnect.mockReset();
    window.history.replaceState({}, '', '/');
  });

  it('keeps checkout disabled until the employee connects Zoho', async () => {
    api.getEmployeeZohoStatus.mockResolvedValue({ connected: false, status: 'not_connected' });
    render(<CheckoutCard />);

    expect(await screen.findByText('Zoho People not connected.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Zoho People' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Check & Checkout' })).toBeDisabled();
  });

  it('shows the configured destination only after the employee update is found', async () => {
    api.validateEmployeeCheckout.mockResolvedValue({
      code: 'UPDATE_FOUND',
      message: "Your daily update has been found. You're ready to check out.",
      checkoutUrl: 'https://people.zoho.in/acme/attendance',
    });
    render(<CheckoutCard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Check & Checkout' }));
    expect(await screen.findByText("Your daily update has been found. You're ready to check out.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Proceed to Zoho Checkout' })).toBeEnabled();
  });

  it('shows Slack and Check Again actions when the update is missing', async () => {
    api.validateEmployeeCheckout.mockResolvedValue({
      code: 'UPDATE_MISSING',
      message: "Your daily update hasn't been found yet. Please post your update in the team channel before proceeding.",
      slackChannelUrl: 'https://slack.com/app_redirect?channel=C123',
    });
    render(<CheckoutCard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Check & Checkout' }));
    expect(await screen.findByText(/hasn't been found yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Slack Channel' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Check Again' })).toBeEnabled();
  });

  it('distinguishes a Slack failure and retries successfully', async () => {
    const failure = Object.assign(new Error('Slack could not be checked right now. Please retry.'), {
      code: 'SLACK_ERROR',
      retryable: true,
    });
    api.validateEmployeeCheckout
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        code: 'UPDATE_FOUND',
        message: "Your daily update has been found. You're ready to check out.",
        checkoutUrl: 'https://people.zoho.in/acme/attendance',
      });
    render(<CheckoutCard />);

    fireEvent.click(await screen.findByRole('button', { name: 'Check & Checkout' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Slack could not be checked');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/ready to check out/)).toBeInTheDocument();
    expect(api.validateEmployeeCheckout).toHaveBeenCalledTimes(2);
  });

  it('suppresses duplicate validation clicks while a request is loading', async () => {
    let resolveRequest;
    api.validateEmployeeCheckout.mockImplementation(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    render(<CheckoutCard />);

    const button = await screen.findByRole('button', { name: 'Check & Checkout' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.validateEmployeeCheckout).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();

    resolveRequest({
      code: 'UPDATE_MISSING',
      message: "Your daily update hasn't been found yet. Please post your update in the team channel before proceeding.",
      slackChannelUrl: 'https://slack.com',
    });
    await waitFor(() => expect(screen.getByText(/hasn't been found yet/)).toBeInTheDocument());
  });
});
