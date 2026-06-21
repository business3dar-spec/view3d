require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('./db');
const { startBot } = require('./bot');

const app  = express();
const PORT = process.env.PORT || 3000;

['uploads/images', 'uploads/models'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public', { index: false }));
app.use('/uploads', express.static('uploads'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false
}));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, file.fieldname === 'model' ? 'uploads/models' : 'uploads/images'),
  filename:    (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random()*1e6) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50*1024*1024 } });

async function initDb() {
  const schema = fs.readFileSync('./db/schema.sql', 'utf8');
  await db.query(schema);
  console.log('âœ… Database ready');
}

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  PAGES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Marketplace homepage â€” all products, all companies
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'marketplace.html'));
});

// Single product page (3D viewer + price + description)
app.get('/product/:id', async (req, res) => {
  const r = await db.query(
    `SELECT p.*, c.name AS company_name, c.slug AS company_slug
     FROM products p JOIN companies c ON p.company_id = c.id
     WHERE p.id = $1 AND p.is_active = true AND c.payment_status = 'approved'`,
    [req.params.id]
  );
  if (!r.rows.length) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  const html = fs.readFileSync(path.join(__dirname, 'public', 'product.html'), 'utf8')
    .replace('__PRODUCT_DATA__', JSON.stringify(r.rows[0]));
  res.send(html);
});

// Company storefront page (their own branded mini-shop)
app.get('/store/:slug', async (req, res) => {
  const c = await db.query('SELECT * FROM companies WHERE slug = $1 AND payment_status = $2', [req.params.slug, 'approved']);
  if (!c.rows.length) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  const company = c.rows[0];
  const products = await db.query('SELECT * FROM products WHERE company_id = $1 AND is_active = true ORDER BY created_at DESC', [company.id]);
  const html = fs.readFileSync(path.join(__dirname, 'public', 'store.html'), 'utf8')
    .replace('__COMPANY_DATA__', JSON.stringify(company))
    .replace('__PRODUCTS_DATA__', JSON.stringify(products.rows));
  res.send(html);
});

// Legacy /view/:id route â€” redirect old links to new store page
app.get('/view/:companyId', async (req, res) => {
  const r = await db.query('SELECT slug FROM companies WHERE id = $1', [req.params.companyId]);
  if (r.rows.length && r.rows[0].slug) return res.redirect(`/store/${r.rows[0].slug}`);
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Seller dashboard
app.get('/dashboard/:companyId', async (req, res) => {
  const r = await db.query('SELECT * FROM companies WHERE id = $1', [req.params.companyId]);
  if (!r.rows.length) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  if (r.rows[0].payment_status !== 'approved') return res.status(403).sendFile(path.join(__dirname, 'public', 'blocked.html'));
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  API
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// All products across all approved companies â€” marketplace feed
app.get('/api/products', async (req, res) => {
  try {
    const { category } = req.query;
    let query = `
      SELECT p.*, c.name AS company_name, c.slug AS company_slug
      FROM products p JOIN companies c ON p.company_id = c.id
      WHERE p.is_active = true AND c.payment_status = 'approved'`;
    const params = [];
    if (category && category !== 'all') {
      params.push(category);
      query += ` AND p.category = $${params.length}`;
    }
    query += ' ORDER BY p.created_at DESC';
    const result = await db.query(query, params);
    res.json({ products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Distinct categories that currently have at least one product
app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT p.category, COUNT(*) AS count
      FROM products p JOIN companies c ON p.company_id = c.id
      WHERE p.is_active = true AND c.payment_status = 'approved'
      GROUP BY p.category ORDER BY count DESC`);
    res.json({ categories: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/company/:id', async (req, res) => {
  try {
    const company = await db.query('SELECT id, name, plan, payment_status, slug, address, phone, bio FROM companies WHERE id = $1', [req.params.id]);
    if (!company.rows.length) return res.status(404).json({ error: 'Not found' });
    const products = await db.query('SELECT * FROM products WHERE company_id = $1 AND is_active = true ORDER BY created_at DESC', [req.params.id]);
    const limits = await db.query('SELECT max_products FROM plan_limits WHERE plan = $1', [company.rows[0].plan]);
    res.json({ company: company.rows[0], products: products.rows, maxProducts: limits.rows[0]?.max_products || 5 });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update store profile (address, phone, bio) â€” used by the seller dashboard
app.put('/api/company/:id/profile', async (req, res) => {
  try {
    const { address, phone, bio } = req.body;
    const result = await db.query(
      `UPDATE companies SET address = $1, phone = $2, bio = $3 WHERE id = $4 AND payment_status = 'approved' RETURNING id, name, slug, address, phone, bio`,
      [address || null, phone || null, bio || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Company not found or not approved' });
    res.json({ success: true, company: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

app.post('/api/products', upload.fields([{ name: 'model', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async (req, res) => {
  try {
    const { company_id, name, description, price, category } = req.body;
    if (!company_id || !name) return res.status(400).json({ error: 'company_id and name required' });

    const cr = await db.query('SELECT * FROM companies WHERE id = $1 AND payment_status = $2', [company_id, 'approved']);
    if (!cr.rows.length) return res.status(403).json({ error: 'Company not approved' });

    const lr = await db.query('SELECT max_products FROM plan_limits WHERE plan = $1', [cr.rows[0].plan]);
    const max = lr.rows[0]?.max_products || 5;
    const count = await db.query('SELECT COUNT(*) FROM products WHERE company_id = $1', [company_id]);
    if (parseInt(count.rows[0].count) >= max) return res.status(400).json({ error: `Plan limit reached (${max} products)` });

    if (!req.files?.model) return res.status(400).json({ error: 'Model file required' });

    const modelUrl = `/uploads/models/${req.files.model[0].filename}`;
    const imageUrl = req.files?.image ? `/uploads/images/${req.files.image[0].filename}` : null;

    const result = await db.query(
      `INSERT INTO products (company_id, name, description, price, category, image_url, model_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [company_id, name, description || '', price || 0, category || 'other', imageUrl, modelUrl]
    );
    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const { company_id } = req.body;
    await db.query('UPDATE products SET is_active = false WHERE id = $1 AND company_id = $2', [req.params.id, company_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

initDb().then(() => {
  startBot();
  app.listen(PORT, () => console.log(`ðŸš€ Server running on port ${PORT}`));
}).catch(err => { console.error('Startup failed:', err); process.exit(1); });
