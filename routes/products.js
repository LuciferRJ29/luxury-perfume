const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authMiddleware } = require('./auth');

// GET / - List all products with filtering
router.get('/', (req, res) => {
    try {
        let query = 'SELECT * FROM products WHERE 1=1';
        const params = [];

        if (req.query.category) {
            query += ' AND category = ?';
            params.push(req.query.category);
        }
        if (req.query.brand) {
            query += ' AND brand = ?';
            params.push(req.query.brand);
        }
        if (req.query.gender) {
            query += ' AND gender = ?';
            params.push(req.query.gender);
        }
        if (req.query.minPrice) {
            query += ' AND price >= ?';
            params.push(req.query.minPrice);
        }
        if (req.query.maxPrice) {
            query += ' AND price <= ?';
            params.push(req.query.maxPrice);
        }
        
        if (req.query.sort === 'price_asc') {
            query += ' ORDER BY price ASC';
        } else if (req.query.sort === 'price_desc') {
            query += ' ORDER BY price DESC';
        } else if (req.query.sort === 'newest') {
            query += ' ORDER BY created_at DESC';
        } else {
            query += ' ORDER BY created_at DESC';
        }

        const products = db.prepare(query).all(...params);
        products.forEach(p => p.fragrance_notes = p.fragrance_notes_json ? JSON.parse(p.fragrance_notes_json) : null);
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// GET /featured
router.get('/featured', (req, res) => {
    try {
        const products = db.prepare('SELECT * FROM products WHERE featured = 1 ORDER BY created_at DESC LIMIT 10').all();
        products.forEach(p => p.fragrance_notes = p.fragrance_notes_json ? JSON.parse(p.fragrance_notes_json) : null);
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// GET /bestsellers
router.get('/bestsellers', (req, res) => {
    try {
        const products = db.prepare('SELECT * FROM products WHERE bestseller = 1 ORDER BY created_at DESC LIMIT 10').all();
        products.forEach(p => p.fragrance_notes = p.fragrance_notes_json ? JSON.parse(p.fragrance_notes_json) : null);
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// GET /new-arrivals
router.get('/new-arrivals', (req, res) => {
    try {
        const products = db.prepare('SELECT * FROM products WHERE new_arrival = 1 ORDER BY created_at DESC LIMIT 10').all();
        products.forEach(p => p.fragrance_notes = p.fragrance_notes_json ? JSON.parse(p.fragrance_notes_json) : null);
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// GET /search?q=
router.get('/search', (req, res) => {
    try {
        const q = req.query.q;
        if (!q) return res.json([]);
        const products = db.prepare('SELECT * FROM products WHERE name LIKE ? OR brand LIKE ? OR description LIKE ?').all(`%${q}%`, `%${q}%`, `%${q}%`);
        products.forEach(p => p.fragrance_notes = p.fragrance_notes_json ? JSON.parse(p.fragrance_notes_json) : null);
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// GET /:id
router.get('/:id', (req, res) => {
    try {
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
        if (!product) return res.status(404).json({ error: 'Product not found' });
        product.fragrance_notes = product.fragrance_notes_json ? JSON.parse(product.fragrance_notes_json) : null;
        res.json(product);
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// GET /:id/reviews
router.get('/:id/reviews', (req, res) => {
    try {
        const reviews = db.prepare(`
            SELECT r.*, u.name as user_name 
            FROM reviews r 
            JOIN users u ON r.user_id = u.id 
            WHERE r.product_id = ? 
            ORDER BY r.created_at DESC
        `).all(req.params.id);
        res.json(reviews);
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// POST /:id/reviews
router.post('/:id/reviews', authMiddleware, (req, res) => {
    try {
        const { rating, comment } = req.body;
        const productId = req.params.id;
        
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Rating must be between 1 and 5' });
        }

        db.prepare('INSERT INTO reviews (user_id, product_id, rating, comment) VALUES (?, ?, ?, ?)').run(req.user.id, productId, rating, comment);
        
        // Update product rating
        const stats = db.prepare('SELECT AVG(rating) as avg, COUNT(id) as count FROM reviews WHERE product_id = ?').get(productId);
        db.prepare('UPDATE products SET rating = ?, reviews_count = ? WHERE id = ?').run(stats.avg, stats.count, productId);

        res.status(201).json({ message: 'Review added successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

module.exports = router;
