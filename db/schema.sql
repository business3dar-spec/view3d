CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  telegram_chat_id TEXT,
  payment_status TEXT DEFAULT 'pending',
  plan TEXT DEFAULT 'starter',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  model_url TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plan_limits (
  plan TEXT PRIMARY KEY,
  max_products INTEGER NOT NULL
);

INSERT INTO plan_limits (plan, max_products) VALUES ('starter', 5) ON CONFLICT DO NOTHING;
INSERT INTO plan_limits (plan, max_products) VALUES ('pro', 25) ON CONFLICT DO NOTHING;
INSERT INTO plan_limits (plan, max_products) VALUES ('enterprise', 999) ON CONFLICT DO NOTHING;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS bio TEXT;

ALTER TABLE products ADD COLUMN IF NOT EXISTS price NUMERIC(10,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'other';
