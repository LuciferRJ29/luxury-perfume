const express = require('express');
const cors = require('cors');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxies (Essential for Vercel, Cloudflare, rate-limiting & SSL)
app.set('trust proxy', 1);

// 1. HELMET SECURITY HEADERS (Defends against XSS, Clickjacking, MIME-Sniffing)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
                "https://cdnjs.cloudflare.com",
                "https://cdn.jsdelivr.net",
                "https://checkout.razorpay.com",
                "https://www.paypal.com",
                "https://www.sandbox.paypal.com"
            ],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://fonts.googleapis.com",
                "https://cdnjs.cloudflare.com"
            ],
            fontSrc: [
                "'self'",
                "https://fonts.gstatic.com",
                "https://cdnjs.cloudflare.com"
            ],
            imgSrc: [
                "'self'",
                "data:",
                "blob:",
                "https://images.unsplash.com",
                "https://*.paypal.com",
                "https://*.razorpay.com"
            ],
            frameSrc: [
                "'self'",
                "https://api.razorpay.com",
                "https://checkout.razorpay.com",
                "https://www.paypal.com",
                "https://www.sandbox.paypal.com"
            ],
            connectSrc: [
                "'self'",
                "https://api.razorpay.com",
                "https://lumberjack.razorpay.com",
                "https://www.paypal.com",
                "https://www.sandbox.paypal.com"
            ]
        }
    },
    crossOriginEmbedderPolicy: false
}));

// 2. GLOBAL ANTI-DDOS / ABUSE RATE LIMITER
const globalApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 mins
    max: 300, // 300 requests per 15 mins per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this IP. Anti-DDoS protection active.' }
});
app.use('/api/', globalApiLimiter);

// 3. CORS & BODY PARSER
app.use(cors());
app.use(express.json({ limit: '1mb' })); // Strict limit against memory exhaust attacks
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 4. SECURE SESSIONS
app.use(session({
    secret: process.env.SESSION_SECRET || 'luxury_perfume_secret_2026',
    resave: false,
    saveUninitialized: false,
    name: 'luxury_sid',
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// 5. STATIC FILES (Safe folder creation for Vercel read-only filesystem)
const publicDir = path.join(__dirname, 'public');
const isServerlessEnv = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
const serverlessUploadsDir = path.join('/tmp', 'uploads');
const localUploadsDir = path.join(publicDir, 'uploads');

try {
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
    if (!isServerlessEnv && !fs.existsSync(localUploadsDir)) fs.mkdirSync(localUploadsDir, { recursive: true });
    if (isServerlessEnv && !fs.existsSync(serverlessUploadsDir)) fs.mkdirSync(serverlessUploadsDir, { recursive: true });
} catch (e) {
    // Read-only filesystem in serverless environments
}
app.use(express.static(publicDir));
if (isServerlessEnv) {
    app.use('/uploads', express.static(serverlessUploadsDir));
}
app.use('/uploads', express.static(localUploadsDir));

// Database initialization singleton
const db = require('./database/db');
let dbInitPromise = null;
function ensureDatabaseReady() {
    if (!dbInitPromise) {
        dbInitPromise = db.init().catch(err => {
            console.error('Database initialization error:', err);
            dbInitPromise = null;
            throw err;
        });
    }
    return dbInitPromise;
}

// Middleware: ensure database is ready for all /api endpoints
app.use('/api', async (req, res, next) => {
    try {
        await ensureDatabaseReady();
        next();
    } catch (err) {
        res.status(500).json({ error: 'Database initializing. Please retry in a moment.' });
    }
});

// Public settings API (Exposes only safe public configuration)
app.get('/api/settings', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM settings').all();
        const settings = {};
        rows.forEach(r => {
            // Exclude private secrets from public endpoint!
            if (!r.key.includes('secret')) {
                settings[r.key] = r.value;
            }
        });
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// Load API routes
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const cartRoutes = require('./routes/cart');
const orderRoutes = require('./routes/orders');
const adminRoutes = require('./routes/admin');

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);

// Fallback for Admin Console
app.get('/admin', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin.html'));
});

// Centralized Error Handling Middleware (No stack trace leaked to clients)
app.use((err, req, res, next) => {
    console.error('Unhandled Application Error:', err.message);
    res.status(err.status || 500).json({
        error: 'An internal error occurred. Request was safely halted by Security Shield.',
        reference: Date.now()
    });
});

// Standalone execution for local development
if (require.main === module) {
    ensureDatabaseReady().then(() => {
        app.listen(PORT, () => {
            console.log(`\n=================================================`);
            console.log(`✨ LUXURY PERFUME — Online with Anti-Fraud Shield!`);
            console.log(`🌐 Website:        http://localhost:${PORT}`);
            console.log(`📊 Admin Panel:    http://localhost:${PORT}/admin.html`);
            console.log(`📍 Location:       Delhi, India`);
            console.log(`📧 Contact:        stddeepanshu@aol.com`);
            console.log(`🛡️ Security:       Helmet + Anti-Carding + HMAC SHA256 active`);
            console.log(`💳 Gateways:       Razorpay (UPI/Cards) + PayPal + COD`);
            console.log(`🔑 Admin Accounts:`);
            console.log(`   1) stddeepanshu@aol.com / admin123 (Owner & CEO)`);
            console.log(`   2) admin@luxescent.com / admin123 (Master Admin)`);
            console.log(`=================================================\n`);
        });
    }).catch(err => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });
}

module.exports = app;
