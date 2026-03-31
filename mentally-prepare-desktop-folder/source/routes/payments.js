function registerPaymentRoutes(app, deps) {
  const {
    apiLimiter,
    requireAuth,
    express,
    crypto,
    razorpay,
    stripe,
    stmts
  } = deps;

  app.post('/api/pay/razorpay/create', apiLimiter, requireAuth, async (req, res) => {
    try {
      if (!razorpay) return res.status(503).json({ error: 'Razorpay not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.' });

      const { product } = req.body;
      const products = {
        'archetype-pdf': { amount: 99900, name: 'Connection Profile PDF', currency: 'INR' },
        'second-cycle': { amount: 49900, name: 'Second 21-Day Cycle', currency: 'INR' }
      };
      const p = products[product];
      if (!p) return res.status(400).json({ error: 'Invalid product' });

      const order = await razorpay.orders.create({
        amount: p.amount,
        currency: p.currency,
        receipt: 'mp_' + Date.now(),
        notes: { product, userId: String(req.session.userId) }
      });

      const result = stmts.insertPayment.run(req.session.userId, 'razorpay', order.id, p.amount, p.currency, product, 'created');

      res.json({
        orderId: order.id,
        amount: p.amount,
        currency: p.currency,
        name: p.name,
        keyId: process.env.RAZORPAY_KEY_ID,
        paymentId: Number(result.lastInsertRowid)
      });
    } catch (e) {
      console.error('Razorpay create error:', e);
      res.status(500).json({ error: 'Failed to create order' });
    }
  });

  app.post('/api/pay/razorpay/verify', apiLimiter, requireAuth, (req, res) => {
    try {
      if (!razorpay) return res.status(503).json({ error: 'Razorpay not configured' });

      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Missing payment details' });
      }

      const body = razorpay_order_id + '|' + razorpay_payment_id;
      const expectedSig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');
      if (expectedSig !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment verification failed' });
      }

      const payment = stmts.getPaymentByOrder.get(razorpay_order_id);
      if (payment) {
        stmts.updatePayment.run(razorpay_payment_id, 'paid', payment.id);
      }

      res.json({ ok: true, verified: true });
    } catch (e) {
      console.error('Razorpay verify error:', e);
      res.status(500).json({ error: 'Verification failed' });
    }
  });

  app.post('/api/pay/stripe/create', apiLimiter, requireAuth, async (req, res) => {
    try {
      if (!stripe) return res.status(503).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY.' });

      const { product } = req.body;
      const products = {
        'archetype-pdf': { amount: 1200, name: 'Connection Profile PDF', currency: 'usd' },
        'second-cycle': { amount: 600, name: 'Second 21-Day Cycle', currency: 'usd' }
      };
      const p = products[product];
      if (!p) return res.status(400).json({ error: 'Invalid product' });

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: p.currency,
            product_data: { name: p.name, description: 'Mentally Prepare — ' + p.name },
            unit_amount: p.amount
          },
          quantity: 1
        }],
        mode: 'payment',
        success_url: req.header('origin') + '/app?payment=success',
        cancel_url: req.header('origin') + '/app?payment=cancelled',
        metadata: { product, userId: String(req.session.userId) }
      });

      const result = stmts.insertPayment.run(req.session.userId, 'stripe', session.id, p.amount, p.currency, product, 'created');

      res.json({ url: session.url, paymentId: Number(result.lastInsertRowid) });
    } catch (e) {
      console.error('Stripe create error:', e);
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  app.post('/api/pay/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    try {
      if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send();

      const sig = req.headers['stripe-signature'];
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        return res.status(400).send('Webhook signature verification failed');
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const payment = stmts.getPaymentByOrder.get(session.id);
        if (payment) {
          stmts.updatePayment.run(session.payment_intent, 'paid', payment.id);
        }
      }

      res.json({ received: true });
    } catch (e) {
      console.error('Stripe webhook error:', e);
      res.status(500).send();
    }
  });

  app.get('/api/pay/history', apiLimiter, requireAuth, (req, res) => {
    try {
      const payments = stmts.getUserPayments.all(req.session.userId)
        .map(p => ({ id: p.id, product: p.product, amount: p.amount, currency: p.currency, status: p.status, provider: p.provider, created_at: p.created_at }));
      res.json({ payments });
    } catch (e) {
      res.status(500).json({ error: 'Failed to load payment history' });
    }
  });
}

module.exports = {
  registerPaymentRoutes
};
