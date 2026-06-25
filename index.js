require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('./db');
const { startBot } = require('./bot');
const kiri    = require('./kiri');

const app  = express();
const PORT = process.env.PORT || 3000;

['uploads/images', 'uploads/models', 'uploads/captures'].forEach(function(d) {
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
  destination: function(req, file, cb) {
    if (file.fieldname === 'model') return cb(null, 'uploads/models');
    if (file.fieldname === 'photos') return cb(null, 'uploads/captures');
    return cb(null, 'uploads/images');
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + '-' + Math.round(Math.random()*1e6) + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 50*1024*1024 } });
const captureUpload = multer({ storage: storage, limits: { fileSize: 25*1024*1024, files: 40 } });

async function initDb() {
  const schema = fs.readFileSync('./db/schema.sql', 'utf8');
  await db.query(schema);
  console.log('âœ… Database ready');
}

const RESERVED_SLUGS = ['product', 'dashboard', 'store', 'view', 'register', 'api', 'uploads', 'blocked', '404', 'scan'];

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  PAGES
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'marketplace.html'));
});

app.get('/register', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/product/:id', async function(req, res) {
  const r = await db.query(
    "SELECT p.*, c.name AS company_name, c.slug AS company_slug " +
    "FROM products p JOIN companies c ON p.company_id = c.id " +
    "WHERE p.id = $1 AND p.is_active = true AND c.store_status = 'active'",
    [req.params.id]
  );
  if (!r.rows.length) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  const html = fs.readFileSync(path.join(__dirname, 'public', 'product.html'), 'utf8')
    .replace('__PRODUCT_DATA__', JSON.stringify(r.rows[0]));
  res.send(html);
});

app.get('/store/:slug', function(req, res) { res.redirect('/' + req.params.slug); });

app.get('/view/:companyId', async function(req, res) {
  const r = await db.query('SELECT slug FROM companies WHERE id = $1', [req.params.companyId]);
  if (r.rows.length && r.rows[0].slug) return res.redirect('/' + r.rows[0].slug);
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.get('/dashboard/:companyId', async function(req, res) {
  const r = await db.query('SELECT * FROM companies WHERE id = $1', [req.params.companyId]);
  if (!r.rows.length) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  if (r.rows[0].store_status !== 'active') return res.status(403).sendFile(path.join(__dirname, 'public', 'blocked.html'));
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Camera capture page â€” opened from the Telegram bot's link
app.get('/scan/:token', async function(req, res) {
  const r = await db.query('SELECT * FROM products WHERE capture_token = $1', [req.params.token]);
  if (!r.rows.length) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  const product = r.rows[0];
  const html = fs.readFileSync(path.join(__dirname, 'public', 'capture.html'), 'utf8')
    .replace('__CAPTURE_TOKEN__', req.params.token)
    .replace('__PRODUCT_NAME__', product.name.replace(/"/g, '\\"'));
  res.send(html);
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  CAPTURE API â€” receives photos from the camera page, kicks off KIRI
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

app.get('/api/capture/check', async function(req, res) {
  const token = req.query.token;
  const r = await db.query('SELECT capture_status FROM products WHERE capture_token = $1', [token]);
  const valid = r.rows.length > 0 && r.rows[0].capture_status === 'not_started';
  res.json({ valid: valid });
});

app.post('/api/capture/upload', captureUpload.array('photos'), async function(req, res) {
  try {
    const token = req.body.token;
    const product = await db.query('SELECT * FROM products WHERE capture_token = $1', [token]);
    if (!product.rows.length) return res.status(404).json({ error: 'Invalid capture link' });

    const productId = product.rows[0].id;
    await db.query('UPDATE products SET capture_status = $1 WHERE id = $2', ['uploading', productId]);

    if (!kiri.isConfigured()) {
      await db.query('UPDATE products SET capture_status = $1 WHERE id = $2', ['awaiting_kiri_setup', productId]);
      return res.json({ success: true, note: 'Photos received. 3D generation will begin once KIRI integration is activated.' });
    }

    const imagePaths = req.files.map(function(f) { return f.path; });
    const uploadResult = await kiri.uploadPhotoSet(imagePaths);

    if (!uploadResult.ok) {
      await db.query('UPDATE products SET capture_status = $1 WHERE id = $2', ['failed', productId]);
      return res.status(500).json({ error: uploadResult.reason });
    }

    await db.query('UPDATE products SET kiri_serialize = $1, capture_status = $2 WHERE id = $3', [uploadResult.serialize, 'processing', productId]);

    // Respond to the capture page immediately â€” the camera UI shows "Finished
    // successfully" right away. The actual 3D generation continues in the
    // background and the product updates automatically when it's done.
    res.json({ success: true });

    processKiriJobInBackground(uploadResult.serialize, productId, imagePaths);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Polls KIRI until the model is ready, downloads + saves the GLB, attaches it
// to the product, cleans up temp photo files, and notifies the owner on Telegram.
async function processKiriJobInBackground(serialize, productId, tempImagePaths) {
  try {
    const pollResult = await kiri.pollUntilDone(serialize);

    const cleanupTempPhotos = function() {
      tempImagePaths.forEach(function(p) { try { fs.unlinkSync(p); } catch (e) {} });
    };

    if (!pollResult.ok) {
      cleanupTempPhotos();
      if (pollResult.terminal) {
        // KIRI itself reported failed/expired â€” this is a real, final failure.
        await db.query('UPDATE products SET capture_status = $1 WHERE id = $2', ['failed', productId]);
        return notifyOwner(productId, 'âŒ Sorry, 3D model generation failed for one of your products. Please try the capture link again.');
      }
      // We simply stopped waiting â€” KIRI may still finish. Leave status as
      // "processing" so the /api/kiri/webhook (or a manual recheck) can still
      // complete it later instead of wrongly telling the owner it failed.
      console.warn('KIRI poll timed out for serialize ' + serialize + ' â€” leaving status as processing');
      return;
    }

    const saveResult = await kiri.downloadAndSaveGlb(serialize, productId);
    cleanupTempPhotos();

    if (!saveResult.ok) {
      await db.query('UPDATE products SET capture_status = $1 WHERE id = $2', ['failed', productId]);
      return notifyOwner(productId, 'âŒ Your 3D model finished processing but we couldn\'t download it. Please try again or contact support.');
    }

    await db.query('UPDATE products SET model_url = $1, capture_status = $2 WHERE id = $3', [saveResult.modelUrl, 'completed', productId]);
    await notifyOwnerCaptureComplete(productId);
  } catch (err) {
    console.error('Background KIRI processing error:', err);
    // Don't mark as failed on an unexpected error either â€” log it and leave
    // the product in its current state so it can be retried/rechecked.
  }
}

async function notifyOwner(productId, text) {
  try {
    const p = await db.query('SELECT company_id FROM products WHERE id = $1', [productId]);
    if (!p.rows.length) return;
    const c = await db.query('SELECT telegram_chat_id FROM companies WHERE id = $1', [p.rows[0].company_id]);
    const chatId = c.rows[0] && c.rows[0].telegram_chat_id;
    if (chatId && global.__telegramBotInstance) {
      global.__telegramBotInstance.sendMessage(chatId, text).catch(function(){});
    }
  } catch (e) {}
}

async function notifyOwnerCaptureComplete(productId) {
  const p = await db.query('SELECT name, company_id FROM products WHERE id = $1', [productId]);
  if (!p.rows.length) return;
  const productName = p.rows[0].name;
  const text = `ðŸŽ‰ Your 3D model for "${productName}" is ready and has been added to your product automatically!`;

  if (global.__telegramOnCaptureComplete) {
    await global.__telegramOnCaptureComplete(p.rows[0].company_id, text);
  } else {
    await notifyOwner(productId, text);
  }
}

// KIRI webhook â€” called by KIRI's servers when a model finishes processing.
app.post('/api/kiri/webhook', async function(req, res) {
  try {
    const serialize = req.body.serialize;
    const status = req.body.status;
    if (!serialize) return res.status(400).send('Missing serialize');

    const product = await db.query('SELECT * FROM products WHERE kiri_serialize = $1', [serialize]);
    if (!product.rows.length) return res.status(404).send('Unknown job');

    if (status === 'success' || status === 2) {
      const dl = await kiri.getDownloadUrl(serialize);
      if (dl.ok) {
        await db.query('UPDATE products SET model_url = $1, capture_status = $2 WHERE id = $3', [dl.url, 'completed', product.rows[0].id]);
      }
    } else if (status === 'failed' || status === 1) {
      await db.query('UPDATE products SET capture_status = $1 WHERE id = $2', ['failed', product.rows[0].id]);
    }
    res.status(200).send('ok');
  } catch (err) {
    console.error(err);
    res.status(500).send('error');
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  API â€” existing endpoints, preserved
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

app.get('/api/products', async function(req, res) {
  try {
    const category = req.query.category;
    const q = req.query.q;
    let query = "SELECT p.*, c.name AS company_name, c.slug AS company_slug, c.business_type " +
      "FROM products p JOIN companies c ON p.company_id = c.id " +
      "WHERE p.is_active = true AND c.store_status = 'active'";
    const params = [];
    if (category && category !== 'all') {
      params.push(category);
      query += ' AND p.category = $' + params.length;
    }
    if (q) {
      params.push('%' + q.toLowerCase() + '%');
      const idx = params.length;
      query += ' AND (LOWER(p.name) LIKE $' + idx + ' OR LOWER(c.name) LIKE $' + idx + ' OR LOWER(p.category) LIKE $' + idx + ')';
    }
    query += ' ORDER BY p.created_at DESC';
    const result = await db.query(query, params);
    res.json({ products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/categories', async function(req, res) {
  try {
    const result = await db.query(
      "SELECT p.category, COUNT(*) AS count " +
      "FROM products p JOIN companies c ON p.company_id = c.id " +
      "WHERE p.is_active = true AND c.store_status = 'active' " +
      "GROUP BY p.category HAVING COUNT(*) > 0 ORDER BY count DESC"
    );
    res.json({ categories: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/discover', async function(req, res) {
  try {
    const recent = await db.query(
      "SELECT p.*, c.name AS company_name, c.slug AS company_slug " +
      "FROM products p JOIN companies c ON p.company_id = c.id " +
      "WHERE p.is_active = true AND c.store_status = 'active' " +
      "ORDER BY p.created_at DESC LIMIT 12"
    );
    const businesses = await db.query(
      "SELECT c.id, c.name, c.slug, c.business_type, COUNT(p.id) AS product_count " +
      "FROM companies c LEFT JOIN products p ON p.company_id = c.id AND p.is_active = true " +
      "WHERE c.store_status = 'active' GROUP BY c.id ORDER BY product_count DESC LIMIT 8"
    );
    res.json({ recent: recent.rows, businesses: businesses.rows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/company/:id', async function(req, res) {
  try {
    const company = await db.query(
      'SELECT id, name, plan, payment_status, store_status, slug, address, phone, bio, business_type, logo_url, cover_url FROM companies WHERE id = $1',
      [req.params.id]
    );
    if (!company.rows.length) return res.status(404).json({ error: 'Not found' });
    const products = await db.query('SELECT * FROM products WHERE company_id = $1 AND is_active = true ORDER BY created_at DESC', [req.params.id]);
    const limits = await db.query('SELECT max_products FROM plan_limits WHERE plan = $1', [company.rows[0].plan]);
    res.json({ company: company.rows[0], products: products.rows, maxProducts: (limits.rows[0] && limits.rows[0].max_products) || 5 });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/company/:id/profile', async function(req, res) {
  try {
    const address = req.body.address, phone = req.body.phone, bio = req.body.bio, business_type = req.body.business_type;
    const result = await db.query(
      "UPDATE companies SET address = $1, phone = $2, bio = $3, business_type = $4 " +
      "WHERE id = $5 AND store_status = 'active' RETURNING id, name, slug, address, phone, bio, business_type",
      [address || null, phone || null, bio || null, business_type || 'other', req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Company not found or not active' });
    res.json({ success: true, company: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

app.post('/api/products', upload.fields([{ name: 'model', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async function(req, res) {
  try {
    const company_id = req.body.company_id, name = req.body.name, description = req.body.description, price = req.body.price, category = req.body.category;
    if (!company_id || !name) return res.status(400).json({ error: 'company_id and name required' });

    const cr = await db.query("SELECT * FROM companies WHERE id = $1 AND store_status = 'active'", [company_id]);
    if (!cr.rows.length) return res.status(403).json({ error: 'Company not active' });

    const lr = await db.query('SELECT max_products FROM plan_limits WHERE plan = $1', [cr.rows[0].plan]);
    const max = (lr.rows[0] && lr.rows[0].max_products) || 5;
    const count = await db.query('SELECT COUNT(*) FROM products WHERE company_id = $1', [company_id]);
    if (parseInt(count.rows[0].count) >= max) return res.status(400).json({ error: 'Plan limit reached (' + max + ' products)' });

    if (!(req.files && req.files.model) && !(req.files && req.files.image)) {
      return res.status(400).json({ error: 'At least a product image or a 3D model is required' });
    }

    const modelUrl = (req.files && req.files.model) ? '/uploads/models/' + req.files.model[0].filename : null;
    const imageUrl = (req.files && req.files.image) ? '/uploads/images/' + req.files.image[0].filename : null;

    const result = await db.query(
      'INSERT INTO products (company_id, name, description, price, category, image_url, model_url) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [company_id, name, description || '', price || 0, category || 'other', imageUrl, modelUrl]
    );
    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', async function(req, res) {
  try {
    const company_id = req.body.company_id;
    await db.query('UPDATE products SET is_active = false WHERE id = $1 AND company_id = $2', [req.params.id, company_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//  CATCH-ALL â€” /:slug must be registered LAST
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
app.get('/:slug', async function(req, res, next) {
  const slug = req.params.slug;
  if (RESERVED_SLUGS.indexOf(slug) !== -1) return next();

  const c = await db.query("SELECT * FROM companies WHERE slug = $1 AND store_status = 'active'", [slug]);
  if (!c.rows.length) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));

  const company = c.rows[0];
  const products = await db.query('SELECT * FROM products WHERE company_id = $1 AND is_active = true ORDER BY created_at DESC', [company.id]);
  const html = fs.readFileSync(path.join(__dirname, 'public', 'store.html'), 'utf8')
    .replace('__COMPANY_DATA__', JSON.stringify(company))
    .replace('__PRODUCTS_DATA__', JSON.stringify(products.rows));
  res.send(html);
});

app.use(function(req, res) { res.status(404).sendFile(path.join(__dirname, 'public', '404.html')); });

initDb().then(function() {
  const bot = startBot();
  if (bot) global.__telegramBotInstance = bot;
  app.listen(PORT, function() { console.log('ðŸš€ Server running on port ' + PORT); });
}).catch(function(err) { console.error('Startup failed:', err); process.exit(1); });
