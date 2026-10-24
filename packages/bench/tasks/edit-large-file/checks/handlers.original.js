/**
 * Webhook handlers, one per event type: each checks the payload and returns the record the event log stores.
 * Generated from the event catalogue; edit a handler here only when its event needs more than the usual checks.
 */

/** Handles a payment.created event. */
export function handlePaymentCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.created', id: payload.id, amount, at }
}

/** Handles a payment.updated event. */
export function handlePaymentUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.updated', id: payload.id, amount, at }
}

/** Handles a payment.cancelled event. */
export function handlePaymentCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.cancelled', id: payload.id, amount, at }
}

/** Handles a payment.requested event. */
export function handlePaymentRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.requested', id: payload.id, amount, at }
}

/** Handles a payment.issued event. */
export function handlePaymentIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.issued', id: payload.id, amount, at }
}

/** Handles a payment.failed event. */
export function handlePaymentFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.failed', id: payload.id, amount, at }
}

/** Handles a payment.captured event. */
export function handlePaymentCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.captured', id: payload.id, amount, at }
}

/** Handles a payment.expired event. */
export function handlePaymentExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.expired', id: payload.id, amount, at }
}

/** Handles a payment.renewed event. */
export function handlePaymentRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.renewed', id: payload.id, amount, at }
}

/** Handles a payment.opened event. */
export function handlePaymentOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.opened', id: payload.id, amount, at }
}

/** Handles a payment.closed event. */
export function handlePaymentClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.closed', id: payload.id, amount, at }
}

/** Handles a payment.approved event. */
export function handlePaymentApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.approved', id: payload.id, amount, at }
}

/** Handles a payment.rejected event. */
export function handlePaymentRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.rejected', id: payload.id, amount, at }
}

/** Handles a payment.paid event. */
export function handlePaymentPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.paid', id: payload.id, amount, at }
}

/** Handles a payment.archived event. */
export function handlePaymentArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payment.archived', id: payload.id, amount, at }
}

/** Handles a invoice.created event. */
export function handleInvoiceCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.created', id: payload.id, amount, at }
}

/** Handles a invoice.updated event. */
export function handleInvoiceUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.updated', id: payload.id, amount, at }
}

/** Handles a invoice.cancelled event. */
export function handleInvoiceCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.cancelled', id: payload.id, amount, at }
}

/** Handles a invoice.requested event. */
export function handleInvoiceRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.requested', id: payload.id, amount, at }
}

/** Handles a invoice.issued event. */
export function handleInvoiceIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.issued', id: payload.id, amount, at }
}

/** Handles a invoice.failed event. */
export function handleInvoiceFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.failed', id: payload.id, amount, at }
}

/** Handles a invoice.captured event. */
export function handleInvoiceCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.captured', id: payload.id, amount, at }
}

/** Handles a invoice.expired event. */
export function handleInvoiceExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.expired', id: payload.id, amount, at }
}

/** Handles a invoice.renewed event. */
export function handleInvoiceRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.renewed', id: payload.id, amount, at }
}

/** Handles a invoice.opened event. */
export function handleInvoiceOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.opened', id: payload.id, amount, at }
}

/** Handles a invoice.closed event. */
export function handleInvoiceClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.closed', id: payload.id, amount, at }
}

/** Handles a invoice.approved event. */
export function handleInvoiceApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.approved', id: payload.id, amount, at }
}

/** Handles a invoice.rejected event. */
export function handleInvoiceRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.rejected', id: payload.id, amount, at }
}

/** Handles a invoice.paid event. */
export function handleInvoicePaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.paid', id: payload.id, amount, at }
}

/** Handles a invoice.archived event. */
export function handleInvoiceArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'invoice.archived', id: payload.id, amount, at }
}

/** Handles a order.created event. */
export function handleOrderCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.created', id: payload.id, amount, at }
}

/** Handles a order.updated event. */
export function handleOrderUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.updated', id: payload.id, amount, at }
}

/** Handles a order.cancelled event. */
export function handleOrderCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.cancelled', id: payload.id, amount, at }
}

/** Handles a order.requested event. */
export function handleOrderRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.requested', id: payload.id, amount, at }
}

/** Handles a order.issued event. */
export function handleOrderIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.issued', id: payload.id, amount, at }
}

/** Handles a order.failed event. */
export function handleOrderFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.failed', id: payload.id, amount, at }
}

/** Handles a order.captured event. */
export function handleOrderCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.captured', id: payload.id, amount, at }
}

/** Handles a order.expired event. */
export function handleOrderExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.expired', id: payload.id, amount, at }
}

/** Handles a order.renewed event. */
export function handleOrderRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.renewed', id: payload.id, amount, at }
}

/** Handles a order.opened event. */
export function handleOrderOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.opened', id: payload.id, amount, at }
}

/** Handles a order.closed event. */
export function handleOrderClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.closed', id: payload.id, amount, at }
}

/** Handles a order.approved event. */
export function handleOrderApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.approved', id: payload.id, amount, at }
}

/** Handles a order.rejected event. */
export function handleOrderRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.rejected', id: payload.id, amount, at }
}

/** Handles a order.paid event. */
export function handleOrderPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.paid', id: payload.id, amount, at }
}

/** Handles a order.archived event. */
export function handleOrderArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'order.archived', id: payload.id, amount, at }
}

/** Handles a shipment.created event. */
export function handleShipmentCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.created', id: payload.id, amount, at }
}

/** Handles a shipment.updated event. */
export function handleShipmentUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.updated', id: payload.id, amount, at }
}

/** Handles a shipment.cancelled event. */
export function handleShipmentCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.cancelled', id: payload.id, amount, at }
}

/** Handles a shipment.requested event. */
export function handleShipmentRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.requested', id: payload.id, amount, at }
}

/** Handles a shipment.issued event. */
export function handleShipmentIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.issued', id: payload.id, amount, at }
}

/** Handles a shipment.failed event. */
export function handleShipmentFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.failed', id: payload.id, amount, at }
}

/** Handles a shipment.captured event. */
export function handleShipmentCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.captured', id: payload.id, amount, at }
}

/** Handles a shipment.expired event. */
export function handleShipmentExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.expired', id: payload.id, amount, at }
}

/** Handles a shipment.renewed event. */
export function handleShipmentRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.renewed', id: payload.id, amount, at }
}

/** Handles a shipment.opened event. */
export function handleShipmentOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.opened', id: payload.id, amount, at }
}

/** Handles a shipment.closed event. */
export function handleShipmentClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.closed', id: payload.id, amount, at }
}

/** Handles a shipment.approved event. */
export function handleShipmentApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.approved', id: payload.id, amount, at }
}

/** Handles a shipment.rejected event. */
export function handleShipmentRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.rejected', id: payload.id, amount, at }
}

/** Handles a shipment.paid event. */
export function handleShipmentPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.paid', id: payload.id, amount, at }
}

/** Handles a shipment.archived event. */
export function handleShipmentArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'shipment.archived', id: payload.id, amount, at }
}

/** Handles a subscription.created event. */
export function handleSubscriptionCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.created', id: payload.id, amount, at }
}

/** Handles a subscription.updated event. */
export function handleSubscriptionUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.updated', id: payload.id, amount, at }
}

/** Handles a subscription.cancelled event. */
export function handleSubscriptionCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.cancelled', id: payload.id, amount, at }
}

/** Handles a subscription.requested event. */
export function handleSubscriptionRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.requested', id: payload.id, amount, at }
}

/** Handles a subscription.issued event. */
export function handleSubscriptionIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.issued', id: payload.id, amount, at }
}

/** Handles a subscription.failed event. */
export function handleSubscriptionFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.failed', id: payload.id, amount, at }
}

/** Handles a subscription.captured event. */
export function handleSubscriptionCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.captured', id: payload.id, amount, at }
}

/** Handles a subscription.expired event. */
export function handleSubscriptionExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.expired', id: payload.id, amount, at }
}

/** Handles a subscription.renewed event. */
export function handleSubscriptionRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.renewed', id: payload.id, amount, at }
}

/** Handles a subscription.opened event. */
export function handleSubscriptionOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.opened', id: payload.id, amount, at }
}

/** Handles a subscription.closed event. */
export function handleSubscriptionClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.closed', id: payload.id, amount, at }
}

/** Handles a subscription.approved event. */
export function handleSubscriptionApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.approved', id: payload.id, amount, at }
}

/** Handles a subscription.rejected event. */
export function handleSubscriptionRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.rejected', id: payload.id, amount, at }
}

/** Handles a subscription.paid event. */
export function handleSubscriptionPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.paid', id: payload.id, amount, at }
}

/** Handles a subscription.archived event. */
export function handleSubscriptionArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'subscription.archived', id: payload.id, amount, at }
}

/** Handles a coupon.created event. */
export function handleCouponCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.created', id: payload.id, amount, at }
}

/** Handles a coupon.updated event. */
export function handleCouponUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.updated', id: payload.id, amount, at }
}

/** Handles a coupon.cancelled event. */
export function handleCouponCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.cancelled', id: payload.id, amount, at }
}

/** Handles a coupon.requested event. */
export function handleCouponRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.requested', id: payload.id, amount, at }
}

/** Handles a coupon.issued event. */
export function handleCouponIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.issued', id: payload.id, amount, at }
}

/** Handles a coupon.failed event. */
export function handleCouponFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.failed', id: payload.id, amount, at }
}

/** Handles a coupon.captured event. */
export function handleCouponCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.captured', id: payload.id, amount, at }
}

/** Handles a coupon.expired event. */
export function handleCouponExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.expired', id: payload.id, amount, at }
}

/** Handles a coupon.renewed event. */
export function handleCouponRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.renewed', id: payload.id, amount, at }
}

/** Handles a coupon.opened event. */
export function handleCouponOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.opened', id: payload.id, amount, at }
}

/** Handles a coupon.closed event. */
export function handleCouponClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.closed', id: payload.id, amount, at }
}

/** Handles a coupon.approved event. */
export function handleCouponApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.approved', id: payload.id, amount, at }
}

/** Handles a coupon.rejected event. */
export function handleCouponRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.rejected', id: payload.id, amount, at }
}

/** Handles a coupon.paid event. */
export function handleCouponPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.paid', id: payload.id, amount, at }
}

/** Handles a coupon.archived event. */
export function handleCouponArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'coupon.archived', id: payload.id, amount, at }
}

/** Handles a account.created event. */
export function handleAccountCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.created', id: payload.id, amount, at }
}

/** Handles a account.updated event. */
export function handleAccountUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.updated', id: payload.id, amount, at }
}

/** Handles a account.cancelled event. */
export function handleAccountCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.cancelled', id: payload.id, amount, at }
}

/** Handles a account.requested event. */
export function handleAccountRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.requested', id: payload.id, amount, at }
}

/** Handles a account.issued event. */
export function handleAccountIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.issued', id: payload.id, amount, at }
}

/** Handles a account.failed event. */
export function handleAccountFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.failed', id: payload.id, amount, at }
}

/** Handles a account.captured event. */
export function handleAccountCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.captured', id: payload.id, amount, at }
}

/** Handles a account.expired event. */
export function handleAccountExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.expired', id: payload.id, amount, at }
}

/** Handles a account.renewed event. */
export function handleAccountRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.renewed', id: payload.id, amount, at }
}

/** Handles a account.opened event. */
export function handleAccountOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.opened', id: payload.id, amount, at }
}

/** Handles a account.closed event. */
export function handleAccountClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.closed', id: payload.id, amount, at }
}

/** Handles a account.approved event. */
export function handleAccountApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.approved', id: payload.id, amount, at }
}

/** Handles a account.rejected event. */
export function handleAccountRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.rejected', id: payload.id, amount, at }
}

/** Handles a account.paid event. */
export function handleAccountPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.paid', id: payload.id, amount, at }
}

/** Handles a account.archived event. */
export function handleAccountArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'account.archived', id: payload.id, amount, at }
}

/** Handles a cart.created event. */
export function handleCartCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.created', id: payload.id, amount, at }
}

/** Handles a cart.updated event. */
export function handleCartUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.updated', id: payload.id, amount, at }
}

/** Handles a cart.cancelled event. */
export function handleCartCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.cancelled', id: payload.id, amount, at }
}

/** Handles a cart.requested event. */
export function handleCartRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.requested', id: payload.id, amount, at }
}

/** Handles a cart.issued event. */
export function handleCartIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.issued', id: payload.id, amount, at }
}

/** Handles a cart.failed event. */
export function handleCartFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.failed', id: payload.id, amount, at }
}

/** Handles a cart.captured event. */
export function handleCartCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.captured', id: payload.id, amount, at }
}

/** Handles a cart.expired event. */
export function handleCartExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.expired', id: payload.id, amount, at }
}

/** Handles a cart.renewed event. */
export function handleCartRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.renewed', id: payload.id, amount, at }
}

/** Handles a cart.opened event. */
export function handleCartOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.opened', id: payload.id, amount, at }
}

/** Handles a cart.closed event. */
export function handleCartClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.closed', id: payload.id, amount, at }
}

/** Handles a cart.approved event. */
export function handleCartApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.approved', id: payload.id, amount, at }
}

/** Handles a cart.rejected event. */
export function handleCartRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.rejected', id: payload.id, amount, at }
}

/** Handles a cart.paid event. */
export function handleCartPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.paid', id: payload.id, amount, at }
}

/** Handles a cart.archived event. */
export function handleCartArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'cart.archived', id: payload.id, amount, at }
}

/** Handles a review.created event. */
export function handleReviewCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.created', id: payload.id, amount, at }
}

/** Handles a review.updated event. */
export function handleReviewUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.updated', id: payload.id, amount, at }
}

/** Handles a review.cancelled event. */
export function handleReviewCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.cancelled', id: payload.id, amount, at }
}

/** Handles a review.requested event. */
export function handleReviewRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.requested', id: payload.id, amount, at }
}

/** Handles a review.issued event. */
export function handleReviewIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.issued', id: payload.id, amount, at }
}

/** Handles a review.failed event. */
export function handleReviewFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.failed', id: payload.id, amount, at }
}

/** Handles a review.captured event. */
export function handleReviewCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.captured', id: payload.id, amount, at }
}

/** Handles a review.expired event. */
export function handleReviewExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.expired', id: payload.id, amount, at }
}

/** Handles a review.renewed event. */
export function handleReviewRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.renewed', id: payload.id, amount, at }
}

/** Handles a review.opened event. */
export function handleReviewOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.opened', id: payload.id, amount, at }
}

/** Handles a review.closed event. */
export function handleReviewClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.closed', id: payload.id, amount, at }
}

/** Handles a review.approved event. */
export function handleReviewApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.approved', id: payload.id, amount, at }
}

/** Handles a review.rejected event. */
export function handleReviewRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.rejected', id: payload.id, amount, at }
}

/** Handles a review.paid event. */
export function handleReviewPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.paid', id: payload.id, amount, at }
}

/** Handles a review.archived event. */
export function handleReviewArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'review.archived', id: payload.id, amount, at }
}

/** Handles a ticket.created event. */
export function handleTicketCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.created', id: payload.id, amount, at }
}

/** Handles a ticket.updated event. */
export function handleTicketUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.updated', id: payload.id, amount, at }
}

/** Handles a ticket.cancelled event. */
export function handleTicketCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.cancelled', id: payload.id, amount, at }
}

/** Handles a ticket.requested event. */
export function handleTicketRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.requested', id: payload.id, amount, at }
}

/** Handles a ticket.issued event. */
export function handleTicketIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.issued', id: payload.id, amount, at }
}

/** Handles a ticket.failed event. */
export function handleTicketFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.failed', id: payload.id, amount, at }
}

/** Handles a ticket.captured event. */
export function handleTicketCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.captured', id: payload.id, amount, at }
}

/** Handles a ticket.expired event. */
export function handleTicketExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.expired', id: payload.id, amount, at }
}

/** Handles a ticket.renewed event. */
export function handleTicketRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.renewed', id: payload.id, amount, at }
}

/** Handles a ticket.opened event. */
export function handleTicketOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.opened', id: payload.id, amount, at }
}

/** Handles a ticket.closed event. */
export function handleTicketClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.closed', id: payload.id, amount, at }
}

/** Handles a ticket.approved event. */
export function handleTicketApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.approved', id: payload.id, amount, at }
}

/** Handles a ticket.rejected event. */
export function handleTicketRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.rejected', id: payload.id, amount, at }
}

/** Handles a ticket.paid event. */
export function handleTicketPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.paid', id: payload.id, amount, at }
}

/** Handles a ticket.archived event. */
export function handleTicketArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'ticket.archived', id: payload.id, amount, at }
}

/** Handles a payout.created event. */
export function handlePayoutCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.created', id: payload.id, amount, at }
}

/** Handles a payout.updated event. */
export function handlePayoutUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.updated', id: payload.id, amount, at }
}

/** Handles a payout.cancelled event. */
export function handlePayoutCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.cancelled', id: payload.id, amount, at }
}

/** Handles a payout.requested event. */
export function handlePayoutRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.requested', id: payload.id, amount, at }
}

/** Handles a payout.issued event. */
export function handlePayoutIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.issued', id: payload.id, amount, at }
}

/** Handles a payout.failed event. */
export function handlePayoutFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.failed', id: payload.id, amount, at }
}

/** Handles a payout.captured event. */
export function handlePayoutCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.captured', id: payload.id, amount, at }
}

/** Handles a payout.expired event. */
export function handlePayoutExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.expired', id: payload.id, amount, at }
}

/** Handles a payout.renewed event. */
export function handlePayoutRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.renewed', id: payload.id, amount, at }
}

/** Handles a payout.opened event. */
export function handlePayoutOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.opened', id: payload.id, amount, at }
}

/** Handles a payout.closed event. */
export function handlePayoutClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.closed', id: payload.id, amount, at }
}

/** Handles a payout.approved event. */
export function handlePayoutApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.approved', id: payload.id, amount, at }
}

/** Handles a payout.rejected event. */
export function handlePayoutRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.rejected', id: payload.id, amount, at }
}

/** Handles a payout.paid event. */
export function handlePayoutPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.paid', id: payload.id, amount, at }
}

/** Handles a payout.archived event. */
export function handlePayoutArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'payout.archived', id: payload.id, amount, at }
}

/** Handles a return.created event. */
export function handleReturnCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.created', id: payload.id, amount, at }
}

/** Handles a return.updated event. */
export function handleReturnUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.updated', id: payload.id, amount, at }
}

/** Handles a return.cancelled event. */
export function handleReturnCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.cancelled', id: payload.id, amount, at }
}

/** Handles a return.requested event. */
export function handleReturnRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.requested', id: payload.id, amount, at }
}

/** Handles a return.issued event. */
export function handleReturnIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.issued', id: payload.id, amount, at }
}

/** Handles a return.failed event. */
export function handleReturnFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.failed', id: payload.id, amount, at }
}

/** Handles a return.captured event. */
export function handleReturnCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.captured', id: payload.id, amount, at }
}

/** Handles a return.expired event. */
export function handleReturnExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.expired', id: payload.id, amount, at }
}

/** Handles a return.renewed event. */
export function handleReturnRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.renewed', id: payload.id, amount, at }
}

/** Handles a return.opened event. */
export function handleReturnOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.opened', id: payload.id, amount, at }
}

/** Handles a return.closed event. */
export function handleReturnClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.closed', id: payload.id, amount, at }
}

/** Handles a return.approved event. */
export function handleReturnApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.approved', id: payload.id, amount, at }
}

/** Handles a return.rejected event. */
export function handleReturnRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.rejected', id: payload.id, amount, at }
}

/** Handles a return.paid event. */
export function handleReturnPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.paid', id: payload.id, amount, at }
}

/** Handles a return.archived event. */
export function handleReturnArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'return.archived', id: payload.id, amount, at }
}

/** Handles a gift-card.created event. */
export function handleGiftCardCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.created', id: payload.id, amount, at }
}

/** Handles a gift-card.updated event. */
export function handleGiftCardUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.updated', id: payload.id, amount, at }
}

/** Handles a gift-card.cancelled event. */
export function handleGiftCardCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.cancelled', id: payload.id, amount, at }
}

/** Handles a gift-card.requested event. */
export function handleGiftCardRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.requested', id: payload.id, amount, at }
}

/** Handles a gift-card.issued event. */
export function handleGiftCardIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.issued', id: payload.id, amount, at }
}

/** Handles a gift-card.failed event. */
export function handleGiftCardFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.failed', id: payload.id, amount, at }
}

/** Handles a gift-card.captured event. */
export function handleGiftCardCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.captured', id: payload.id, amount, at }
}

/** Handles a gift-card.expired event. */
export function handleGiftCardExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.expired', id: payload.id, amount, at }
}

/** Handles a gift-card.renewed event. */
export function handleGiftCardRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.renewed', id: payload.id, amount, at }
}

/** Handles a gift-card.opened event. */
export function handleGiftCardOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.opened', id: payload.id, amount, at }
}

/** Handles a gift-card.closed event. */
export function handleGiftCardClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.closed', id: payload.id, amount, at }
}

/** Handles a gift-card.approved event. */
export function handleGiftCardApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.approved', id: payload.id, amount, at }
}

/** Handles a gift-card.rejected event. */
export function handleGiftCardRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.rejected', id: payload.id, amount, at }
}

/** Handles a gift-card.paid event. */
export function handleGiftCardPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.paid', id: payload.id, amount, at }
}

/** Handles a gift-card.archived event. */
export function handleGiftCardArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'gift-card.archived', id: payload.id, amount, at }
}

/** Handles a wallet.created event. */
export function handleWalletCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.created', id: payload.id, amount, at }
}

/** Handles a wallet.updated event. */
export function handleWalletUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.updated', id: payload.id, amount, at }
}

/** Handles a wallet.cancelled event. */
export function handleWalletCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.cancelled', id: payload.id, amount, at }
}

/** Handles a wallet.requested event. */
export function handleWalletRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.requested', id: payload.id, amount, at }
}

/** Handles a wallet.issued event. */
export function handleWalletIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.issued', id: payload.id, amount, at }
}

/** Handles a wallet.failed event. */
export function handleWalletFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.failed', id: payload.id, amount, at }
}

/** Handles a wallet.captured event. */
export function handleWalletCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.captured', id: payload.id, amount, at }
}

/** Handles a wallet.expired event. */
export function handleWalletExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.expired', id: payload.id, amount, at }
}

/** Handles a wallet.renewed event. */
export function handleWalletRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.renewed', id: payload.id, amount, at }
}

/** Handles a wallet.opened event. */
export function handleWalletOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.opened', id: payload.id, amount, at }
}

/** Handles a wallet.closed event. */
export function handleWalletClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.closed', id: payload.id, amount, at }
}

/** Handles a wallet.approved event. */
export function handleWalletApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.approved', id: payload.id, amount, at }
}

/** Handles a wallet.rejected event. */
export function handleWalletRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.rejected', id: payload.id, amount, at }
}

/** Handles a wallet.paid event. */
export function handleWalletPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.paid', id: payload.id, amount, at }
}

/** Handles a wallet.archived event. */
export function handleWalletArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'wallet.archived', id: payload.id, amount, at }
}

/** Handles a loyalty.created event. */
export function handleLoyaltyCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.created', id: payload.id, amount, at }
}

/** Handles a loyalty.updated event. */
export function handleLoyaltyUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.updated', id: payload.id, amount, at }
}

/** Handles a loyalty.cancelled event. */
export function handleLoyaltyCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.cancelled', id: payload.id, amount, at }
}

/** Handles a loyalty.requested event. */
export function handleLoyaltyRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.requested', id: payload.id, amount, at }
}

/** Handles a loyalty.issued event. */
export function handleLoyaltyIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.issued', id: payload.id, amount, at }
}

/** Handles a loyalty.failed event. */
export function handleLoyaltyFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.failed', id: payload.id, amount, at }
}

/** Handles a loyalty.captured event. */
export function handleLoyaltyCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.captured', id: payload.id, amount, at }
}

/** Handles a loyalty.expired event. */
export function handleLoyaltyExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.expired', id: payload.id, amount, at }
}

/** Handles a loyalty.renewed event. */
export function handleLoyaltyRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.renewed', id: payload.id, amount, at }
}

/** Handles a loyalty.opened event. */
export function handleLoyaltyOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.opened', id: payload.id, amount, at }
}

/** Handles a loyalty.closed event. */
export function handleLoyaltyClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.closed', id: payload.id, amount, at }
}

/** Handles a loyalty.approved event. */
export function handleLoyaltyApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.approved', id: payload.id, amount, at }
}

/** Handles a loyalty.rejected event. */
export function handleLoyaltyRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.rejected', id: payload.id, amount, at }
}

/** Handles a loyalty.paid event. */
export function handleLoyaltyPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.paid', id: payload.id, amount, at }
}

/** Handles a loyalty.archived event. */
export function handleLoyaltyArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'loyalty.archived', id: payload.id, amount, at }
}

/** Handles a booking.created event. */
export function handleBookingCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.created', id: payload.id, amount, at }
}

/** Handles a booking.updated event. */
export function handleBookingUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.updated', id: payload.id, amount, at }
}

/** Handles a booking.cancelled event. */
export function handleBookingCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.cancelled', id: payload.id, amount, at }
}

/** Handles a booking.requested event. */
export function handleBookingRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.requested', id: payload.id, amount, at }
}

/** Handles a booking.issued event. */
export function handleBookingIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.issued', id: payload.id, amount, at }
}

/** Handles a booking.failed event. */
export function handleBookingFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.failed', id: payload.id, amount, at }
}

/** Handles a booking.captured event. */
export function handleBookingCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.captured', id: payload.id, amount, at }
}

/** Handles a booking.expired event. */
export function handleBookingExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.expired', id: payload.id, amount, at }
}

/** Handles a booking.renewed event. */
export function handleBookingRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.renewed', id: payload.id, amount, at }
}

/** Handles a booking.opened event. */
export function handleBookingOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.opened', id: payload.id, amount, at }
}

/** Handles a booking.closed event. */
export function handleBookingClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.closed', id: payload.id, amount, at }
}

/** Handles a booking.approved event. */
export function handleBookingApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.approved', id: payload.id, amount, at }
}

/** Handles a booking.rejected event. */
export function handleBookingRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.rejected', id: payload.id, amount, at }
}

/** Handles a booking.paid event. */
export function handleBookingPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.paid', id: payload.id, amount, at }
}

/** Handles a booking.archived event. */
export function handleBookingArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'booking.archived', id: payload.id, amount, at }
}

/** Handles a quote.created event. */
export function handleQuoteCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.created', id: payload.id, amount, at }
}

/** Handles a quote.updated event. */
export function handleQuoteUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.updated', id: payload.id, amount, at }
}

/** Handles a quote.cancelled event. */
export function handleQuoteCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.cancelled', id: payload.id, amount, at }
}

/** Handles a quote.requested event. */
export function handleQuoteRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.requested', id: payload.id, amount, at }
}

/** Handles a quote.issued event. */
export function handleQuoteIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.issued', id: payload.id, amount, at }
}

/** Handles a quote.failed event. */
export function handleQuoteFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.failed', id: payload.id, amount, at }
}

/** Handles a quote.captured event. */
export function handleQuoteCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.captured', id: payload.id, amount, at }
}

/** Handles a quote.expired event. */
export function handleQuoteExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.expired', id: payload.id, amount, at }
}

/** Handles a quote.renewed event. */
export function handleQuoteRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.renewed', id: payload.id, amount, at }
}

/** Handles a quote.opened event. */
export function handleQuoteOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.opened', id: payload.id, amount, at }
}

/** Handles a quote.closed event. */
export function handleQuoteClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.closed', id: payload.id, amount, at }
}

/** Handles a quote.approved event. */
export function handleQuoteApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.approved', id: payload.id, amount, at }
}

/** Handles a quote.rejected event. */
export function handleQuoteRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.rejected', id: payload.id, amount, at }
}

/** Handles a quote.paid event. */
export function handleQuotePaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.paid', id: payload.id, amount, at }
}

/** Handles a quote.archived event. */
export function handleQuoteArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'quote.archived', id: payload.id, amount, at }
}

/** Handles a refund.created event. */
export function handleRefundCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.created', id: payload.id, amount, at }
}

/** Handles a refund.updated event. */
export function handleRefundUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.updated', id: payload.id, amount, at }
}

/** Handles a refund.cancelled event. */
export function handleRefundCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.cancelled', id: payload.id, amount, at }
}

/** Handles a refund.requested event. */
export function handleRefundRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.requested', id: payload.id, amount, at }
}

/** Handles a refund.issued event. */
export function handleRefundIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.issued', id: payload.id, amount, at }
}

/** Handles a refund.failed event. */
export function handleRefundFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.failed', id: payload.id, amount, at }
}

/** Handles a refund.captured event. */
export function handleRefundCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.captured', id: payload.id, amount, at }
}

/** Handles a refund.expired event. */
export function handleRefundExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.expired', id: payload.id, amount, at }
}

/** Handles a refund.renewed event. */
export function handleRefundRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.renewed', id: payload.id, amount, at }
}

/** Handles a refund.opened event. */
export function handleRefundOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.opened', id: payload.id, amount, at }
}

/** Handles a refund.closed event. */
export function handleRefundClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.closed', id: payload.id, amount, at }
}

/** Handles a refund.approved event. */
export function handleRefundApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.approved', id: payload.id, amount, at }
}

/** Handles a refund.rejected event. */
export function handleRefundRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.rejected', id: payload.id, amount, at }
}

/** Handles a refund.paid event. */
export function handleRefundPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.paid', id: payload.id, amount, at }
}

/** Handles a refund.archived event. */
export function handleRefundArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'refund.archived', id: payload.id, amount, at }
}

/** Handles a dispute.created event. */
export function handleDisputeCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.created', id: payload.id, amount, at }
}

/** Handles a dispute.updated event. */
export function handleDisputeUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.updated', id: payload.id, amount, at }
}

/** Handles a dispute.cancelled event. */
export function handleDisputeCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.cancelled', id: payload.id, amount, at }
}

/** Handles a dispute.requested event. */
export function handleDisputeRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.requested', id: payload.id, amount, at }
}

/** Handles a dispute.issued event. */
export function handleDisputeIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.issued', id: payload.id, amount, at }
}

/** Handles a dispute.failed event. */
export function handleDisputeFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.failed', id: payload.id, amount, at }
}

/** Handles a dispute.captured event. */
export function handleDisputeCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.captured', id: payload.id, amount, at }
}

/** Handles a dispute.expired event. */
export function handleDisputeExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.expired', id: payload.id, amount, at }
}

/** Handles a dispute.renewed event. */
export function handleDisputeRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.renewed', id: payload.id, amount, at }
}

/** Handles a dispute.opened event. */
export function handleDisputeOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.opened', id: payload.id, amount, at }
}

/** Handles a dispute.closed event. */
export function handleDisputeClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.closed', id: payload.id, amount, at }
}

/** Handles a dispute.approved event. */
export function handleDisputeApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.approved', id: payload.id, amount, at }
}

/** Handles a dispute.rejected event. */
export function handleDisputeRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.rejected', id: payload.id, amount, at }
}

/** Handles a dispute.paid event. */
export function handleDisputePaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.paid', id: payload.id, amount, at }
}

/** Handles a dispute.archived event. */
export function handleDisputeArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'dispute.archived', id: payload.id, amount, at }
}

/** Handles a transfer.created event. */
export function handleTransferCreated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.created', id: payload.id, amount, at }
}

/** Handles a transfer.updated event. */
export function handleTransferUpdated(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.updated', id: payload.id, amount, at }
}

/** Handles a transfer.cancelled event. */
export function handleTransferCancelled(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.cancelled', id: payload.id, amount, at }
}

/** Handles a transfer.requested event. */
export function handleTransferRequested(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.requested', id: payload.id, amount, at }
}

/** Handles a transfer.issued event. */
export function handleTransferIssued(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.issued', id: payload.id, amount, at }
}

/** Handles a transfer.failed event. */
export function handleTransferFailed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.failed', id: payload.id, amount, at }
}

/** Handles a transfer.captured event. */
export function handleTransferCaptured(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.captured', id: payload.id, amount, at }
}

/** Handles a transfer.expired event. */
export function handleTransferExpired(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.expired', id: payload.id, amount, at }
}

/** Handles a transfer.renewed event. */
export function handleTransferRenewed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.renewed', id: payload.id, amount, at }
}

/** Handles a transfer.opened event. */
export function handleTransferOpened(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.opened', id: payload.id, amount, at }
}

/** Handles a transfer.closed event. */
export function handleTransferClosed(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.closed', id: payload.id, amount, at }
}

/** Handles a transfer.approved event. */
export function handleTransferApproved(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.approved', id: payload.id, amount, at }
}

/** Handles a transfer.rejected event. */
export function handleTransferRejected(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.rejected', id: payload.id, amount, at }
}

/** Handles a transfer.paid event. */
export function handleTransferPaid(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.paid', id: payload.id, amount, at }
}

/** Handles a transfer.archived event. */
export function handleTransferArchived(payload) {
  const amount = Number(payload.amount)
  if (!Number.isFinite(amount)) throw new TypeError('amount must be a number')
  const at = payload.at ?? null
  return { type: 'transfer.archived', id: payload.id, amount, at }
}
