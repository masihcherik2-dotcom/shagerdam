import { Badge } from '@/components/ui/misc';
import type { VendorProductSummary } from '@/lib/api/types';

/** Storefront state of a vendor product: blocked by staff, published (sellable or out of stock) or draft. */
export function ProductStatusBadge({ product }: { product: Pick<VendorProductSummary, 'moderation' | 'isPublished' | 'isSellable'> }) {
  if (product.moderation.isBlockedByAdmin) return <Badge tone="danger">مسدود</Badge>;
  if (product.isPublished) return product.isSellable ? <Badge tone="success">منتشرشده</Badge> : <Badge tone="warning">منتشر، ناموجود</Badge>;
  return <Badge>پیش‌نویس</Badge>;
}
