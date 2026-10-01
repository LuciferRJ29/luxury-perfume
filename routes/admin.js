const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authMiddleware } = require('./auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Image Upload Config
// Image Upload Config with Serverless / Vercel safe fallback
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const uploadsDir = isServerless ? path.join('/tmp', 'uploads') : path.join(__dirname, '../public/uploads');

try {
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }
} catch (e) {
    console.warn('Uploads directory creation notice:', e.message);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'perfume-' + unique + ext);
    }
});
const upload = multer({ storage });

// Admin Middleware
const adminMiddleware = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
    next();
};

router.use(authMiddleware, adminMiddleware);

// GET /dashboard
router.get('/dashboard', (req, res) => {
    try {
        const salesRow = db.prepare('SELECT SUM(total) as total FROM orders WHERE status != "cancelled"').get();
        const ordersRow = db.prepare('SELECT COUNT(*) as count FROM orders').get();
        const usersRow = db.prepare('SELECT COUNT(*) as count FROM users').get();
        const productsRow = db.prepare('SELECT COUNT(*) as count FROM products').get();

        const stats = {
            totalSales: salesRow ? (salesRow.total || 0) : 0,
            totalOrders: ordersRow ? ordersRow.count : 0,
            totalUsers: usersRow ? usersRow.count : 0,
            totalProducts: productsRow ? productsRow.count : 0,
        };

        const recentOrders = db.prepare(`
            SELECT id, customer_name, customer_email, total, status, payment_method, created_at 
            FROM orders 
            ORDER BY created_at DESC LIMIT 6
        `).all();

        const lowStock = db.prepare(`
            SELECT id, name, brand, category, stock, price, image_url 
            FROM products 
            WHERE stock <= 20 
            ORDER BY stock ASC LIMIT 10
        `).all();

        const topProducts = db.prepare(`
            SELECT p.id, p.name, p.brand, p.price, p.image_url, COALESCE(SUM(oi.quantity), 0) as sold 
            FROM products p
            LEFT JOIN order_items oi ON oi.product_id = p.id
            GROUP BY p.id 
            ORDER BY sold DESC, p.rating DESC LIMIT 5
        `).all();
        
        res.json({ stats, recentOrders, lowStock, topProducts });
    } catch (err) {
        console.error('Admin dashboard error:', err);
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// GET /products
router.get('/products', (req, res) => {
    try {
        const q = req.query.search || '';
        let sql = 'SELECT * FROM products';
        let params = [];

        if (q) {
            sql += ' WHERE name LIKE ? OR brand LIKE ? OR category LIKE ?';
            const term = `%${q}%`;
            params = [term, term, term];
        }

        sql += ' ORDER BY id DESC';
        const products = db.prepare(sql).all(...params);
        products.forEach(p => {
            p.fragrance_notes = p.fragrance_notes_json ? JSON.parse(p.fragrance_notes_json) : null;
        });

        res.json({ products, total: products.length });
    } catch (err) {
        console.error('Admin get products error:', err);
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// POST /products (Create product)
router.post('/products', upload.single('image'), (req, res) => {
    try {
        const {
            name, brand, description, price, sale_price, category, subcategory,
            gender, size_ml, stock, fragrance_notes_json, featured, bestseller, new_arrival, image_url: custom_img
        } = req.body;

        if (!name || !brand || !price) {
            return res.status(400).json({ error: 'Name, brand, and price are required' });
        }

        let image_url = custom_img || 'https://images.unsplash.com/photo-1592945403244-b3fbafd7f539?auto=format&fit=crop&w=600&q=80';
        if (req.file) {
            image_url = `/uploads/${req.file.filename}`;
        }

        const stmt = db.prepare(`
            INSERT INTO products (
                name, brand, description, price, sale_price, category, subcategory, gender,
                size_ml, stock, image_url, fragrance_notes_json, featured, bestseller, new_arrival, rating, reviews_count
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const info = stmt.run(
            name,
            brand,
            description || '',
            parseFloat(price),
            sale_price ? parseFloat(sale_price) : null,
            category || 'unisex',
            subcategory || 'Eau de Parfum',
            gender || category || 'unisex',
            parseInt(size_ml) || 100,
            parseInt(stock) || 0,
            image_url,
            typeof fragrance_notes_json === 'object' ? JSON.stringify(fragrance_notes_json) : (fragrance_notes_json || null),
            featured == '1' || featured === true || featured === 'true' ? 1 : 0,
            bestseller == '1' || bestseller === true || bestseller === 'true' ? 1 : 0,
            new_arrival == '1' || new_arrival === true || new_arrival === 'true' ? 1 : 0,
            5.0,
            1
        );

        res.status(201).json({ message: 'Product created successfully', productId: info.lastInsertRowid });
    } catch (err) {
        console.error('Admin create product error:', err);
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// PUT /products/:id (Update product)
router.put('/products/:id', upload.single('image'), (req, res) => {
    try {
        const id = req.params.id;
        const {
            name, brand, description, price, sale_price, category, subcategory,
            gender, size_ml, stock, fragrance_notes_json, featured, bestseller, new_arrival, image_url: custom_img
        } = req.body;

        const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
        if (!existing) {
            return res.status(404).json({ error: 'Product not found' });
        }

        let image_url = existing.image_url;
        if (req.file) {
            image_url = `/uploads/${req.file.filename}`;
        } else if (custom_img) {
            image_url = custom_img;
        }

        const notesVal = typeof fragrance_notes_json === 'object' 
            ? JSON.stringify(fragrance_notes_json) 
            : (fragrance_notes_json !== undefined ? fragrance_notes_json : existing.fragrance_notes_json);

        const stmt = db.prepare(`
            UPDATE products SET 
                name = COALESCE(?, name),
                brand = COALESCE(?, brand),
                description = COALESCE(?, description),
                price = COALESCE(?, price),
                sale_price = ?,
                category = COALESCE(?, category),
                subcategory = COALESCE(?, subcategory),
                gender = COALESCE(?, gender),
                size_ml = COALESCE(?, size_ml),
                stock = COALESCE(?, stock),
                image_url = COALESCE(?, image_url),
                fragrance_notes_json = ?,
                featured = COALESCE(?, featured),
                bestseller = COALESCE(?, bestseller),
                new_arrival = COALESCE(?, new_arrival)
            WHERE id = ?
        `);

        stmt.run(
            name,
            brand,
            description,
            price ? parseFloat(price) : null,
            sale_price ? parseFloat(sale_price) : null,
            category,
            subcategory,
            gender,
            size_ml ? parseInt(size_ml) : null,
            stock !== undefined ? parseInt(stock) : null,
            image_url,
            notesVal,
            featured !== undefined ? (featured == '1' || featured === true || featured === 'true' ? 1 : 0) : null,
            bestseller !== undefined ? (bestseller == '1' || bestseller === true || bestseller === 'true' ? 1 : 0) : null,
            new_arrival !== undefined ? (new_arrival == '1' || new_arrival === true || new_arrival === 'true' ? 1 : 0) : null,
            id
        );

        res.json({ message: 'Product updated successfully' });
    } catch (err) {
        console.error('Admin update product error:', err);
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// PATCH /products/:id/stock (Quick stock adjustment)
router.patch('/products/:id/stock', (req, res) => {
    try {
        const { stock, delta } = req.body;
        const id = req.params.id;

        if (stock !== undefined) {
            db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(parseInt(stock), id);
        } else if (delta !== undefined) {
            db.prepare('UPDATE products SET stock = MAX(0, stock + ?) WHERE id = ?').run(parseInt(delta), id);
        } else {
            return res.status(400).json({ error: 'Provide stock or delta' });
        }

        const updated = db.prepare('SELECT id, stock FROM products WHERE id = ?').get(id);
        res.json({ message: 'Stock updated', product: updated });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// DELETE /products/:id
router.delete('/products/:id', (req, res) => {
    try {
        const id = req.params.id;
        db.transaction(() => {
            db.prepare('DELETE FROM cart WHERE product_id = ?').run(id);
            db.prepare('DELETE FROM wishlists WHERE product_id = ?').run(id);
            db.prepare('DELETE FROM reviews WHERE product_id = ?').run(id);
            db.prepare('DELETE FROM products WHERE id = ?').run(id);
        })();
        res.json({ message: 'Product deleted successfully' });
    } catch (err) {
        console.error('Admin delete product error:', err);
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// GET /orders
router.get('/orders', (req, res) => {
    try {
        const orders = db.prepare(`
            SELECT o.*, 
                COALESCE(o.customer_name, u.name, 'Customer') as customer_name,
                COALESCE(o.customer_email, u.email, 'guest@luxuryperfume.com') as customer_email,
                COALESCE(o.customer_phone, u.phone, 'N/A') as customer_phone,
                (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as items_count
            FROM orders o
            LEFT JOIN users u ON o.user_id = u.id
            ORDER BY o.created_at DESC
        `).all();
        res.json(orders);
    } catch (err) {
        console.error('Admin get orders error:', err);
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// GET /orders/:id
router.get('/orders/:id', (req, res) => {
    try {
        const order = db.prepare(`
            SELECT o.*, 
                COALESCE(o.customer_name, u.name, 'Customer') as customer_name,
                COALESCE(o.customer_email, u.email, 'guest@luxuryperfume.com') as customer_email,
                COALESCE(o.customer_phone, u.phone, 'N/A') as customer_phone
            FROM orders o
            LEFT JOIN users u ON o.user_id = u.id
            WHERE o.id = ?
        `).get(req.params.id);

        if (!order) return res.status(404).json({ error: 'Order not found' });

        const items = db.prepare(`
            SELECT oi.*, p.name, p.brand, p.image_url 
            FROM order_items oi
            LEFT JOIN products p ON oi.product_id = p.id
            WHERE oi.order_id = ?
        `).all(req.params.id);

        res.json({ order, items });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// PUT /orders/:id (Update order status and tracking)
router.put('/orders/:id', (req, res) => {
    try {
        const { status, payment_status, tracking_number } = req.body;
        const id = parseInt(req.params.id);

        const info = db.prepare(`
            UPDATE orders SET 
                status = COALESCE(?, status), 
                payment_status = COALESCE(?, payment_status), 
                tracking_number = COALESCE(?, tracking_number), 
                updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `).run(
            status !== undefined ? status : null,
            payment_status !== undefined ? payment_status : null,
            tracking_number !== undefined ? tracking_number : null,
            id
        );

        if (info.changes === 0) return res.status(404).json({ error: 'Order not found' });
        res.json({ message: 'Order updated successfully' });
    } catch (err) {
        console.error('Update order error:', err);
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// GET /users
router.get('/users', (req, res) => {
    try {
        const users = db.prepare(`
            SELECT u.id, u.name, u.email, u.role, u.phone, u.address, u.created_at,
                   (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as order_count,
                   COALESCE((SELECT SUM(total) FROM orders WHERE user_id = u.id), 0) as total_spent
            FROM users u 
            ORDER BY u.created_at DESC
        `).all();
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// PUT /users/:id/role
router.put('/users/:id/role', (req, res) => {
    try {
        const { role } = req.body;
        if (role !== 'admin' && role !== 'user') return res.status(400).json({ error: 'Invalid role' });
        const info = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ message: 'User role updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// DELETE /users/:id
router.delete('/users/:id', (req, res) => {
    try {
        const id = req.params.id;
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete yourself' });
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
        res.json({ message: 'User deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// GET /coupons
router.get('/coupons', (req, res) => {
    try {
        const coupons = db.prepare('SELECT * FROM coupons ORDER BY id DESC').all();
        res.json(coupons);
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// POST /coupons
router.post('/coupons', (req, res) => {
    try {
        const { code, discount_percent, min_order, max_uses, active, expires_at } = req.body;
        if (!code || !discount_percent) {
            return res.status(400).json({ error: 'Code and discount percentage are required' });
        }
        const info = db.prepare(`
            INSERT INTO coupons (code, discount_percent, min_order, max_uses, active, expires_at) 
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            code.toUpperCase().trim(),
            parseFloat(discount_percent),
            parseFloat(min_order) || 0,
            max_uses ? parseInt(max_uses) : null,
            active === undefined ? 1 : (active ? 1 : 0),
            expires_at || null
        );
        res.status(201).json({ message: 'Coupon created successfully', couponId: info.lastInsertRowid });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// DELETE /coupons/:id
router.delete('/coupons/:id', (req, res) => {
    try {
        const info = db.prepare('DELETE FROM coupons WHERE id = ?').run(req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'Coupon not found' });
        res.json({ message: 'Coupon deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// GET /settings
router.get('/settings', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM settings').all();
        const settings = {};
        rows.forEach(r => settings[r.key] = r.value);
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// PUT /settings
router.put('/settings', (req, res) => {
    try {
        const settings = req.body;
        const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        db.transaction(() => {
            for (const [key, value] of Object.entries(settings)) {
                stmt.run(key, String(value));
            }
        })();
        res.json({ message: 'Settings saved successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

// GET /analytics
router.get('/analytics', (req, res) => {
    try {
        const categoryData = db.prepare(`
            SELECT category, COUNT(*) as count 
            FROM products 
            GROUP BY category
        `).all();

        const ordersByStatus = db.prepare(`
            SELECT status, COUNT(*) as count 
            FROM orders 
            GROUP BY status
        `).all();

        res.json({ categoryData, ordersByStatus });
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

module.exports = router;
