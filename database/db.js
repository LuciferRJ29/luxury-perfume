const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const bundledDbPath = path.join(__dirname, 'luxescent.db');
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
const writableDbPath = isServerless ? path.join('/tmp', 'luxescent.db') : bundledDbPath;

// Wrapper that mimics better-sqlite3 API using sql.js
const wrapper = {
    _db: null,
    _inTransaction: false,

    async init() {
        const localWasm = path.join(__dirname, 'sql-wasm.wasm');
        const nodeModulesWasm = path.join(__dirname, '../node_modules/sql.js/dist/sql-wasm.wasm');
        let wasmPath = null;
        if (fs.existsSync(localWasm)) {
            wasmPath = localWasm;
        } else if (fs.existsSync(nodeModulesWasm)) {
            wasmPath = nodeModulesWasm;
        }

        const SQL = await initSqlJs(wasmPath ? { locateFile: () => wasmPath } : {});
        let dbSourcePath = null;

        if (isServerless) {
            try {
                if (!fs.existsSync(writableDbPath) && fs.existsSync(bundledDbPath)) {
                    fs.copyFileSync(bundledDbPath, writableDbPath);
                }
            } catch (err) {
                console.warn('Vercel /tmp copy warning:', err.message);
            }
            if (fs.existsSync(writableDbPath)) {
                dbSourcePath = writableDbPath;
            } else if (fs.existsSync(bundledDbPath)) {
                dbSourcePath = bundledDbPath;
            }
        } else {
            if (fs.existsSync(bundledDbPath)) {
                dbSourcePath = bundledDbPath;
            }
        }

        if (dbSourcePath) {
            const buffer = fs.readFileSync(dbSourcePath);
            this._db = new SQL.Database(buffer);
        } else {
            this._db = new SQL.Database();
        }

        this.pragma('foreign_keys = ON');
        this._createTables();
        this._seedData();
        this._save();
        console.log('Database initialized successfully for Luxury Perfume (Protected with Anti-Fraud Shield)!');
    },

    _save() {
        if (this._db) {
            try {
                const data = this._db.export();
                const buffer = Buffer.from(data);
                const target = isServerless ? writableDbPath : bundledDbPath;
                fs.writeFileSync(target, buffer);
            } catch (err) {
                // In serverless / read-only filesystem environments, preserve state in-memory safely
                console.warn('[DB SAVE NOTICE] Could not persist to disk, keeping in-memory:', err.message);
            }
        }
    },

    pragma(statement) {
        if (this._db) {
            this._db.run(`PRAGMA ${statement}`);
        }
    },

    exec(sql) {
        this._db.run(sql);
        if (!this._inTransaction) this._save();
    },

    prepare(sql) {
        const self = this;
        return {
            run(...params) {
                const cleanParams = params.map(p => (p === undefined ? null : p));
                self._db.run(sql, cleanParams);
                if (!self._inTransaction) self._save();
                const lastIdResult = self._db.exec("SELECT last_insert_rowid()");
                const lastInsertRowid = lastIdResult.length ? lastIdResult[0].values[0][0] : 0;
                const changes = self._db.getRowsModified();
                return { changes, lastInsertRowid };
            },
            get(...params) {
                let result = undefined;
                try {
                    const cleanParams = params.map(p => (p === undefined ? null : p));
                    const stmt = self._db.prepare(sql);
                    if (cleanParams.length > 0) stmt.bind(cleanParams);
                    if (stmt.step()) {
                        const columns = stmt.getColumnNames();
                        const values = stmt.get();
                        result = {};
                        columns.forEach((col, i) => result[col] = values[i]);
                    }
                    stmt.free();
                } catch (e) {
                    console.error('DB get error:', e.message, 'SQL:', sql);
                    throw e;
                }
                return result;
            },
            all(...params) {
                const rows = [];
                try {
                    const cleanParams = params.map(p => (p === undefined ? null : p));
                    const stmt = self._db.prepare(sql);
                    if (cleanParams.length > 0) stmt.bind(cleanParams);
                    while (stmt.step()) {
                        const columns = stmt.getColumnNames();
                        const values = stmt.get();
                        const row = {};
                        columns.forEach((col, i) => row[col] = values[i]);
                        rows.push(row);
                    }
                    stmt.free();
                } catch (e) {
                    console.error('DB all error:', e.message, 'SQL:', sql);
                    throw e;
                }
                return rows;
            }
        };
    },

    transaction(fn) {
        const self = this;
        return (...args) => {
            self._db.run('BEGIN TRANSACTION');
            self._inTransaction = true;
            try {
                const result = fn(...args);
                self._db.run('COMMIT');
                self._inTransaction = false;
                self._save();
                return result;
            } catch (e) {
                self._db.run('ROLLBACK');
                self._inTransaction = false;
                throw e;
            }
        };
    },

    _createTables() {
        this._db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT DEFAULT 'user',
                phone TEXT,
                address TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        this._db.run(`
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                brand TEXT NOT NULL,
                description TEXT,
                price REAL NOT NULL,
                sale_price REAL,
                category TEXT,
                subcategory TEXT,
                gender TEXT,
                size_ml INTEGER,
                stock INTEGER DEFAULT 0,
                image_url TEXT,
                images_json TEXT,
                fragrance_notes_json TEXT,
                rating REAL DEFAULT 0,
                reviews_count INTEGER DEFAULT 0,
                featured BOOLEAN DEFAULT 0,
                bestseller BOOLEAN DEFAULT 0,
                new_arrival BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        this._db.run(`
            CREATE TABLE IF NOT EXISTS cart (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                quantity INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id),
                FOREIGN KEY (product_id) REFERENCES products (id)
            )
        `);
        this._db.run(`
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                customer_name TEXT,
                customer_email TEXT,
                customer_phone TEXT,
                total REAL NOT NULL,
                status TEXT DEFAULT 'pending',
                shipping_address TEXT NOT NULL,
                payment_method TEXT DEFAULT 'cod',
                payment_status TEXT DEFAULT 'pending',
                payment_id TEXT,
                razorpay_order_id TEXT,
                tracking_number TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        try { this._db.run("ALTER TABLE orders ADD COLUMN payment_id TEXT"); } catch(e){}
        try { this._db.run("ALTER TABLE orders ADD COLUMN razorpay_order_id TEXT"); } catch(e){}
        this._db.run(`
            CREATE TABLE IF NOT EXISTS order_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL,
                price REAL NOT NULL,
                FOREIGN KEY (order_id) REFERENCES orders (id),
                FOREIGN KEY (product_id) REFERENCES products (id)
            )
        `);
        this._db.run(`
            CREATE TABLE IF NOT EXISTS reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
                comment TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id),
                FOREIGN KEY (product_id) REFERENCES products (id)
            )
        `);
        this._db.run(`
            CREATE TABLE IF NOT EXISTS wishlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id),
                FOREIGN KEY (product_id) REFERENCES products (id)
            )
        `);
        this._db.run(`
            CREATE TABLE IF NOT EXISTS coupons (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT UNIQUE NOT NULL,
                discount_percent REAL NOT NULL,
                min_order REAL DEFAULT 0,
                max_uses INTEGER DEFAULT NULL,
                used_count INTEGER DEFAULT 0,
                active BOOLEAN DEFAULT 1,
                expires_at DATETIME
            )
        `);
        this._db.run(`
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE NOT NULL,
                value TEXT NOT NULL
            )
        `);
    },

    _seedData() {
        const hash = bcrypt.hashSync('admin123', 10);
        
        // Ensure standard admin accounts exist
        const checkAdmin = this._db.prepare('SELECT id FROM users WHERE email = ?');
        checkAdmin.bind(['stddeepanshu@aol.com']);
        if (!checkAdmin.step()) {
            this._db.run('INSERT INTO users (name, email, password_hash, role, phone, address) VALUES (?, ?, ?, ?, ?, ?)',
                ['Deepanshu (CEO)', 'stddeepanshu@aol.com', hash, 'admin', '+91 98110 24567', 'Connaught Place, New Delhi, Delhi 110001, India']);
        }
        checkAdmin.free();

        const checkDefault = this._db.prepare('SELECT id FROM users WHERE email = ?');
        checkDefault.bind(['admin@luxescent.com']);
        if (!checkDefault.step()) {
            this._db.run('INSERT INTO users (name, email, password_hash, role, phone, address) VALUES (?, ?, ?, ?, ?, ?)',
                ['Master Admin', 'admin@luxescent.com', hash, 'admin', '+91 98110 24567', 'Delhi, India']);
        }
        checkDefault.free();

        // Update / Seed Settings
        const defaultSettings = [
            ['site_name', 'Luxury Perfume'],
            ['site_tagline', 'The Art of Haute Fragrance'],
            ['site_description', 'India’s most prestigious luxury perfume boutique with authentic designer & niche perfumes.'],
            ['currency', '₹'],
            ['tax_rate', '18'],
            ['shipping_fee', '99'],
            ['free_shipping_threshold', '1999'],
            ['contact_email', 'stddeepanshu@aol.com'],
            ['contact_phone', '+91 98110 24567'],
            ['store_address', 'Connaught Place, Inner Circle, New Delhi, Delhi 110001, India'],
            ['instagram', '@luxuryperfume_india'],
            ['whatsapp', '+919811024567'],
            ['razorpay_enabled', '1'],
            ['razorpay_key_id', 'rzp_test_51LuxuryDelhi'],
            ['paypal_enabled', '1'],
            ['paypal_client_id', 'sb'],
            ['cod_enabled', '1'],
            ['anti_carding_mode', '1']
        ];

        for (const [k, v] of defaultSettings) {
            this._db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, v]);
        }

        // Check if products exist
        const pstmt = this._db.prepare('SELECT COUNT(*) as count FROM products');
        pstmt.step();
        const productCount = pstmt.get()[0];
        pstmt.free();

        if (productCount === 0) {
            const products = [
                {
                    name: "Oud Wood Private Blend",
                    brand: "Tom Ford",
                    price: 21500,
                    sale_price: 18999,
                    category: "unisex",
                    size: 50,
                    desc: "A composition of exotic, smoky woods including rare oud, sandalwood, and vetiver. Sensual and unforgettable.",
                    notes: { top: ["Rosewood", "Cardamom", "Chinese Pepper"], middle: ["Oud Wood", "Sandalwood", "Vetiver"], base: ["Tonka Bean", "Vanilla", "Amber"] },
                    featured: 1,
                    bestseller: 1,
                    new_arrival: 0,
                    stock: 24,
                    image_url: "https://images.unsplash.com/photo-1594035910387-fea47794261f?auto=format&fit=crop&w=600&q=80"
                },
                {
                    name: "Baccarat Rouge 540 Extrait",
                    brand: "Maison Francis Kurkdjian",
                    price: 27500,
                    sale_price: 24999,
                    category: "unisex",
                    size: 70,
                    desc: "Luminous and intensely sophisticated. A poetic alchemy blending crimson saffron and grandiflorum jasmine with amberwood caustics.",
                    notes: { top: ["Egyptian Grandiflorum Jasmine", "Saffron"], middle: ["Moroccan Bitter Almond", "Cedarwood"], base: ["Ambergris", "Woody Musk"] },
                    featured: 1,
                    bestseller: 1,
                    new_arrival: 0,
                    stock: 18,
                    image_url: "https://images.unsplash.com/photo-1523293182086-7651a899d37f?auto=format&fit=crop&w=600&q=80"
                },
                {
                    name: "Aventus Royal Edition",
                    brand: "Creed",
                    price: 26000,
                    sale_price: 23500,
                    category: "men",
                    size: 100,
                    desc: "The legendary masterpiece celebrating strength, power, and success. Sensual, audacious, and contemporary.",
                    notes: { top: ["Pineapple", "Bergamot", "Blackcurrant Leaves", "Apple"], middle: ["Birch", "Pink Berries", "Patchouli", "Jasmine"], base: ["Musk", "Oakmoss", "Ambergris", "Vanilla"] },
                    featured: 1,
                    bestseller: 1,
                    new_arrival: 0,
                    stock: 30,
                    image_url: "https://images.unsplash.com/photo-1592945403244-b3fbafd7f539?auto=format&fit=crop&w=600&q=80"
                },
                {
                    name: "Bleu de Chanel Parfum",
                    brand: "Chanel",
                    price: 13500,
                    sale_price: 11999,
                    category: "men",
                    size: 100,
                    desc: "An ode to masculine freedom in an aromatic-woody fragrance with a captivating trail of New Caledonian sandalwood.",
                    notes: { top: ["Lemon Zest", "Bergamot", "Mint", "Artemisia"], middle: ["Lavender", "Geranium", "Green Notes", "Pineapple"], base: ["Cedar", "Sandalwood", "Iso E Super", "Tonka Bean"] },
                    featured: 1,
                    bestseller: 1,
                    new_arrival: 0,
                    stock: 45,
                    image_url: "https://images.unsplash.com/photo-1547887537-6158d64c35b3?auto=format&fit=crop&w=600&q=80"
                },
                {
                    name: "Black Orchid Reserve",
                    brand: "Tom Ford",
                    price: 15500,
                    sale_price: 13900,
                    category: "women",
                    size: 100,
                    desc: "A luxurious and sensual potion of rich, dark accords and an alluring bouquet of black orchids and spice.",
                    notes: { top: ["Black Truffle", "Ylang-Ylang", "Bergamot", "Black Currant"], middle: ["Black Orchid", "Spiced Florals", "Lotus Wood"], base: ["Patchouli", "Incense", "Vetiver", "Mexican Vanilla"] },
                    featured: 1,
                    bestseller: 0,
                    new_arrival: 1,
                    stock: 22,
                    image_url: "https://images.unsplash.com/photo-1616949755610-8c9bbc08f138?auto=format&fit=crop&w=600&q=80"
                },
                {
                    name: "Sauvage Elixir",
                    brand: "Dior",
                    price: 15500,
                    sale_price: 14200,
                    category: "men",
                    size: 60,
                    desc: "An extraordinarily concentrated fragrance steeped in the iconic freshness of Sauvage with an intoxicating heart of spices.",
                    notes: { top: ["Cinnamon", "Nutmeg", "Cardamom", "Grapefruit"], middle: ["Lavender AOP of Nyons", "Coumarin"], base: ["Licorice", "Sandalwood", "Amber", "Patchouli", "Haitian Vetiver"] },
                    featured: 1,
                    bestseller: 1,
                    new_arrival: 0,
                    stock: 35,
                    image_url: "https://images.unsplash.com/photo-1588405748880-12d1d2a59f75?auto=format&fit=crop&w=600&q=80"
                },
                {
                    name: "Santal 33 Haute",
                    brand: "Le Labo",
                    price: 20500,
                    sale_price: 18500,
                    category: "unisex",
                    size: 100,
                    desc: "An icon of modern perfumery. Cardamom, iris, and violet sparkle into smoky wood alloy and Australian sandalwood.",
                    notes: { top: ["Cardamom", "Violet Accord"], middle: ["Iris", "Ambrox", "Papyrus"], base: ["Cedarwood", "Leather", "Sandalwood"] },
                    featured: 1,
                    bestseller: 0,
                    new_arrival: 1,
                    stock: 15,
                    image_url: "https://images.unsplash.com/photo-1594035910387-fea47794261f?auto=format&fit=crop&w=600&q=80"
                },
                {
                    name: "Good Girl Velvet Fatale",
                    brand: "Carolina Herrera",
                    price: 11500,
                    sale_price: 9999,
                    category: "women",
                    size: 80,
                    desc: "An audacious expression of feminine duality in the iconic velvet stiletto bottle. Sweet jasmine alongside roasted tonka bean.",
                    notes: { top: ["Almond", "Coffee", "Bergamot", "Lemon"], middle: ["Tuberose", "Jasmine Sambac", "Orange Blossom"], base: ["Tonka Bean", "Cacao", "Vanilla", "Cashmere Wood"] },
                    featured: 0,
                    bestseller: 1,
                    new_arrival: 0,
                    stock: 28,
                    image_url: "https://images.unsplash.com/photo-1587017539504-67cfbddac569?auto=format&fit=crop&w=600&q=80"
                },
                {
                    name: "Libre Le Parfum",
                    brand: "Yves Saint Laurent",
                    price: 13500,
                    sale_price: 11999,
                    category: "women",
                    size: 90,
                    desc: "The fiery fragrance of freedom. Moroccan orange blossom infused with a warm, spicy saffron accord from Ourika Community Gardens.",
                    notes: { top: ["Ginger", "Saffron", "Mandarin Orange", "Bergamot"], middle: ["Orange Blossom", "Lavender"], base: ["Bourbon Vanilla", "Honey", "Tonka Bean", "Vetiver"] },
                    featured: 1,
                    bestseller: 1,
                    new_arrival: 1,
                    stock: 32,
                    image_url: "https://images.unsplash.com/photo-1541643600914-78b084683601?auto=format&fit=crop&w=600&q=80"
                },
                {
                    name: "Tobacco Vanille Royale",
                    brand: "Tom Ford",
                    price: 22500,
                    sale_price: 19999,
                    category: "unisex",
                    size: 50,
                    desc: "Opulent. Warm. Iconic. A modern take on an old-world gentlemen's club infused with tonka bean, rich cocoa, and sweet wood sap.",
                    notes: { top: ["Tobacco Leaf", "Spicy Accords"], middle: ["Tonka Bean", "Tobacco Flower", "Vanilla", "Cacao"], base: ["Dry Fruit Accord", "Rich Wood Sap"] },
                    featured: 1,
                    bestseller: 1,
                    new_arrival: 0,
                    stock: 20,
                    image_url: "https://images.unsplash.com/photo-1592945403244-b3fbafd7f539?auto=format&fit=crop&w=600&q=80"
                },
                {
                    name: "Khamrah Qahwa",
                    brand: "Lattafa",
                    price: 3200,
                    sale_price: 2699,
                    category: "unisex",
                    size: 100,
                    desc: "An Arabian gourmand masterpiece with dark roasted Arabic coffee, warm cinnamon, praline, and candied dates.",
                    notes: { top: ["Ginger", "Cinnamon", "Cardamom"], middle: ["Praline", "Candied Fruit", "White Flowers"], base: ["Coffee", "Tonka Bean", "Benzoin", "Vanilla", "Musk"] },
                    featured: 0,
                    bestseller: 1,
                    new_arrival: 1,
                    stock: 60,
                    image_url: "https://images.unsplash.com/photo-1523293182086-7651a899d37f?auto=format&fit=crop&w=600&q=80"
                },
                {
                    name: "Lost Cherry Reserve",
                    brand: "Tom Ford",
                    price: 24000,
                    sale_price: 21500,
                    category: "unisex",
                    size: 50,
                    desc: "A full-bodied journey into the once-forbidden; a contrasting scent that reveals a tempting dichotomy of playful, candy-like gleam.",
                    notes: { top: ["Black Cherry", "Cherry Liqueur", "Bitter Almond"], middle: ["Griotte Syrup", "Turkish Rose", "Jasmine Sambac"], base: ["Peru Balsam", "Roasted Tonka", "Sandalwood", "Vetiver"] },
                    featured: 1,
                    bestseller: 0,
                    new_arrival: 1,
                    stock: 14,
                    image_url: "https://images.unsplash.com/photo-1588405748880-12d1d2a59f75?auto=format&fit=crop&w=600&q=80"
                },
                {
                    name: "Club de Nuit Iconic",
                    brand: "Armaf",
                    price: 4200,
                    sale_price: 3499,
                    category: "men",
                    size: 105,
                    desc: "An invigorating citrus-woody fragrance crafted for the discerning modern gentleman. Incredible sillage and longevity.",
                    notes: { top: ["Grapefruit", "Lemon", "Mint", "Pink Pepper", "Coriander"], middle: ["Ginger", "Nutmeg", "Jasmine", "Melon"], base: ["Incense", "Amber", "Cedarwood", "Sandalwood", "Patchouli"] },
                    featured: 0,
                    bestseller: 1,
                    new_arrival: 0,
                    stock: 50,
                    image_url: "https://images.unsplash.com/photo-1547887537-6158d64c35b3?auto=format&fit=crop&w=600&q=80"
                },
                {
                    name: "Aristocrat Platinum",
                    brand: "Ajmal",
                    price: 5500,
                    sale_price: 4499,
                    category: "men",
                    size: 75,
                    desc: "Crafted in Dubai for modern royalty. Rich saffron and spicy pink pepper merged with golden amber and oakmoss.",
                    notes: { top: ["Lemon", "Pink Pepper", "Melon"], middle: ["Jasmine", "Cedar", "Saffron"], base: ["Amber", "Sandalwood", "Musk", "Agarwood"] },
                    featured: 0,
                    bestseller: 0,
                    new_arrival: 1,
                    stock: 35,
                    image_url: "https://images.unsplash.com/photo-1616949755610-8c9bbc08f138?auto=format&fit=crop&w=600&q=80"
                },
                {
                    name: "Nargis Pure Himalayan Attar",
                    brand: "Forest Essentials",
                    price: 4800,
                    sale_price: 4299,
                    category: "women",
                    size: 50,
                    desc: "Distilled from rare wild daffodils harvested in snow-capped Himachal valleys. Intensely delicate, romantic, and sacred.",
                    notes: { top: ["Wild Citrus Blossom"], middle: ["Himalayan Nargis", "Night Jasmine"], base: ["Mysore Sandalwood"] },
                    featured: 0,
                    bestseller: 0,
                    new_arrival: 1,
                    stock: 25,
                    image_url: "https://images.unsplash.com/photo-1587017539504-67cfbddac569?auto=format&fit=crop&w=600&q=80"
                }
            ];

            this._db.run('BEGIN TRANSACTION');
            for (let i = 0; i < products.length; i++) {
                const p = products[i];
                this._db.run(
                    `INSERT INTO products (name, brand, description, price, sale_price, category, size_ml, fragrance_notes_json, bestseller, new_arrival, featured, stock, image_url, rating, reviews_count)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        p.name, p.brand, p.desc, p.price, p.sale_price || null,
                        p.category, p.size, JSON.stringify(p.notes),
                        p.bestseller || 0, p.new_arrival || 0, p.featured || 0,
                        p.stock,
                        p.image_url,
                        (Math.random() * 0.8 + 4.2).toFixed(1),
                        Math.floor(Math.random() * 180) + 25
                    ]
                );
            }

            // Seed active coupons
            this._db.run("INSERT INTO coupons (code, discount_percent, min_order, max_uses, active, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
                ['WELCOME10', 10, 1000, 1000, 1, '2028-12-31']);
            this._db.run("INSERT INTO coupons (code, discount_percent, min_order, max_uses, active, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
                ['LUXE20', 20, 4999, 500, 1, '2028-12-31']);
            this._db.run("INSERT INTO coupons (code, discount_percent, min_order, max_uses, active, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
                ['DELHI15', 15, 1999, 500, 1, '2028-12-31']);

            // Seed sample orders for immediate rich dashboard visuals
            this._db.run(`
                INSERT INTO orders (customer_name, customer_email, customer_phone, total, status, shipping_address, payment_method, payment_status, tracking_number)
                VALUES 
                ('Vikramaditya Roy', 'vikram.roy@gmail.com', '+91 98201 12345', 21500, 'delivered', 'Civil Lines, Delhi 110054', 'prepaid', 'paid', 'DEL-EXP-8921'),
                ('Ananya Sen', 'ananya.sen@outlook.com', '+91 98711 44321', 27500, 'shipped', 'Defence Colony, New Delhi 110024', 'upi', 'paid', 'DEL-EXP-9104'),
                ('Deepanshu Sharma', 'stddeepanshu@aol.com', '+91 98110 24567', 15500, 'processing', 'Connaught Place, New Delhi 110001', 'cod', 'pending', 'DEL-EXP-9233'),
                ('Kavita Rathore', 'kavita.r@gmail.com', '+91 99990 88765', 13500, 'pending', 'Vasant Vihar, New Delhi 110057', 'cod', 'pending', NULL)
            `);

            this._db.run(`
                INSERT INTO order_items (order_id, product_id, quantity, price)
                VALUES 
                (1, 1, 1, 21500),
                (2, 2, 1, 27500),
                (3, 6, 1, 15500),
                (4, 9, 1, 13500)
            `);

            this._db.run('COMMIT');
            console.log(`Seeded ${products.length} luxury products, coupons, and orders`);
        }
    }
};

module.exports = wrapper;
