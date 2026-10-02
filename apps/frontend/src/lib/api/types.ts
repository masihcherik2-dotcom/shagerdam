/**
 * Response/request shapes of the Shagerdam API (`/api/v1`), mirrored from the
 * backend DTO classes (apps/backend/src/modules/<module>/dto). Money fields
 * are Rial decimal strings ("35000000.00"); dates are ISO strings.
 */

/* ─── Enums ─────────────────────────────────────────────────────────────── */

export const USER_ROLES = ['SUPER_ADMIN', 'ADMIN', 'VENDOR', 'CUSTOMER', 'FINANCIAL_OFFICER', 'SUPPORT'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const STAFF_ROLES: readonly UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'FINANCIAL_OFFICER', 'SUPPORT'];

export type VendorStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export type PaymentMethod = 'CASH_IPG' | 'BANK_CREDIT' | 'HYBRID';
export type ParentOrderPaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED';
export const SUB_ORDER_STATUSES = ['PENDING_APPROVAL', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'] as const;
export type SubOrderStatus = (typeof SUB_ORDER_STATUSES)[number];
export type PaymentStatus = 'INITIATED' | 'SUCCESSFUL' | 'FAILED' | 'REFUNDED';
export type PaymentPurpose = 'ORDER_CHECKOUT' | 'INSTALLMENT_REPAYMENT';
export type PaymentOutcome = 'PAID' | 'FAILED' | 'VERIFICATION_PENDING' | 'PAID_REQUIRES_REFUND';
export type WalletTransactionType =
  | 'CREDIT_SALE_ESCROW_HOLD'
  | 'ESCROW_RELEASE_TO_WITHDRAWABLE'
  | 'COMMISSION_DEDUCTION'
  | 'SETTLEMENT_PAYOUT'
  | 'REFUND_DEDUCTION'
  | 'SETTLEMENT_HOLD'
  | 'SETTLEMENT_HOLD_RELEASE'
  | 'DISPUTE_HOLD_LOCK'
  | 'DISPUTE_HOLD_RELEASE';
export const WALLET_BUCKETS = ['PENDING', 'WITHDRAWABLE', 'SETTLEMENT_HOLD', 'DISPUTE_HOLD'] as const;
export type WalletBalanceBucket = (typeof WALLET_BUCKETS)[number];
export const SETTLEMENT_STATUSES = ['REQUESTED', 'PROCESSING', 'PAID_PAYA', 'REJECTED'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];
export type CreditAccountStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED';
export type CreditApplicationStatus = 'DRAFT' | 'PENDING_BANK_INQUIRY' | 'DOCS_REQUIRED' | 'APPROVED' | 'REJECTED';
export type InstallmentStatus = 'PENDING' | 'PAID' | 'OVERDUE' | 'WAIVED';
export const DISPUTE_REASONS = ['WRONG_ITEM', 'DAMAGED', 'NOT_AS_DESCRIBED', 'NOT_DELIVERED', 'COUNTERFEIT'] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];
export const DISPUTE_STATUSES = ['OPEN', 'VENDOR_RESPONDED', 'UNDER_ARBITRATION', 'RESOLVED_BUYER_FAVOR', 'RESOLVED_VENDOR_FAVOR', 'CANCELLED'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export type DisputeVendorAction = 'ACCEPT_RETURN' | 'REJECT_WITH_DEFENSE';
export type DisputeEventType =
  | 'OPENED'
  | 'EVIDENCE_ADDED'
  | 'VENDOR_ACCEPTED_RETURN'
  | 'VENDOR_DEFENDED'
  | 'ARBITRATED_BUYER_FAVOR'
  | 'ARBITRATED_VENDOR_FAVOR'
  | 'CANCELLED_BY_CUSTOMER'
  | 'REFUND_NOTICE_SENT'
  | 'REFUND_NOTICE_FAILED';
export type ArbitrationDecision = 'BUYER_FAVOR' | 'VENDOR_FAVOR';
export const PRODUCT_SORTS = ['newest', 'price_asc', 'price_desc', 'popular'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];
export type VendorProductStatus = 'published' | 'draft' | 'blocked';

/* ─── Shared ────────────────────────────────────────────────────────────── */

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ImageRef {
  url: string;
  thumbnailUrl: string | null;
}

export interface PriceRange {
  min: string;
  max: string;
}

/* ─── Auth ──────────────────────────────────────────────────────────────── */

export interface AuthUser {
  id: string;
  mobile: string;
  role: UserRole;
  fullName: string;
  email: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  sessionId: string;
  user: AuthUser;
}

export interface OtpRequestResponse {
  status: 'sent';
  expiresInSeconds: number;
  trackingId: string;
}

export interface CustomerProfile {
  birthDate: string | null;
  gender: string | null;
  bankIban: string | null;
  defaultAddressId: string | null;
}

export interface MeVendorSummary {
  id: string;
  storeName: string;
  storeSlug: string;
  status: VendorStatus;
  logoUrl: string | null;
}

export interface Me {
  user: AuthUser;
  customerProfile: CustomerProfile | null;
  vendor: MeVendorSummary | null;
}

export interface UpdateProfileInput {
  fullName?: string;
  email?: string;
  nationalCode?: string;
  birthDate?: string;
}

/* ─── Categories ────────────────────────────────────────────────────────── */

export interface CategorySummary {
  id: string;
  slug: string;
  titleFa: string;
  titleEn: string | null;
}

export interface CategoryTreeNode extends CategorySummary {
  parentId: string | null;
  defaultCommissionRate: string;
  sortOrder: number;
  depth: number;
  productCount: number;
  totalProductCount: number;
  children: CategoryTreeNode[];
}

export interface CategoryTree {
  items: CategoryTreeNode[];
  totalCategories: number;
  totalProducts: number;
}

export interface Subcategory extends CategorySummary {
  sortOrder: number;
  totalProductCount: number;
  childCount: number;
}

export interface CategoryDetail extends CategorySummary {
  parentId: string | null;
  defaultCommissionRate: string;
  depth: number;
  productCount: number;
  totalProductCount: number;
  breadcrumbs: CategorySummary[];
  children: Subcategory[];
}

/* ─── Catalog ───────────────────────────────────────────────────────────── */

export interface ColorOption {
  name: string;
  hex: string | null;
}

export interface PublicVendorSummary {
  storeName: string;
  storeSlug: string;
  logoUrl: string | null;
}

export interface PublicVendorDetail extends PublicVendorSummary {
  bio: string | null;
  instagramHandle: string | null;
  verifiedAt: string | null;
}

export interface ProductListItem {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  primaryImage: ImageRef | null;
  priceRange: PriceRange;
  maxDiscountPercent: number | null;
  startingCompareAtPrice: string | null;
  colors: ColorOption[];
  sizes: string[];
  inStock: boolean;
  vendor: PublicVendorSummary;
  category: CategorySummary;
  createdAt: string;
}

export interface PublicVariant {
  id: string;
  sku: string;
  colorName: string | null;
  colorHex: string | null;
  size: string | null;
  guarantee: string | null;
  price: string;
  compareAtPrice: string | null;
  discountPercent: number | null;
  availableQuantity: number;
  inStock: boolean;
  weightGrams: number | null;
}

/** One row of a product's technical specification table, in display order. */
export interface ProductSpecification {
  groupTitle: string | null;
  title: string;
  value: string;
}

export interface ProductDetail {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  brand: string | null;
  breadcrumbs: CategorySummary[];
  vendor: PublicVendorDetail;
  media: ImageRef[];
  variants: PublicVariant[];
  priceRange: PriceRange;
  maxDiscountPercent: number | null;
  colors: ColorOption[];
  sizes: string[];
  inStock: boolean;
  specifications: ProductSpecification[];
  createdAt: string;
  updatedAt: string;
}

export interface ProductQuery {
  search?: string;
  categorySlug?: string;
  vendorSlug?: string;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  /** Only products with a discounted variant (compareAtPrice > price). */
  onSaleOnly?: boolean;
  colors?: string[];
  sizes?: string[];
  sortBy?: ProductSort;
  page?: number;
  pageSize?: number;
}

/* ─── Vendor products ───────────────────────────────────────────────────── */

export interface StockSummary {
  variantCount: number;
  activeVariantCount: number;
  totalStock: number;
  totalReserved: number;
  totalAvailable: number;
}

export interface ProductModeration {
  isBlockedByAdmin: boolean;
  blockedReason: string | null;
  blockedAt: string | null;
}

export interface VendorVariant {
  id: string;
  sku: string;
  colorName: string | null;
  colorHex: string | null;
  size: string | null;
  guarantee: string | null;
  price: string;
  compareAtPrice: string | null;
  discountPercent: number | null;
  stockQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  weightGrams: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VendorProductSummary {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  basePrice: string;
  isPublished: boolean;
  isSellable: boolean;
  moderation: ProductModeration;
  category: CategorySummary;
  primaryImage: ImageRef | null;
  priceRange: PriceRange | null;
  stock: StockSummary;
  createdAt: string;
  updatedAt: string;
}

export interface ProductMedia extends ImageRef {
  id: string;
  mediaAssetId: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

export interface VendorProductDetail extends VendorProductSummary {
  description: string | null;
  media: ProductMedia[];
  variants: VendorVariant[];
  specifications: ProductSpecification[];
}

export interface CreateVariantInput {
  sku: string;
  colorName?: string | null;
  colorHex?: string | null;
  size?: string | null;
  guarantee?: string | null;
  price: number;
  compareAtPrice?: number | null;
  stockQuantity: number;
  weightGrams?: number | null;
  isActive?: boolean;
}

export interface UpdateVariantInput {
  price?: number;
  compareAtPrice?: number | null;
  /** Absolute stock; mutually exclusive with stockDelta. */
  stockQuantity?: number;
  stockDelta?: number;
  isActive?: boolean;
}

export interface CreateProductInput {
  title: string;
  slug?: string;
  description?: string | null;
  categoryId: string;
  brand?: string | null;
  basePrice: number;
  mediaIds?: string[];
  /** Full list in display order; on update it replaces the stored table. */
  specifications?: ProductSpecification[];
  variants: CreateVariantInput[];
  isPublished?: boolean;
}

export type UpdateProductInput = Partial<Omit<CreateProductInput, 'variants'>>;

/* ─── Product importer ──────────────────────────────────────────────────── */

export type ImportSource = 'DIGIKALA' | 'GENERIC';
export type ImportStrategy = 'DIGIKALA_API' | 'JSON_LD' | 'MICRODATA' | 'WOOCOMMERCE_ATTRIBUTES' | 'OPEN_GRAPH' | 'HTML_META';

/** POST /vendor/products/import/extract-spec — a draft only; nothing is stored. */
export interface ImportedProductDraft {
  source: ImportSource;
  strategies: ImportStrategy[];
  sourceUrl: string;
  sourceProductId: string | null;
  title: string;
  titleEn: string | null;
  brand: string | null;
  description: string | null;
  suggestedCategory: string | null;
  /** Local category whose name matches the source's category or breadcrumb. */
  suggestedCategoryId: string | null;
  specifications: Array<{ group: string | null; title: string; value: string }>;
  imageUrls: string[];
}

export interface IngestedImage {
  sourceUrl: string;
  id: string;
  url: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface FailedImage {
  sourceUrl: string;
  code: string;
  message: string;
}

/** POST /vendor/products/import/ingest-images */
export interface IngestImagesResponse {
  items: IngestedImage[];
  failures: FailedImage[];
}

export interface ArchiveProductResponse {
  id: string;
  slug: string;
  isPublished: boolean;
  wasPublished: boolean;
  auditLogId: string | null;
}

export interface AdminProduct extends VendorProductSummary {
  vendor: { id: string; storeName: string; storeSlug: string; status: VendorStatus };
  blockedByUserId: string | null;
}

/* ─── Media ─────────────────────────────────────────────────────────────── */

export interface ImageUploadResponse {
  id: string;
  url: string;
  thumbnailUrl: string;
  mimeType: 'image/webp';
  sizeBytes: number;
  width: number;
  height: number;
}

export interface DocumentUploadResponse {
  id: string;
  url: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  isPublic: false;
}

export type ImagePurpose = 'avatar' | 'store_logo' | 'store_banner' | 'product_image';
export type DocumentPurpose = 'kyc_national_id' | 'kyc_business_license' | 'kyc_bank_proof' | 'dispute_evidence' | 'other';

/* ─── Cart ──────────────────────────────────────────────────────────────── */

export interface CartIssue {
  code: string;
  message: string;
}

export interface CartLine {
  id: string;
  productVariantId: string;
  sku: string;
  productId: string;
  productSlug: string;
  productTitle: string;
  colorName: string | null;
  colorHex: string | null;
  size: string | null;
  guarantee: string | null;
  image: ImageRef | null;
  quantity: number;
  unitPrice: string;
  priceWhenAdded: string;
  compareAtPrice: string | null;
  lineTotal: string;
  availableQuantity: number;
  isPurchasable: boolean;
  issues: CartIssue[];
  addedAt: string;
}

export interface CartShipping {
  fee: string;
  isFree: boolean;
  freeThreshold: string;
  remainingForFreeShipping: string | null;
}

export interface CartVendorGroup {
  vendor: { storeName: string; storeSlug: string };
  lines: CartLine[];
  itemsSubtotal: string;
  shipping: CartShipping;
  packageTotal: string;
}

export interface Cart {
  cartToken: string | null;
  owner: 'user' | 'guest' | 'none';
  groups: CartVendorGroup[];
  itemCount: number;
  lineCount: number;
  itemsSubtotal: string;
  shippingTotal: string;
  payableAmount: string;
  hasPriceChanges: boolean;
  canCheckout: boolean;
}

/* ─── Addresses ─────────────────────────────────────────────────────────── */

export interface Address {
  id: string;
  province: string;
  city: string;
  postalAddress: string;
  postalCode: string;
  buildingNumber: string | null;
  unitNumber: string | null;
  recipientName: string;
  recipientMobile: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AddressList {
  items: Address[];
  total: number;
  limit: number;
}

export interface AddressInput {
  province: string;
  city: string;
  postalAddress: string;
  postalCode: string;
  buildingNumber?: string | null;
  unitNumber?: string | null;
  recipientName: string;
  recipientMobile: string;
  isDefault?: boolean;
}

/* ─── Orders ────────────────────────────────────────────────────────────── */

export interface AddressSnapshot {
  province: string;
  city: string;
  postalAddress: string;
  postalCode: string;
  buildingNumber: string | null;
  unitNumber: string | null;
  recipientName: string;
  recipientMobile: string;
}

export interface OrderItem {
  id: string;
  productVariantId: string | null;
  productTitle: string;
  sku: string;
  vendorStoreName: string;
  variantDetails: { colorName: string | null; colorHex: string | null; size: string | null; guarantee: string | null };
  unitPrice: string;
  quantity: number;
  discount: string;
  lineTotal: string;
}

export interface VendorOrderItem extends OrderItem {
  commissionRate: string;
  commissionAmount: string;
}

export interface StoreRef {
  id: string;
  storeName: string;
  storeSlug: string;
}

export interface TimelineEvent {
  at: string;
  type: 'ORDER_PLACED' | 'PAYMENT_CONFIRMED' | 'ORDER_CANCELLED' | 'PAYMENT_FAILED' | 'SUB_ORDER_STATUS';
  subOrderNumber: string | null;
  fromStatus: SubOrderStatus | null;
  toStatus: SubOrderStatus | null;
  actor: string;
  note: string | null;
}

export interface CustomerSubOrder {
  id: string;
  subOrderNumber: string;
  store: StoreRef;
  status: SubOrderStatus;
  itemsSubtotal: string;
  shippingFee: string;
  total: string;
  trackingCode: string | null;
  carrierName: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  items: OrderItem[];
}

export interface OrderMoney {
  id: string;
  orderNumber: string;
  paymentStatus: ParentOrderPaymentStatus;
  paymentMethod: PaymentMethod;
  totalItemsAmount: string;
  totalShippingFee: string;
  totalDiscountAmount: string;
  finalPayableAmount: string;
  paymentExpiresAt: string | null;
  createdAt: string;
}

export interface CustomerSubOrderSummary {
  id: string;
  subOrderNumber: string;
  storeName: string;
  status: SubOrderStatus;
  itemsSubtotal: string;
  shippingFee: string;
  itemCount: number;
  trackingCode: string | null;
}

export interface CustomerOrderSummary extends OrderMoney {
  subOrders: CustomerSubOrderSummary[];
}

export interface CustomerOrderDetail extends OrderMoney {
  shippingAddress: AddressSnapshot;
  customerNote: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  canCancel: boolean;
  subOrders: CustomerSubOrder[];
  timeline: TimelineEvent[];
}

export interface CheckoutResponse {
  parentOrderId: string;
  orderNumber: string;
  paymentStatus: ParentOrderPaymentStatus;
  paymentMethod: PaymentMethod;
  totalItemsAmount: string;
  totalShippingFee: string;
  totalDiscountAmount: string;
  finalPayableAmount: string;
  paymentExpiresAt: string | null;
  subOrders: CustomerSubOrder[];
}

export interface StatusHistoryEntry {
  fromStatus: SubOrderStatus | null;
  toStatus: SubOrderStatus;
  actorRole: string;
  note: string | null;
  at: string;
}

export interface VendorSubOrderSummary {
  id: string;
  subOrderNumber: string;
  orderNumber: string;
  status: SubOrderStatus;
  itemsSubtotal: string;
  shippingFee: string;
  platformCommissionAmount: string;
  vendorEarningsAmount: string;
  itemCount: number;
  trackingCode: string | null;
  carrierName: string | null;
  placedAt: string;
  paidAt: string | null;
  allowedTransitions: SubOrderStatus[];
}

export interface VendorSubOrderDetail extends Omit<VendorSubOrderSummary, 'itemCount'> {
  itemCount: number;
  shippingAddress: AddressSnapshot;
  customerNote: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  items: VendorOrderItem[];
  history: StatusHistoryEntry[];
}

export type WalletAction = 'ESCROW_RELEASED' | 'ESCROW_REVERSED' | 'EARNINGS_REVERSED' | 'DISPUTE_HOLD_REFUNDED' | 'DISPUTE_HOLD_RELEASED' | 'NONE';

export interface VendorSubOrderTransition {
  previousStatus: SubOrderStatus;
  stockAction: 'RESTOCKED' | 'NONE';
  walletAction: WalletAction;
  auditLogId: string;
  subOrder: VendorSubOrderDetail;
}

export interface CustomerDeliveryConfirmation {
  previousStatus: SubOrderStatus;
  stockAction: 'RESTOCKED' | 'NONE';
  walletAction: WalletAction;
  auditLogId: string;
  order: CustomerOrderDetail;
}

/* ─── Payments & credit ─────────────────────────────────────────────────── */

export interface InitiatePaymentResponse {
  paymentId: string;
  redirectUrl: string;
  gatewayName: 'SANDBOX' | 'ZARINPAL';
  amount: string;
  currency: string;
  orderNumber: string;
  paymentExpiresAt: string | null;
}

export interface InstallmentPlanRef {
  id: string;
  title: string;
  durationMonths: number;
  interestRatePercent: string;
}

export interface CreditPaymentInitiateResponse {
  status: 'COMPLETED' | 'IPG_REQUIRED';
  paymentId: string;
  parentOrderId: string;
  orderNumber: string;
  paymentMethod: 'BANK_CREDIT' | 'HYBRID';
  creditAmount: string;
  cashAmount: string;
  currency: string;
  plan: InstallmentPlanRef;
  orderPaymentStatus: ParentOrderPaymentStatus;
  redirectUrl: string | null;
  gatewayName: string | null;
  paymentExpiresAt: string | null;
  schedule: {
    installments: number;
    creditAmount: string;
    totalInterest: string;
    totalPayable: string;
    firstDueDate: string;
    lastDueDate: string;
  } | null;
}

export interface CreditProviderSummary {
  code: string;
  name: string;
  isSandbox: boolean;
}

export interface CreditAccount {
  id: string;
  provider: CreditProviderSummary;
  status: CreditAccountStatus;
  totalLimit: string;
  usedAmount: string;
  reservedAmount: string;
  availableAmount: string;
  currency: string;
  expiresAt: string | null;
  createdAt: string;
  outstanding: { count: number; overdueCount: number; principal: string; interest: string; nextDueDate: string | null };
}

export interface CreditApplication {
  id: string;
  status: CreditApplicationStatus;
  provider: CreditProviderSummary;
  requestedLimit: string;
  approvedLimit: string | null;
  trackingCode: string | null;
  score: number | null;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  account: CreditAccount | null;
}

export interface InstallmentPlan {
  id: string;
  title: string;
  durationMonths: number;
  interestRatePercent: string;
  penaltyRatePercentPerMonth: string;
  installmentIntervalDays: number;
}

export interface CreditPlans {
  creditEnabled: boolean;
  provider: CreditProviderSummary | null;
  items: InstallmentPlan[];
}

export interface Installment {
  id: string;
  installmentNumber: number;
  totalInstallments: number;
  dueDate: string;
  principalAmount: string;
  interestAmount: string;
  penaltyAmount: string;
  totalAmount: string;
  paidAmount: string;
  amountDue: string;
  status: InstallmentStatus;
  paidAt: string | null;
}

export interface OrderInstallments {
  parentOrderId: string;
  orderNumber: string;
  paymentMethod: PaymentMethod;
  paidAt: string | null;
  plan: InstallmentPlanRef | null;
  creditAmount: string;
  totalInterest: string;
  totalPayable: string;
  paidAmount: string;
  remainingAmount: string;
  paidCount: number;
  overdueCount: number;
  installments: Installment[];
}

export interface InstallmentsOverview {
  orders: OrderInstallments[];
  totalRemaining: string;
  overdueCount: number;
}

export interface InstallmentPaymentResponse {
  paymentId: string;
  installmentId: string;
  installmentNumber: number;
  totalInstallments: number;
  orderNumber: string;
  redirectUrl: string;
  gatewayName: string;
  amount: string;
  currency: string;
}

/* ─── Disputes ──────────────────────────────────────────────────────────── */

export interface DisputeEvidence {
  id: string;
  uploadedBy: 'CUSTOMER' | 'VENDOR' | 'STAFF';
  fileUrl: string;
  fileType: string | null;
  caption: string | null;
  createdAt: string;
}

export interface DisputeEvent {
  type: DisputeEventType;
  actorRole: string;
  fromStatus: DisputeStatus | null;
  toStatus: DisputeStatus | null;
  note: string | null;
  createdAt: string;
}

export interface Dispute {
  id: string;
  status: DisputeStatus;
  reason: DisputeReason;
  description: string;
  package: {
    subOrderId: string;
    subOrderNumber: string;
    orderNumber: string;
    status: SubOrderStatus;
    vendorId: string;
    storeName: string;
    itemsSubtotal: string;
    shippingFee: string;
  };
  subOrderStatusAtOpen: SubOrderStatus;
  vendorResponse: { action: DisputeVendorAction; defenseNotes: string; respondedAt: string } | null;
  resolution: {
    outcome: DisputeStatus;
    notes: string | null;
    resolvedAt: string;
    decidedBy: 'VENDOR' | 'STAFF';
    refundAmount: string | null;
    itemReturned: boolean | null;
    restocked: boolean;
  } | null;
  cancelledAt: string | null;
  evidence: DisputeEvidence[];
  timeline: DisputeEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface DisputeHold {
  source: WalletBalanceBucket | null;
  amount: string;
  shortfall: string;
  unrecovered: string;
}

export interface VendorDispute extends Dispute {
  customerName: string;
  customerMobileMasked: string;
  hold: DisputeHold;
}

export interface DisputeParty {
  userId: string;
  name: string;
  mobile: string;
}

export interface AdminDisputeSummary extends Dispute {
  customer: DisputeParty;
  hold: DisputeHold;
}

export interface AdminDisputeDossier extends AdminDisputeSummary {
  order: {
    id: string;
    orderNumber: string;
    paymentStatus: ParentOrderPaymentStatus;
    paymentMethod: PaymentMethod;
    finalPayableAmount: string;
    createdAt: string;
  };
  items: Array<{ productTitle: string; sku: string; quantity: number; unitPrice: string; totalLineAmount: string }>;
  packageHistory: Array<{ fromStatus: SubOrderStatus | null; toStatus: SubOrderStatus; actorRole: string; note: string | null; createdAt: string }>;
  payments: Array<{
    id: string;
    gatewayName: string;
    paymentMethod: PaymentMethod;
    status: string;
    cashAmount: string;
    creditAmount: string;
    bankRrn: string | null;
    paidAt: string | null;
  }>;
  vendorWallet: {
    pendingBalance: string;
    withdrawableBalance: string;
    settlementHoldBalance: string;
    disputeHoldBalance: string;
    totalEarnedBalance: string;
    totalWithdrawnAmount: string;
  };
  vendorEarningsAmount: string;
}

export interface DisputeActionResult {
  dispute: Dispute;
  walletAction: 'FROZEN' | 'REFUNDED' | 'RELEASED_TO_WITHDRAWABLE' | 'RETURNED_TO_ESCROW' | 'NONE';
  subOrderStatus: SubOrderStatus;
  stockAction: 'RESTOCKED' | 'NONE';
}

/* ─── Vendors ───────────────────────────────────────────────────────────── */

export interface VendorWalletSummary {
  pendingBalance: string;
  withdrawableBalance: string;
  totalEarnedBalance: string;
  updatedAt: string;
}

export interface VendorVerification {
  id: string;
  nationalIdCardUrl: string;
  businessLicenseUrl: string | null;
  bankAccountProofUrl: string | null;
  rejectionReason: string | null;
  reviewedByUserId: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface MediaAssetSummary {
  id: string;
  kind: 'IMAGE' | 'DOCUMENT';
  purpose: string;
  url: string;
  thumbnailUrl: string | null;
  isPublic: boolean;
  createdAt: string;
}

/** POST /admin/vendors — store opened by staff (APPROVED immediately). */
export interface AdminCreateVendorInput {
  storeName: string;
  storeSlug: string;
  ownerMobile: string;
  ownerFullName: string;
  bankIban: string;
  bankAccountHolder?: string;
  commissionRateOverride?: number | null;
  instagramHandle?: string;
  bio?: string;
}

export interface AdminCreateVendorResult {
  profile: VendorProfile;
  /** A new customer account was created for the owner mobile (otherwise an existing account was promoted). */
  ownerCreated: boolean;
  auditLogId: string;
}

export interface VendorProfile {
  id: string;
  userId: string;
  storeName: string;
  storeSlug: string;
  instagramHandle: string | null;
  logoUrl: string | null;
  bio: string | null;
  bankIban: string;
  bankAccountHolder: string | null;
  commissionRateOverride: string | null;
  status: VendorStatus;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  wallet: VendorWalletSummary | null;
  verification: VendorVerification | null;
  mediaAssets: MediaAssetSummary[];
}

export interface RegisterVendorInput {
  storeName: string;
  storeSlug: string;
  instagramHandle?: string;
  bio?: string;
  bankIban: string;
  bankAccountHolder: string;
}

export interface VendorOwner {
  id: string;
  mobile: string;
  email: string | null;
  fullName: string;
  role: UserRole;
  isActive: boolean;
}

export interface VendorAdminSummary {
  id: string;
  storeName: string;
  storeSlug: string;
  instagramHandle: string | null;
  logoUrl: string | null;
  status: VendorStatus;
  verifiedAt: string | null;
  productCount: number;
  wallet: VendorWalletSummary | null;
  owner: VendorOwner;
  createdAt: string;
}

export interface VendorAuditEntry {
  id: string;
  action: string;
  entityName: string;
  entityId: string | null;
  actorId: string | null;
  actorName: string | null;
  ipAddress: string | null;
  oldValue: unknown;
  newValue: unknown;
  createdAt: string;
}

export interface VendorAdminDetail extends VendorAdminSummary {
  bio: string | null;
  bankIban: string;
  bankAccountHolder: string | null;
  commissionRateOverride: string | null;
  verifications: VendorVerification[];
  mediaAssets: MediaAssetSummary[];
  auditTrail: VendorAuditEntry[];
}

/* ─── Wallet & settlements ──────────────────────────────────────────────── */

export interface WalletSummary {
  pendingBalance: string;
  withdrawableBalance: string;
  settlementHoldBalance: string;
  disputeHoldBalance: string;
  totalEarnedBalance: string;
  totalWithdrawnAmount: string;
  currency: string;
}

export interface WalletTransaction {
  id: string;
  type: WalletTransactionType;
  bucket: WalletBalanceBucket;
  amount: string;
  balanceAfter: string;
  subOrderId: string | null;
  subOrderNumber: string | null;
  settlementRequestId: string | null;
  description: string | null;
  createdAt: string;
}

export interface SettlementRequest {
  id: string;
  vendorId: string;
  storeName: string;
  amount: string;
  targetIban: string;
  status: SettlementStatus;
  bankPayaReference: string | null;
  rejectionReason: string | null;
  processedAt: string | null;
  processedBy: { id: string; fullName: string | null } | null;
  createdAt: string;
}

/* ─── Admin financial ───────────────────────────────────────────────────── */

export interface FinancialOverview {
  currency: string;
  from: string | null;
  to: string | null;
  generatedAt: string;
  sales: {
    paidOrders: number;
    activePackages: number;
    gmv: string;
    shippingFees: string;
    collectedByGateway: string;
    fundedByCredit: string;
    installmentsCollected: string;
  };
  commission: { earned: string; pending: string; total: string };
  wallets: {
    escrowHeld: string;
    withdrawable: string;
    settlementHold: string;
    disputeHold: string;
    totalWithdrawn: string;
    ledgerConsistent: boolean;
    inconsistentWallets: number;
  };
  settlements: { pendingCount: number; pendingAmount: string; paidCount: number; paidAmount: string };
  paymentsRequiringManualRefund: number;
  disputes: {
    open: number;
    underArbitration: number;
    resolvedForBuyer: number;
    refundsOwedToCustomers: string;
    unrecoveredVendorEarnings: string;
  };
}

// ─── Integrations: Torob ─────────────────────────────────────────────────────

export interface TorobFeedItem {
  page_unique: string;
  title: string;
  price: number;
  old_price: number | null;
  availability: 'instock' | 'outofstock';
  page_url: string;
  image_links: string[];
  category_name: string | null;
  spec: Record<string, string>;
  guarantee: string | null;
  delivery_fee: number;
}

export interface TorobFeedPage {
  count: number;
  page: number;
  totalPages: number;
  products: TorobFeedItem[];
}

/* ─── Trust layer: business identity, public status, contact form ───────── */

export interface SiteInfo {
  legalName: string | null;
  nationalId: string | null;
  registrationNumber: string | null;
  supportPhone: string | null;
  supportEmail: string | null;
  officeAddress: string | null;
  postalCode: string | null;
  workingHours: string | null;
  enamadLinkUrl: string | null;
  enamadImageUrl: string | null;
  samandehiLinkUrl: string | null;
  samandehiImageUrl: string | null;
  /** Google Search Console verification token (content of the google-site-verification meta tag). */
  googleVerificationTag: string | null;
}

export type SiteInfoField = keyof SiteInfo;

export interface AdminSiteInfo extends SiteInfo {
  updatedAt: Record<SiteInfoField, string | null>;
  history: Array<{ id: string; createdAt: string; actor: { id: string; fullName: string } | null; changedFields: string[] }>;
  auditLogId?: string;
}

export type ComponentState = 'operational' | 'degraded' | 'outage';
export type PublicStatusModule = 'storefront' | 'orders' | 'payments' | 'bnpl' | 'auth';

export interface PublicStatusReport {
  status: ComponentState;
  checkedAt: string;
  modules: Array<{ key: PublicStatusModule; status: ComponentState }>;
}

export type ContactMessageTopic = 'ORDER' | 'PAYMENT' | 'BNPL' | 'RETURN' | 'VENDOR' | 'TECHNICAL' | 'OTHER';
export type ContactMessageStatus = 'NEW' | 'IN_PROGRESS' | 'RESOLVED';

export interface ContactMessageInput {
  fullName: string;
  mobile: string;
  email?: string;
  topic: ContactMessageTopic;
  subject: string;
  message: string;
  website?: string;
}

export interface ContactMessageReceipt {
  id: string;
  reference: string;
  createdAt: string;
}

export interface AdminContactMessage {
  id: string;
  reference: string;
  fullName: string;
  mobile: string;
  email: string | null;
  topic: ContactMessageTopic;
  subject: string;
  message: string;
  status: ContactMessageStatus;
  staffNote: string | null;
  sender: { id: string; fullName: string } | null;
  handledBy: { id: string; fullName: string } | null;
  handledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminContactMessagePage extends Page<AdminContactMessage> {
  counts: Record<ContactMessageStatus, number>;
}

// ── Whole-store import (crawl-store + bulk-extract background jobs) ──────────

export type BulkPriceUnit = 'AUTO' | 'IRR' | 'IRT';
export type BulkJobStatus = 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'INTERRUPTED';
export type BulkItemStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'SKIPPED' | 'NEEDS_REVIEW' | 'FAILED';
export type BulkItemNote = 'NO_IMAGE' | 'SOME_IMAGES_FAILED' | 'OUT_OF_STOCK';

export interface CrawlStoreResponse {
  storeUrl: string;
  totalFound: number;
  productUrls: string[];
  sitemapsScanned: string[];
  warnings: string[];
}

export interface BulkOptions {
  autoPublish: boolean;
  priceUnit: BulkPriceUnit;
  defaultStock: number;
  defaultCategoryId: string | null;
}

export interface BulkExtractResponse {
  jobId: string;
  totalProducts: number;
}

export interface BulkItem {
  index: number;
  url: string;
  status: BulkItemStatus;
  attempts: number;
  code: string | null;
  message: string | null;
  notes: BulkItemNote[];
  title: string | null;
  imageUrl: string | null;
  /** Selling price in IRR. */
  price: number | null;
  product: { id: string; slug: string; isPublished: boolean } | null;
  updatedAt: string;
}

export interface BulkJobCounts {
  pending: number;
  processing: number;
  succeeded: number;
  skipped: number;
  needsReview: number;
  failed: number;
}

export interface BulkJob {
  id: string;
  vendorId: string;
  staff: boolean;
  storeUrl: string | null;
  options: BulkOptions;
  status: BulkJobStatus;
  total: number;
  runs: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  counts: BulkJobCounts;
  processed: number;
  progressPercent: number;
  items: BulkItem[];
}

/** GET …/products/publish-drafts — what a bulk publish of drafts would do. */
export interface DraftPublishSummary {
  publishable: number;
  blocked: number;
  noActiveVariant: number;
  storeNotApproved: number;
}

/** POST …/products/publish-drafts */
export interface PublishDraftsResult {
  published: number;
  remaining: DraftPublishSummary;
}
