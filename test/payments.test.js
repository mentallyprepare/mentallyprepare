'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { registerPaymentRoutes } = require('../routes/payments');

const secret = 'test-razorpay-secret';
process.env.RAZORPAY_KEY_SECRET = secret;

const routes = new Map();
const paid = [];
const events = [];
let payment;
registerPaymentRoutes({
  post(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  get() {}
}, {
  apiLimiter() {},
  requireAuth() {},
  crypto,
  razorpay: {},
  stripe: null,
  stmts: {
    getPaymentByOrder: { get() { return payment; } },
    updatePayment: { run(...args) { paid.push(args); } }
  },
  trackEvent(...args) { events.push(args); },
  baseUrl: 'https://example.test'
});

function verify(userId) {
  const orderId = 'order_123';
  const paymentId = 'pay_123';
  const signature = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  const response = { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  routes.get('/api/pay/razorpay/verify')({
    session: { userId },
    body: { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }
  }, response);
  return response;
}

payment = null;
assert.strictEqual(verify(1).statusCode, 404);
assert.strictEqual(paid.length, 0);

payment = { id: 7, provider: 'razorpay', user_id: 2, status: 'created', product: 'archetype-pdf' };
assert.strictEqual(verify(1).statusCode, 404);
assert.strictEqual(paid.length, 0);

payment = { ...payment, user_id: 1 };
assert.strictEqual(verify(1).statusCode, 200);
assert.deepStrictEqual(paid, [['pay_123', 'paid', 7]]);
assert.strictEqual(events.length, 1);

payment = { ...payment, status: 'paid' };
assert.strictEqual(verify(1).statusCode, 409);
assert.strictEqual(paid.length, 1);
assert.strictEqual(events.length, 1);

console.log('4/4 payment verification tests passed.');
