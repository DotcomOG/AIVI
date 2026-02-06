// checkout.js - v1.1.0 - 2026-02-06 - Stripe checkout (ESM version)
import Stripe from 'stripe';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Check for Stripe key
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY not configured');
    return res.status(500).json({ error: 'Payment not configured' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { url, email, name, company, phone, tier } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Missing URL parameter' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'AIsubtext Diagnostic Report',
              description: `Comprehensive AI visibility analysis for ${url}`,
            },
            unit_amount: 50000, // $500.00 in cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${req.headers.origin || 'https://aisubtext.ai'}/full-report.html?url=${encodeURIComponent(url)}&paid=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin || 'https://aisubtext.ai'}/analyze.html?url=${encodeURIComponent(url)}&canceled=true`,
      customer_email: email || undefined,
      metadata: {
        url: url,
        name: name || '',
        company: company || '',
        email: email || '',
        phone: phone || '',
        tier: tier || 'entry'
      }
    });

    return res.status(200).json({ sessionId: session.id, url: session.url });

  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: 'Failed to create checkout session', details: err.message });
  }
}
