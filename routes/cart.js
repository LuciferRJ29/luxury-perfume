const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authMiddleware } = require('./auth');

router.use(authMiddleware);

// GET / - Get cart items
router.get('/', (req, res) => {
    try {
        const items = db.prepare(`
            SELECT c.id as cart_item_id, c.quantity, p.* 
            FROM cart c 
            JOIN products p ON c.product_id = p.id 
            WHERE c.user_id = ?
        `).all(req.user.id);
        
        items.forEach(p => p.fragrance_notes = p.fragrance_notes_json ? JSON.parse(p.fragrance_notes_json) : null);
        
        let subtotal = 0;
        items.forEach(item => subtotal += item.price * item.quantity);

        res.json({ items, subtotal });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// POST /add - Add to cart
router.post('/add', (req, res) => {
    try {
        const { product_id, quantity = 1 } = req.body;
        
        if (!product_id) return res.status(400).json({ error: 'product_id is required' });

        const product = db.prepare('SELECT id, stock FROM products WHERE id = ?').get(product_id);
        if (!product) return res.status(404).json({ error: 'Product not found' });
        
        const existing = db.prepare('SELECT id, quantity FROM cart WHERE user_id = ? AND product_id = ?').get(req.user.id, product_id);
        
        if (existing) {
            const newQty = existing.quantity + parseInt(quantity);
            if (newQty > product.stock) return res.status(400).json({ error: 'Not enough stock' });
            db.prepare('UPDATE cart SET quantity = ? WHERE id = ?').run(newQty, existing.id);
        } else {
            if (quantity > product.stock) return res.status(400).json({ error: 'Not enough stock' });
            db.prepare('INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)').run(req.user.id, product_id, quantity);
        }
        
        res.json({ message: 'Added to cart' });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// PUT /update/:id - Update quantity
router.put('/update/:id', (req, res) => {
    try {
        const cartItemId = req.params.id;
        const { quantity } = req.body;
        
        if (!quantity || quantity < 1) return res.status(400).json({ error: 'Valid quantity is required' });

        const cartItem = db.prepare('SELECT c.*, p.stock FROM cart c JOIN products p ON c.product_id = p.id WHERE c.id = ? AND c.user_id = ?').get(cartItemId, req.user.id);
        
        if (!cartItem) return res.status(404).json({ error: 'Cart item not found' });
        if (quantity > cartItem.stock) return res.status(400).json({ error: 'Not enough stock' });

        db.prepare('UPDATE cart SET quantity = ? WHERE id = ?').run(quantity, cartItemId);
        res.json({ message: 'Cart updated' });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// DELETE /remove/:id - Remove from cart
router.delete('/remove/:id', (req, res) => {
    try {
        db.prepare('DELETE FROM cart WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
        res.json({ message: 'Item removed from cart' });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// DELETE /clear - Clear cart
router.delete('/clear', (req, res) => {
    try {
        db.prepare('DELETE FROM cart WHERE user_id = ?').run(req.user.id);
        res.json({ message: 'Cart cleared' });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// POST /apply-coupon
router.post('/apply-coupon', (req, res) => {
    try {
        const { code, subtotal } = req.body;
        if (!code || !subtotal) return res.status(400).json({ error: 'Code and subtotal are required' });

        const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? AND active = 1 AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)').get(code);
        
        if (!coupon) return res.status(404).json({ error: 'Invalid or expired coupon' });
        if (subtotal < coupon.min_order) return res.status(400).json({ error: `Minimum order amount for this coupon is ₹${coupon.min_order}` });
        if (coupon.max_uses && coupon.used_count >= coupon.max_uses) return res.status(400).json({ error: 'Coupon usage limit reached' });

        const discountAmount = (subtotal * coupon.discount_percent) / 100;
        res.json({ message: 'Coupon applied', discountAmount, newTotal: subtotal - discountAmount });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

module.exports = router;
