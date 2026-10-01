const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database/db');
const { authLimiter } = require('../middleware/security');

const JWT_SECRET = process.env.JWT_SECRET || 'lux_perfume_jwt_super_secret_delhi_2026_x89a';

// Auth Middleware
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
};

// POST /register
router.post('/register', authLimiter, (req, res) => {
    try {
        const { name, email, password, phone, address } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required' });
        }
        
        const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const hash = bcrypt.hashSync(password, 10);
        const stmt = db.prepare('INSERT INTO users (name, email, password_hash, phone, address) VALUES (?, ?, ?, ?, ?)');
        const result = stmt.run(name, email, hash, phone || null, address || null);

        res.status(201).json({ message: 'User registered successfully', userId: result.lastInsertRowid });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// POST /login
router.post('/login', authLimiter, (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (!user || !bcrypt.compareSync(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            message: 'Login successful',
            token,
            user: { id: user.id, name: user.name, email: user.email, role: user.role }
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// GET /profile
router.get('/profile', authMiddleware, (req, res) => {
    try {
        const user = db.prepare('SELECT id, name, email, role, phone, address, created_at FROM users WHERE id = ?').get(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// PUT /profile
router.put('/profile', authMiddleware, (req, res) => {
    try {
        const { name, phone, address } = req.body;
        const stmt = db.prepare('UPDATE users SET name = COALESCE(?, name), phone = COALESCE(?, phone), address = COALESCE(?, address) WHERE id = ?');
        stmt.run(name, phone, address, req.user.id);
        res.json({ message: 'Profile updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

module.exports = router;
module.exports.authMiddleware = authMiddleware;
