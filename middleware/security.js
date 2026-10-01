const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const db = require('../database/db');

// 1. Anti-Carding Velocity Limiter (Blocks automated card testing bots)
// Carding bots fire hundreds of stolen credit card requests in seconds.
// This limits any IP to a strict 5 payment attempts per 15 minutes.
const cardingProtectionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 6, // Max 6 payment initialization/verification requests
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Security Warning: Anti-Fraud Shield activated. Too many payment attempts from this IP address. Please wait 15 minutes or contact support at stddeepanshu@aol.com.',
        code: 'FRAUD_VELOCITY_BLOCKED'
    }
});

// 2. Checkout Order Rate Limiter
const checkoutLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20, // Max 20 checkout attempts per hour
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Too many orders attempted from this device. Please try again later.',
        code: 'ORDER_RATE_LIMIT'
    }
});

// 3. Auth Brute Force Limiter
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10, // Max 10 login/register attempts
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'Too many login attempts. Account temporarily throttled for security.',
        code: 'AUTH_THROTTLED'
    }
});

// 4. Honeypot Bot Shield
// Bots automatically fill all form fields. If the hidden 'website_hp' field is populated, it is 100% a bot.
function honeypotShield(req, res, next) {
    if (req.body && req.body.website_hp) {
        console.warn(`[SECURITY ALERT] Bot/Carding honeypot triggered from IP: ${req.ip}`);
        return res.status(400).json({ error: 'Automated request detected and blocked by Luxury Perfume Security Shield.' });
    }
    next();
}

// 5. Input Sanitizer (Prevents Stored XSS & Script Injection)
function sanitizeText(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .trim();
}

function sanitizeOrderInput(req, res, next) {
    if (req.body) {
        if (req.body.customer_name) req.body.customer_name = sanitizeText(req.body.customer_name);
        if (req.body.customer_email) req.body.customer_email = sanitizeText(req.body.customer_email);
        if (req.body.customer_phone) req.body.customer_phone = sanitizeText(req.body.customer_phone);
        if (req.body.shipping_address) req.body.shipping_address = sanitizeText(req.body.shipping_address);
    }
    next();
}

// 6. Server-Side Price Verification (Tamper-Proof Calculation)
// Prevents client-side price manipulation hacking (e.g. changing ₹25,000 to ₹1 in DevTools)
function calculateSecureOrderTotal(items, couponCode) {
    if (!items || !Array.isArray(items) || items.length === 0) {
        throw new Error('Your cart is empty');
    }

    let orderProducts = [];
    let subtotal = 0;

    for (const it of items) {
        const prodId = parseInt(it.id || it.product_id);
        const qty = Math.min(Math.max(parseInt(it.quantity || it.qty || 1), 1), 20); // enforce 1 to 20 qty

        // Fetch authoritative price directly from database
        const prod = db.prepare('SELECT id, name, price, sale_price, stock FROM products WHERE id = ?').get(prodId);
        if (!prod) {
            throw new Error(`Invalid or unavailable perfume SKU (ID: ${prodId})`);
        }
        if (qty > prod.stock) {
            throw new Error(`Not enough stock available for ${prod.name}. Available: ${prod.stock}`);
        }

        const unitPrice = (prod.sale_price && prod.sale_price > 0) ? prod.sale_price : prod.price;
        const itemTotal = unitPrice * qty;

        subtotal += itemTotal;
        orderProducts.push({
            product_id: prod.id,
            name: prod.name,
            quantity: qty,
            price: unitPrice,
            stock: prod.stock
        });
    }

    // Verify and apply discount coupon from SQLite
    let discount = 0;
    let validCoupon = null;

    if (couponCode) {
        const codeClean = String(couponCode).toUpperCase().trim();
        const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? AND active = 1').get(codeClean);
        if (coupon && subtotal >= coupon.min_order) {
            discount = (subtotal * coupon.discount_percent) / 100;
            validCoupon = coupon;
        }
    }

    const total = Math.max(0, subtotal - discount);

    return {
        orderProducts,
        subtotal,
        discount,
        total,
        validCoupon
    };
}

// 7. Cryptographic HMAC SHA256 Signature Verification for Razorpay
function verifyRazorpaySignature(orderId, paymentId, signature, secret) {
    const keySecret = secret || process.env.RAZORPAY_KEY_SECRET || 'lux_secret_key_8841_delhi_haute';
    const body = orderId + '|' + paymentId;
    const expectedSignature = crypto
        .createHmac('sha256', keySecret)
        .update(body.toString())
        .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));
}

// 8. Replay Attack Shield (Ensures no payment ID is ever reused)
function isPaymentIdReused(paymentId) {
    if (!paymentId) return false;
    const existing = db.prepare('SELECT id FROM orders WHERE payment_id = ?').get(paymentId);
    return !!existing;
}

module.exports = {
    cardingProtectionLimiter,
    checkoutLimiter,
    authLimiter,
    honeypotShield,
    sanitizeOrderInput,
    calculateSecureOrderTotal,
    verifyRazorpaySignature,
    isPaymentIdReused
};
