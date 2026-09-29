import type { WalletAction } from '../order-lifecycle.service';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ParentOrderPaymentStatus, PaymentMethod, SubOrderStatus } from '@prisma/client';

const MONEY = { type: String, example: '1250000.00', description: 'IRR (Rial, `platform.currency`), 2 decimals, as a string.' } as const;

export class AddressSnapshotDto {
  @ApiProperty({ example: 'تهران' }) province!: string;
  @ApiProperty({ example: 'تهران' }) city!: string;
  @ApiProperty({ example: 'خیابان ولیعصر، کوچه نگار' }) postalAddress!: string;
  @ApiProperty({ example: '1969833111' }) postalCode!: string;
  @ApiProperty({ nullable: true, type: String }) buildingNumber!: string | null;
  @ApiProperty({ nullable: true, type: String }) unitNumber!: string | null;
  @ApiProperty({ example: 'مریم احمدی' }) recipientName!: string;
  @ApiProperty({ example: '+989121234567' }) recipientMobile!: string;
}

export class VariantDetailsDto {
  @ApiProperty({ nullable: true, type: String }) colorName!: string | null;
  @ApiProperty({ nullable: true, type: String }) colorHex!: string | null;
  @ApiProperty({ nullable: true, type: String }) size!: string | null;
  @ApiProperty({ nullable: true, type: String }) guarantee!: string | null;
}

/** An order line exactly as it was bought (snapshot; later catalogue edits do not change it). */
export class OrderItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Null if the variant was later deleted.' })
  productVariantId!: string | null;
  @ApiProperty() productTitle!: string;
  @ApiProperty() sku!: string;
  @ApiProperty() vendorStoreName!: string;
  @ApiProperty({ type: VariantDetailsDto }) variantDetails!: VariantDetailsDto;
  @ApiProperty(MONEY) unitPrice!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty(MONEY) discount!: string;
  @ApiProperty(MONEY) lineTotal!: string;
}

export class VendorOrderItemDto extends OrderItemDto {
  @ApiProperty({ example: '8.50', description: 'Commission rate (%) frozen at checkout.' }) commissionRate!: string;
  @ApiProperty(MONEY) commissionAmount!: string;
}

export class StoreRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() storeName!: string;
  @ApiProperty() storeSlug!: string;
}

export class TimelineEventDto {
  @ApiProperty() at!: Date;
  @ApiProperty({ enum: ['ORDER_PLACED', 'PAYMENT_CONFIRMED', 'ORDER_CANCELLED', 'PAYMENT_FAILED', 'SUB_ORDER_STATUS'] })
  type!: 'ORDER_PLACED' | 'PAYMENT_CONFIRMED' | 'ORDER_CANCELLED' | 'PAYMENT_FAILED' | 'SUB_ORDER_STATUS';
  @ApiProperty({ nullable: true, type: String }) subOrderNumber!: string | null;
  @ApiProperty({ enum: SubOrderStatus, nullable: true }) fromStatus!: SubOrderStatus | null;
  @ApiProperty({ enum: SubOrderStatus, nullable: true }) toStatus!: SubOrderStatus | null;
  @ApiProperty({ enum: ['CUSTOMER', 'VENDOR', 'STAFF', 'SYSTEM'] }) actor!: string;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
}

export class CustomerSubOrderDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'SHP-100000001-1' }) subOrderNumber!: string;
  @ApiProperty({ type: StoreRefDto }) store!: StoreRefDto;
  @ApiProperty({ enum: SubOrderStatus }) status!: SubOrderStatus;
  @ApiProperty(MONEY) itemsSubtotal!: string;
  @ApiProperty(MONEY) shippingFee!: string;
  @ApiProperty({ ...MONEY, description: 'itemsSubtotal + shippingFee' }) total!: string;
  @ApiProperty({ nullable: true, type: String }) trackingCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) carrierName!: string | null;
  @ApiProperty({ nullable: true, type: Date }) shippedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) deliveredAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) cancelledAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) cancellationReason!: string | null;
  @ApiProperty({ type: [OrderItemDto] }) items!: OrderItemDto[];
}

class OrderMoneyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'SHP-100000001' }) orderNumber!: string;
  @ApiProperty({ enum: ParentOrderPaymentStatus }) paymentStatus!: ParentOrderPaymentStatus;
  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @ApiProperty(MONEY) totalItemsAmount!: string;
  @ApiProperty(MONEY) totalShippingFee!: string;
  @ApiProperty(MONEY) totalDiscountAmount!: string;
  @ApiProperty(MONEY) finalPayableAmount!: string;
  @ApiProperty({ nullable: true, type: Date, description: 'Unpaid orders are cancelled automatically after this instant.' })
  paymentExpiresAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class CustomerSubOrderSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() subOrderNumber!: string;
  @ApiProperty() storeName!: string;
  @ApiProperty({ enum: SubOrderStatus }) status!: SubOrderStatus;
  @ApiProperty(MONEY) itemsSubtotal!: string;
  @ApiProperty(MONEY) shippingFee!: string;
  @ApiProperty() itemCount!: number;
  @ApiProperty({ nullable: true, type: String }) trackingCode!: string | null;
}

export class CustomerOrderSummaryDto extends OrderMoneyDto {
  @ApiProperty({ type: [CustomerSubOrderSummaryDto] }) subOrders!: CustomerSubOrderSummaryDto[];
}

export class PaginatedCustomerOrdersDto {
  @ApiProperty({ type: [CustomerOrderSummaryDto] }) items!: CustomerOrderSummaryDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class CustomerOrderDetailDto extends OrderMoneyDto {
  @ApiProperty({ type: AddressSnapshotDto }) shippingAddress!: AddressSnapshotDto;
  @ApiProperty({ nullable: true, type: String }) customerNote!: string | null;
  @ApiProperty({ nullable: true, type: Date }) paidAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) cancelledAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) cancellationReason!: string | null;
  @ApiProperty({ description: 'True while the order is unpaid and can still be cancelled by the customer.' })
  canCancel!: boolean;
  @ApiProperty({ type: [CustomerSubOrderDto] }) subOrders!: CustomerSubOrderDto[];
  @ApiProperty({ type: [TimelineEventDto], description: 'Oldest first.' }) timeline!: TimelineEventDto[];
}

export class CheckoutResponseDto {
  @ApiProperty({ format: 'uuid' }) parentOrderId!: string;
  @ApiProperty({ example: 'SHP-100000001' }) orderNumber!: string;
  @ApiProperty({ enum: ParentOrderPaymentStatus, example: ParentOrderPaymentStatus.PENDING }) paymentStatus!: ParentOrderPaymentStatus;
  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @ApiProperty(MONEY) totalItemsAmount!: string;
  @ApiProperty(MONEY) totalShippingFee!: string;
  @ApiProperty(MONEY) totalDiscountAmount!: string;
  @ApiProperty(MONEY) finalPayableAmount!: string;
  @ApiProperty({ nullable: true, type: Date }) paymentExpiresAt!: Date | null;
  @ApiProperty({ type: [CustomerSubOrderDto] }) subOrders!: CustomerSubOrderDto[];
}

export class StatusHistoryDto {
  @ApiProperty({ enum: SubOrderStatus, nullable: true }) fromStatus!: SubOrderStatus | null;
  @ApiProperty({ enum: SubOrderStatus }) toStatus!: SubOrderStatus;
  @ApiProperty({ example: 'VENDOR' }) actorRole!: string;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty() at!: Date;
}

export class VendorSubOrderSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() subOrderNumber!: string;
  @ApiProperty() orderNumber!: string;
  @ApiProperty({ enum: SubOrderStatus }) status!: SubOrderStatus;
  @ApiProperty(MONEY) itemsSubtotal!: string;
  @ApiProperty(MONEY) shippingFee!: string;
  @ApiProperty(MONEY) platformCommissionAmount!: string;
  @ApiProperty(MONEY) vendorEarningsAmount!: string;
  @ApiProperty() itemCount!: number;
  @ApiProperty({ nullable: true, type: String }) trackingCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) carrierName!: string | null;
  @ApiProperty({ description: 'When the order was placed' }) placedAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) paidAt!: Date | null;
  @ApiProperty({ enum: SubOrderStatus, isArray: true, description: 'Statuses this vendor may move the package to now.' })
  allowedTransitions!: SubOrderStatus[];
}

export class PaginatedVendorSubOrdersDto {
  @ApiProperty({ type: [VendorSubOrderSummaryDto] }) items!: VendorSubOrderSummaryDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class VendorSubOrderDetailDto extends VendorSubOrderSummaryDto {
  @ApiProperty({ type: AddressSnapshotDto, description: 'Where to ship this package.' }) shippingAddress!: AddressSnapshotDto;
  @ApiProperty({ nullable: true, type: String }) customerNote!: string | null;
  @ApiProperty({ nullable: true, type: Date }) shippedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) deliveredAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) cancelledAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) cancellationReason!: string | null;
  @ApiProperty({ type: [VendorOrderItemDto] }) items!: VendorOrderItemDto[];
  @ApiProperty({ type: [StatusHistoryDto] }) history!: StatusHistoryDto[];
}

export class SubOrderTransitionResultDto {
  @ApiProperty({ enum: SubOrderStatus }) previousStatus!: SubOrderStatus;
  @ApiProperty({ enum: ['RESTOCKED', 'NONE'], description: 'What happened to the stock of the package lines.' })
  stockAction!: 'RESTOCKED' | 'NONE';
  @ApiProperty({
    enum: ['ESCROW_RELEASED', 'ESCROW_REVERSED', 'EARNINGS_REVERSED', 'DISPUTE_HOLD_REFUNDED', 'DISPUTE_HOLD_RELEASED', 'NONE'],
    description:
      'Wallet consequence: ESCROW_RELEASED (delivered → withdrawable), ESCROW_REVERSED (cancel/refund before delivery, out of escrow), ' +
      'EARNINGS_REVERSED (refund after delivery, out of the withdrawable balance), NONE. The DISPUTE_HOLD_* values are produced only by ' +
      'dispute resolutions (Phase 9): the frozen earnings were refunded or released to the vendor.',
  })
  walletAction!: WalletAction;
  @ApiProperty({ format: 'uuid' }) auditLogId!: string;
}

export class VendorSubOrderTransitionDto extends SubOrderTransitionResultDto {
  @ApiProperty({ type: VendorSubOrderDetailDto }) subOrder!: VendorSubOrderDetailDto;
}

export class CustomerRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() mobile!: string;
}

export class AdminSubOrderDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() subOrderNumber!: string;
  @ApiProperty({ type: StoreRefDto }) store!: StoreRefDto;
  @ApiProperty({ enum: SubOrderStatus }) status!: SubOrderStatus;
  @ApiProperty(MONEY) itemsSubtotal!: string;
  @ApiProperty(MONEY) shippingFee!: string;
  @ApiProperty(MONEY) platformCommissionAmount!: string;
  @ApiProperty(MONEY) vendorEarningsAmount!: string;
  @ApiProperty() itemCount!: number;
  @ApiProperty({ nullable: true, type: String }) trackingCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) carrierName!: string | null;
  @ApiProperty() updatedAt!: Date;
}

export class AdminOrderDto extends OrderMoneyDto {
  @ApiProperty({ type: CustomerRefDto }) customer!: CustomerRefDto;
  @ApiProperty({ nullable: true, type: Date }) paidAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) cancelledAt!: Date | null;
  @ApiProperty({ type: [AdminSubOrderDto] }) subOrders!: AdminSubOrderDto[];
}

export class PaginatedAdminOrdersDto {
  @ApiProperty({ type: [AdminOrderDto] }) items!: AdminOrderDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class AdminSubOrderTransitionDto extends SubOrderTransitionResultDto {
  @ApiProperty({ type: AdminSubOrderDto }) subOrder!: AdminSubOrderDto;
}

export class CancelOrderResponseDto extends CustomerOrderDetailDto {
  @ApiPropertyOptional({ format: 'uuid' }) auditLogId?: string;
}

export class CustomerDeliveryConfirmationDto extends SubOrderTransitionResultDto {
  @ApiProperty({ type: CustomerOrderDetailDto, description: 'The whole order after the confirmation.' }) order!: CustomerOrderDetailDto;
}
