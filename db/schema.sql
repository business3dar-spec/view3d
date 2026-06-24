-- ── Core tables (unchanged from before, kept for compatibility) ──────────
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

-- ── Safe-upgrade columns on companies ─────────────────────────────────────
ALTER TABLE companies ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_type TEXT DEFAULT 'other';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cover_url TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS owner_name TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS store_status TEXT DEFAULT 'draft';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_proof_url TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS payment_note TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS companies_slug_idx ON companies (slug) WHERE slug IS NOT NULL;

-- ── Safe-upgrade columns on products ──────────────────────────────────────
ALTER TABLE products ADD COLUMN IF NOT EXISTS price NUMERIC(10,2) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'other';
ALTER TABLE products ADD COLUMN IF NOT EXISTS capture_token TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS capture_status TEXT DEFAULT 'not_started';
ALTER TABLE products ADD COLUMN IF NOT EXISTS kiri_serialize TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS model_url_required BOOLEAN DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS products_capture_token_idx ON products (capture_token) WHERE capture_token IS NOT NULL;

-- ── Onboarding session table — tracks each business owner's progress
--    through the multi-step Telegram flow. One row per Telegram chat
--    while they're mid-flow; cleared once the company record is created. ──
CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id SERIAL PRIMARY KEY,
  telegram_chat_id TEXT UNIQUE NOT NULL,
  step TEXT NOT NULL DEFAULT 'awaiting_company_name',
  company_name TEXT,
  owner_name TEXT,
  phone TEXT,
  business_type TEXT,
  draft_company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  current_product_name TEXT,
  current_product_description TEXT,
  current_product_price NUMERIC(10,2),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
