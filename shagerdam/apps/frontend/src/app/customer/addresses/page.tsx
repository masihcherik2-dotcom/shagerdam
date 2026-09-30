'use client';

import { MapPin, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { AddressFormModal } from '@/components/customer/address-form';
import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Badge, PageHeader } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import { apiDelete, apiPatch } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { Address, AddressList } from '@/lib/api/types';
import { useApi } from '@/lib/hooks/use-api';
import { formatMobile, toPersianDigits } from '@/lib/format';

export default function CustomerAddressesPage() {
  const toast = useToast();
  const state = useApi<AddressList>('/customer/addresses');
  const [editing, setEditing] = useState<Address | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Address | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function makeDefault(address: Address) {
    setBusyId(address.id);
    try {
      await apiPatch(`/customer/addresses/${address.id}`, { isDefault: true });
      await state.reload();
      toast.success('نشانی پیش‌فرض تغییر کرد.');
    } catch (caught) {
      toast.error(toApiError(caught).message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      await apiDelete(`/customer/addresses/${deleting.id}`);
      setDeleting(null);
      await state.reload();
      toast.success('نشانی حذف شد.');
    } catch (caught) {
      toast.error(toApiError(caught).message);
    } finally {
      setBusyId(null);
    }
  }

  const atLimit = state.data ? state.data.total >= state.data.limit : false;

  return (
    <>
      <PageHeader
        title="نشانی‌های من"
        description={state.data ? `${toPersianDigits(state.data.total)} از ${toPersianDigits(state.data.limit)} نشانی مجاز` : undefined}
        action={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing(null)} disabled={atLimit || state.loading}>
            افزودن نشانی
          </Button>
        }
      />
      <AsyncView
        state={state}
        skeleton={<SkeletonRows rows={3} className="h-32" />}
        isEmpty={(data) => data.items.length === 0}
        empty={<EmptyState icon={<MapPin className="size-8" />} title="هنوز نشانی ثبت نکرده‌اید" description="برای ثبت سفارش دست‌کم یک نشانی لازم است." action={<Button onClick={() => setEditing(null)}>افزودن نشانی</Button>} />}
      >
        {(data) => (
          <ul className="grid gap-4 md:grid-cols-2">
            {data.items.map((address) => (
              <li key={address.id} className={`flex flex-col gap-3 rounded-2xl border bg-white p-5 ${address.isDefault ? 'border-brand-300 ring-1 ring-brand-200' : 'border-slate-200'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 font-bold">
                    <MapPin className="size-4 text-brand-600" />
                    {address.province}، {address.city}
                  </div>
                  {address.isDefault ? <Badge tone="brand">پیش‌فرض</Badge> : null}
                </div>
                <p className="text-sm leading-7 text-slate-700">
                  {address.postalAddress}
                  {address.buildingNumber ? `، پلاک ${toPersianDigits(address.buildingNumber)}` : ''}
                  {address.unitNumber ? `، واحد ${toPersianDigits(address.unitNumber)}` : ''}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                  <span>کد پستی: {toPersianDigits(address.postalCode)}</span>
                  <span>گیرنده: {address.recipientName}</span>
                  <span dir="ltr">{formatMobile(address.recipientMobile)}</span>
                </div>
                <div className="mt-auto flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                  <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(address)}>
                    ویرایش
                  </Button>
                  {!address.isDefault ? (
                    <Button size="sm" variant="ghost" icon={<Star className="size-4" />} loading={busyId === address.id} onClick={() => void makeDefault(address)}>
                      پیش‌فرض کن
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" className="text-rose-600" icon={<Trash2 className="size-4" />} onClick={() => setDeleting(address)}>
                    حذف
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </AsyncView>

      <AddressFormModal
        open={editing !== undefined}
        address={editing ?? undefined}
        onClose={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          void state.reload();
        }}
      />
      <Modal
        open={deleting !== null}
        title="حذف نشانی"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="danger" loading={busyId === deleting?.id} onClick={() => void remove()}>
              حذف شود
            </Button>
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              انصراف
            </Button>
          </>
        }
      >
        <p className="text-sm leading-7">
          نشانی «{deleting?.city}، {deleting?.postalAddress}» حذف شود؟ سفارش‌های قبلی تغییری نمی‌کنند، چون نشانی در زمان سفارش ذخیره شده است.
        </p>
      </Modal>
    </>
  );
}
