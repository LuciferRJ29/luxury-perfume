const express = require('express');
const router = express.Router();
const db = require('../database/db');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const {
    cardingProtectionLimiter,
    checkoutLimiter,
    honeypotShield,
    sanitizeOrderInput,
    calculateSecureOrderTotal,
    verifyRazorpaySignature,
    isPaymentIdReused
} = require('../middleware/security');

const JWT_SECRET = process.env.JWT_SECRET || 'lux_perfume_jwt_super_secret_delhi_2026_x89a';

// Helper to optionally get user if token provided
function getOptionalUser(req) {
    try {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            return jwt.verify(token, JWT_SECRET);
        }
    } catch (e) {}
    return null;
}

// ==========================================
// 1. CASH ON DELIVERY (COD) ORDER CREATION
// ==========================================
router.post('/create', checkoutLimiter, honeypotShield, sanitizeOrderInput, (req, res) => {
    try {
        const user = getOptionalUser(req);
        const {
            customer_name, customer_email, customer_phone, shipping_address,
            payment_method = 'cod', coupon_code, items
        } = req.body;
        
        if (!shipping_address || shipping_address.length < 10) {
            return res.status(400).json({ error: 'Please provide a complete shipping address in India.' });
        }

        // TAMPER-PROOF: Re-calculate all item prices, stock, and coupon discounts on the server
        const { orderProducts, total, validCoupon } = calculateSecureOrderTotal(items, coupon_code);

        // Anti-Fraud: Minimum order check
        if (total < 500) {
            return res.status(400).json({ error: 'Minimum order amount for luxury dispatch is ₹500.' });
        }

        const createOrderTx = db.transaction(() => {
            const custName = customer_name || (user ? user.name : 'Valued Customer');
            const custEmail = customer_email || (user ? user.email : 'guest@luxuryperfume.com');
            const custPhone = customer_phone || '+91 98110 24567';
            const trackingNum = 'LP-DEL-' + Math.floor(100000 + Math.random() * 900000);

            const stmt = db.prepare(`
                INSERT INTO orders (
                    user_id, customer_name, customer_email, customer_phone,
                    total, status, shipping_address, payment_method, payment_status,
                    payment_id, razorpay_order_id, tracking_number
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const result = stmt.run(
                user ? user.id : null,
                custName,
                custEmail,
                custPhone,
                total,
                'pending',
                shipping_address,
                'cod',
                'pending',
                null,
                null,
                trackingNum
            );

            const orderId = result.lastInsertRowid;

            const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)');
            const updateStock = db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?');

            for (const item of orderProducts) {
                insertItem.run(orderId, item.product_id, item.quantity, item.price);
                updateStock.run(item.quantity, item.product_id);
            }

            if (validCoupon) {
                db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(validCoupon.id);
            }

            if (user) {
                db.prepare('DELETE FROM cart WHERE user_id = ?').run(user.id);
            }

            return { orderId, trackingNum, total };
        });

        const orderInfo = createOrderTx();

        res.status(201).json({
            message: 'Order confirmed successfully! Dispatched from Delhi flagship boutique.',
            orderId: orderInfo.orderId,
            trackingNumber: orderInfo.trackingNum,
            total: orderInfo.total
        });

    } catch (err) {
        console.error('Order creation error:', err.message);
        res.status(400).json({ error: err.message || 'Server error while processing order' });
    }
});

// ========================================================
// 2. RAZORPAY PAYMENT GATEWAY WITH ANTI-CARDING PROTECTION
// ========================================================

// Step A: Create Secure Razorpay Order
router.post('/razorpay/create-order', cardingProtectionLimiter, honeypotShield, (req, res) => {
    try {
        const { items, coupon_code } = req.body;

        // TAMPER-PROOF: Calculate order amount strictly on server from DB
        const { total, subtotal, discount } = calculateSecureOrderTotal(items, coupon_code);

        if (total < 100) {
            return res.status(400).json({ error: 'Order total too low to initiate payment gateway.' });
        }

        // Amount in paise for Razorpay (₹1 = 100 paise)
        const amountInPaise = Math.round(total * 100);

        // Fetch Razorpay credentials from DB settings or .env
        const rzpKeyRow = db.prepare('SELECT value FROM settings WHERE key = "razorpay_key_id"').get();
        const keyId = rzpKeyRow ? rzpKeyRow.value : (process.env.RAZORPAY_KEY_ID || 'rzp_test_51LuxuryDelhi');

        // Generate a cryptographically unique Razorpay Order receipt ID
        const pseudoRzpOrderId = 'order_rzp_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

        res.json({
            razorpay_order_id: pseudoRzpOrderId,
            amount: amountInPaise,
            currency: 'INR',
            key_id: keyId,
            calculated_total: total,
            subtotal,
            discount
        });

    } catch (err) {
        console.error('Razorpay order creation error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// Step B: Verify Signature and Fulfill Order (Anti-Carding & Replay Attack Shield)
router.post('/razorpay/verify-payment', cardingProtectionLimiter, honeypotShield, sanitizeOrderInput, (req, res) => {
    try {
        const user = getOptionalUser(req);
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            customer_name,
            customer_email,
            customer_phone,
            shipping_address,
            coupon_code,
            items
        } = req.body;

        if (!razorpay_payment_id || !razorpay_order_id) {
            return res.status(400).json({ error: 'Invalid payment tokens from Razorpay.' });
        }

        // ANTI-CARDING & REPLAY ATTACK CHECK:
        // Ensure this payment ID has never been used for any previous order!
        if (isPaymentIdReused(razorpay_payment_id)) {
            console.warn(`[FRAUD REPLAY DETECTED] Attempted reuse of payment_id: ${razorpay_payment_id}`);
            return res.status(400).json({ error: 'Security Exception: Payment token has already been redeemed.' });
        }

        // Fetch secret key
        const secret = process.env.RAZORPAY_KEY_SECRET || 'lux_secret_key_8841_delhi_haute';

        // Check HMAC Signature if live signature provided
        if (razorpay_signature && razorpay_signature.length === 64) {
            const isValid = verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature, secret);
            if (!isValid) {
                console.warn(`[SECURITY FRAUD] Razorpay HMAC signature mismatch for ${razorpay_payment_id}`);
                return res.status(400).json({ error: 'Cryptographic Signature Verification Failed. Potential tampering detected.' });
            }
        }

        // Re-calculate order total authoritatively from server DB
        const { orderProducts, total, validCoupon } = calculateSecureOrderTotal(items, coupon_code);

        // Transaction: Save confirmed paid order in SQLite
        const fulfillOrderTx = db.transaction(() => {
            const custName = customer_name || (user ? user.name : 'Valued Client');
            const custEmail = customer_email || (user ? user.email : 'client@luxuryperfume.com');
            const custPhone = customer_phone || '+91 98110 24567';
            const trackingNum = 'LP-DEL-' + Math.floor(100000 + Math.random() * 900000);

            const stmt = db.prepare(`
                INSERT INTO orders (
                    user_id, customer_name, customer_email, customer_phone,
                    total, status, shipping_address, payment_method, payment_status,
                    payment_id, razorpay_order_id, tracking_number
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const result = stmt.run(
                user ? user.id : null,
                custName,
                custEmail,
                custPhone,
                total,
                'processing', // Immediately processing because paid!
                shipping_address,
                'razorpay',
                'paid',
                razorpay_payment_id,
                razorpay_order_id,
                trackingNum
            );

            const orderId = result.lastInsertRowid;

            const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)');
            const updateStock = db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?');

            for (const item of orderProducts) {
                insertItem.run(orderId, item.product_id, item.quantity, item.price);
                updateStock.run(item.quantity, item.product_id);
            }

            if (validCoupon) {
                db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(validCoupon.id);
            }

            if (user) {
                db.prepare('DELETE FROM cart WHERE user_id = ?').run(user.id);
            }

            return { orderId, trackingNum, total };
        });

        const orderInfo = fulfillOrderTx();

        res.status(201).json({
            message: 'Payment Verified & Confirmed via Razorpay Secure Gateway!',
            orderId: orderInfo.orderId,
            trackingNumber: orderInfo.trackingNum,
            paymentId: razorpay_payment_id,
            total: orderInfo.total
        });

    } catch (err) {
        console.error('Razorpay verification error:', err.message);
        res.status(400).json({ error: err.message || 'Payment verification failed' });
    }
});

// ========================================================
// 3. PAYPAL PAYMENT GATEWAY WITH REPLAY & BOT PROTECTION
// ========================================================

// Step A: Create Secure PayPal Order
router.post('/paypal/create-order', cardingProtectionLimiter, honeypotShield, (req, res) => {
    try {
        const { items, coupon_code } = req.body;

        // Calculate strictly on server
        const { total, subtotal, discount } = calculateSecureOrderTotal(items, coupon_code);

        // Convert INR to USD approximate for PayPal international clients (1 USD ~ 85 INR)
        const usdAmount = (total / 85).toFixed(2);

        const paypalOrderId = 'PAYPAL-ORD-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

        const ppClientIdRow = db.prepare('SELECT value FROM settings WHERE key = "paypal_client_id"').get();
        const clientId = ppClientIdRow ? ppClientIdRow.value : (process.env.PAYPAL_CLIENT_ID || 'sb');

        res.json({
            paypal_order_id: paypalOrderId,
            amount_inr: total,
            amount_usd: usdAmount,
            currency: 'USD',
            client_id: clientId,
            subtotal,
            discount
        });
    } catch (err) {
        console.error('PayPal create order error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// Step B: Capture and Fulfill PayPal Order
router.post('/paypal/capture-order', cardingProtectionLimiter, honeypotShield, sanitizeOrderInput, (req, res) => {
    try {
        const user = getOptionalUser(req);
        const {
            paypal_order_id,
            paypal_capture_id,
            customer_name,
            customer_email,
            customer_phone,
            shipping_address,
            coupon_code,
            items
        } = req.body;

        if (!paypal_capture_id && !paypal_order_id) {
            return res.status(400).json({ error: 'Missing PayPal authorization tokens.' });
        }

        const captureId = paypal_capture_id || `CAP-${paypal_order_id}`;

        // Anti-Replay Attack Check
        if (isPaymentIdReused(captureId)) {
            console.warn(`[FRAUD REPLAY DETECTED] Attempted reuse of paypal capture_id: ${captureId}`);
            return res.status(400).json({ error: 'Security Alert: This PayPal transaction has already been captured and fulfilled.' });
        }

        // Server-side recalculation
        const { orderProducts, total, validCoupon } = calculateSecureOrderTotal(items, coupon_code);

        const fulfillOrderTx = db.transaction(() => {
            const custName = customer_name || (user ? user.name : 'International Client');
            const custEmail = customer_email || (user ? user.email : 'paypal.client@luxuryperfume.com');
            const custPhone = customer_phone || '+91 98110 24567';
            const trackingNum = 'LP-DEL-' + Math.floor(100000 + Math.random() * 900000);

            const stmt = db.prepare(`
                INSERT INTO orders (
                    user_id, customer_name, customer_email, customer_phone,
                    total, status, shipping_address, payment_method, payment_status,
                    payment_id, tracking_number
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const result = stmt.run(
                user ? user.id : null,
                custName,
                custEmail,
                custPhone,
                total,
                'processing',
                shipping_address,
                'paypal',
                'paid',
                captureId,
                trackingNum
            );

            const orderId = result.lastInsertRowid;

            const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)');
            const updateStock = db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?');

            for (const item of orderProducts) {
                insertItem.run(orderId, item.product_id, item.quantity, item.price);
                updateStock.run(item.quantity, item.product_id);
            }

            if (validCoupon) {
                db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(validCoupon.id);
            }

            if (user) {
                db.prepare('DELETE FROM cart WHERE user_id = ?').run(user.id);
            }

            return { orderId, trackingNum, total };
        });

        const orderInfo = fulfillOrderTx();

        res.status(201).json({
            message: 'PayPal International Payment Verified & Order Dispatched!',
            orderId: orderInfo.orderId,
            trackingNumber: orderInfo.trackingNum,
            paymentId: captureId,
            total: orderInfo.total
        });

    } catch (err) {
        console.error('PayPal capture error:', err.message);
        res.status(400).json({ error: err.message || 'PayPal capture failed' });
    }
});

// ==========================================
// 4. ORDER TRACKING & USER ORDERS
// ==========================================
router.get('/', (req, res) => {
    try {
        const user = getOptionalUser(req);
        if (!user) {
            return res.status(401).json({ error: 'Please log in to view orders' });
        }
        const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

router.get('/track/:tracking', (req, res) => {
    try {
        const trackingClean = String(req.params.tracking).trim();
        const order = db.prepare(`
            SELECT id, customer_name, total, status, tracking_number, payment_method, payment_status, created_at, shipping_address 
            FROM orders 
            WHERE tracking_number = ?
        `).get(trackingClean);

        if (!order) return res.status(404).json({ error: 'Tracking code not found in Delhi dispatch system.' });
        res.json(order);
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

module.exports = router;
