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

['uploads/images','uploads/models'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
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
  const schema = fs.readFileSync('./db/schema.sql','utf8');
  await db.query(schema);
  console.log('✅ Database ready');
}

app.get('/', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.get('/view/:companyId', async (req,res) => {
  const r = await db.query('SELECT * FROM companies WHERE id=$1',[req.params.companyId]);
  if (!r.rows.length) return res.status(404).sendFile(path.join(__dirname,'public','404.html'));
  const company = r.rows[0];
  if (company.payment_status !== 'approved') return res.status(403).sendFile(path.join(__dirname,'public','blocked.html'));
  const products = await db.query('SELECT * FROM products WHERE company_id=$1 AND is_active=true ORDER BY created_at DESC',[req.params.companyId]);
  const html = fs.readFileSync(path.join(__dirname,'public','viewer.html'),'utf8')
    .replace('__COMPANY_DATA__', JSON.stringify(company))
    .replace('__PRODUCTS_DATA__', JSON.stringify(products.rows));
  res.send(html);
});

app.get('/dashboard/:companyId', async (req,res) => {
  const r = await db.query('SELECT * FROM companies WHERE id=$1',[req.params.companyId]);
  if (!r.rows.length) return res.status(404).sendFile(path.join(__dirname,'public','404.html'));
  if (r.rows[0].payment_status !== 'approved') return res.status(403).sendFile(path.join(__dirname,'public','blocked.html'));
  res.sendFile(path.join(__dirname,'public','dashboard.html'));
});

app.get('/api/company/:id', async (req,res) => {
  try {
    const c = await db.query('SELECT id,name,plan,payment_status FROM companies WHERE id=$1',[req.params.id]);
    if (!c.rows.length) return res.status(404).json({error:'Not found'});
    const p = await db.query('SELECT * FROM products WHERE company_id=$1 AND is_active=true ORDER BY created_at DESC',[req.params.id]);
    const l = await db.query('SELECT max_products FROM plan_limits WHERE plan=$1',[c.rows[0].plan]);
    res.json({ company:c.rows[0], products:p.rows, maxProducts:l.rows[0]?.max_products||5 });
  } catch(err){ res.status(500).json({error:'Server error'}); }
});

app.post('/api/products', upload.fields([{name:'model',maxCount:1},{name:'image',maxCount:1}]), async (req,res) => {
  try {
    const { company_id, name, description } = req.body;
    if (!company_id||!name) return res.status(400).json({error:'company_id and name required'});
    const cr = await db.query('SELECT * FROM companies WHERE id=$1 AND payment_status=$2',[company_id,'approved']);
    if (!cr.rows.length) return res.status(403).json({error:'Company not approved'});
    const lr = await db.query('SELECT max_products FROM plan_limits WHERE plan=$1',[cr.rows[0].plan]);
    const max = lr.rows[0]?.max_products||5;
    const count = await db.query('SELECT COUNT(*) FROM products WHERE company_id=$1',[company_id]);
    if (parseInt(count.rows[0].count)>=max) return res.status(400).json({error:`Plan limit reached (${max} products)`});
    if (!req.files?.model) return res.status(400).json({error:'Model file required'});
    const modelUrl = `/uploads/models/${req.files.model[0].filename}`;
    const imageUrl = req.files?.image ? `/uploads/images/${req.files.image[0].filename}` : null;
    const result = await db.query(
      'INSERT INTO products (company_id,name,description,image_url,model_url) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [company_id,name,description||'',imageUrl,modelUrl]
    );
    res.json({success:true,product:result.rows[0]});
  } catch(err){ res.status(500).json({error:err.message}); }
});

app.delete('/api/products/:id', async (req,res) => {
  try {
    const { company_id } = req.body;
    await db.query('UPDATE products SET is_active=false WHERE id=$1 AND company_id=$2',[req.params.id,company_id]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:'Delete failed'}); }
});

initDb().then(() => {
  startBot();
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}).catch(err => { console.error('Startup failed:',err); process.exit(1); });
