'use client';

import { CreditCard } from 'lucide-react';
import { useState } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { InitiatePaymentResponse } from '@/lib/api/types';

/** Opens a new bank session for a still-PENDING order (POST /payments/initiate) and redirects to it. */
export function RetryPaymentButton({ parentOrderId, label = 'پرداخت مجدد' }: { parentOrderId: string; label?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function retry() {
    setBusy(true);
    try {
      const payment = await apiPost<InitiatePaymentResponse>('/payments/initiate', { parentOrderId });
      window.location.assign(payment.redirectUrl);
    } catch (caught) {
      toast.error(toApiError(caught).message);
      setBusy(false);
    }
  }
  return (
    <Button size="lg" variant="success" loading={busy} onClick={() => void retry()} icon={<CreditCard className="size-5" />}>
      {label}
    </Button>
  );
}
