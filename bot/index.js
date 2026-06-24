const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const db = require('../db');
const kiri = require('../kiri');

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}

const BUSINESS_TYPES = [
  { key: 'restaurant',  label: 'ðŸ½ Restaurant' },
  { key: 'furniture',   label: 'ðŸª‘ Furniture Store' },
  { key: 'electronics', label: 'ðŸ“± Electronics Store' },
  { key: 'fashion',     label: 'ðŸ‘— Fashion Store' },
  { key: 'lighting',    label: 'ðŸ’¡ Lighting Store' },
  { key: 'other',       label: 'ðŸ“¦ Other' }
];

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  STATE MACHINE OVERVIEW (one row per chat in onboarding_sessions)
//
//  awaiting_company_name â†’ awaiting_owner_name â†’ awaiting_phone â†’
//  awaiting_business_type (buttons) â†’ awaiting_payment_proof â†’
//  [admin approves payment] â†’ awaiting_product_name â†’ awaiting_product_desc â†’
//  awaiting_product_price â†’ awaiting_capture (link sent, bot waits) â†’
//  awaiting_add_another (buttons: yes/no) â†’ [loop back to product_name, or]
//  awaiting_admin_approval â†’ [admin approves] â†’ DONE, session cleared
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function getSession(chatId) {
  const r = await db.query('SELECT * FROM onboarding_sessions WHERE telegram_chat_id = $1', [String(chatId)]);
  return r.rows[0] || null;
}

async function setSession(chatId, fields) {
  const existing = await getSession(chatId);
  if (!existing) {
    const cols = ['telegram_chat_id', ...Object.keys(fields)];
    const vals = [String(chatId), ...Object.values(fields)];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    await db.query(`INSERT INTO onboarding_sessions (${cols.join(',')}) VALUES (${placeholders})`, vals);
  } else {
    const setClauses = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(', ');
    await db.query(
      `UPDATE onboarding_sessions SET ${setClauses}, updated_at = NOW() WHERE telegram_chat_id = $1`,
      [String(chatId), ...Object.values(fields)]
    );
  }
}

async function clearSession(chatId) {
  await db.query('DELETE FROM onboarding_sessions WHERE telegram_chat_id = $1', [String(chatId)]);
}

function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminId = String(process.env.ADMIN_USER_ID);
  if (!token) { console.warn('No bot token'); return null; }
  const bot = new TelegramBot(token, { polling: true });
  console.log('ðŸ¤– Bot started');
  const isAdmin = id => String(id) === adminId;

  // â”€â”€ /start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.onText(/\/start/, async msg => {
    const chatId = msg.chat.id;
    try {
      const r = await db.query('SELECT * FROM companies WHERE telegram_chat_id=$1', [String(chatId)]);
      if (r.rows.length) {
        const c = r.rows[0];
        bot.sendMessage(chatId, statusMessage(c), { parse_mode: 'Markdown' });
      } else {
        const session = await getSession(chatId);
        if (session) {
          bot.sendMessage(chatId, "ðŸ‘‹ Welcome back! You have a registration in progress.\n\nSend /continue to pick up where you left off, or /cancel to start over.");
        } else {
          bot.sendMessage(chatId, 'ðŸ‘‹ Welcome to *View3D*!\n\nLet\'s set up your 3D showroom. Send /register to begin.', { parse_mode: 'Markdown' });
        }
      }
    } catch (e) { bot.sendMessage(chatId, 'Error. Try again.'); }
  });

  function statusMessage(c) {
    const statusLabels = {
      draft: 'ðŸ“ Draft',
      pending_payment: 'ðŸ’³ Pending Payment Verification',
      pending_approval: 'â³ Pending Approval',
      active: 'âœ… Active'
    };
    let msg = `*${c.name}*\nStatus: ${statusLabels[c.store_status] || c.store_status}`;
    if (c.store_status === 'active' && c.slug) {
      msg += `\n\nYour page: ${process.env.BASE_URL}/${c.slug}\nDashboard: ${process.env.BASE_URL}/dashboard/${c.id}`;
    }
    return msg;
  }

  // â”€â”€ /cancel â€” wipe any in-progress session â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.onText(/\/cancel/, async msg => {
    const chatId = msg.chat.id;
    await clearSession(chatId);
    bot.sendMessage(chatId, 'Registration cancelled. Send /register to start fresh.');
  });

  // â”€â”€ /continue â€” resume wherever the session left off â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.onText(/\/continue/, async msg => {
    const chatId = msg.chat.id;
    const session = await getSession(chatId);
    if (!session) return bot.sendMessage(chatId, 'No registration in progress. Send /register to begin.');
    await promptForStep(chatId, session);
  });

  // â”€â”€ /register â€” begin the flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.onText(/\/register$/, async msg => {
    const chatId = msg.chat.id;
    const existingCompany = await db.query('SELECT id FROM companies WHERE telegram_chat_id=$1', [String(chatId)]);
    if (existingCompany.rows.length) return bot.sendMessage(chatId, 'You already have a business registered. Send /status to check it.');

    await setSession(chatId, { step: 'awaiting_company_name' });
    bot.sendMessage(chatId, "Let's set up your 3D showroom! ðŸª\n\nWhat is your *company name*?", { parse_mode: 'Markdown' });
  });

  // â”€â”€ Main text-message router â€” drives the step-by-step flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.on('message', async msg => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    // Ignore commands here â€” handled by their own onText listeners above
    if (text.startsWith('/')) return;

    const session = await getSession(chatId);
    if (!session) return; // not mid-flow, nothing to do

    switch (session.step) {
      case 'awaiting_company_name': {
        await setSession(chatId, { company_name: text, step: 'awaiting_owner_name' });
        bot.sendMessage(chatId, `Got it â€” *${text}*.\n\nWhat is your *name* (the owner/contact person)?`, { parse_mode: 'Markdown' });
        break;
      }

      case 'awaiting_owner_name': {
        await setSession(chatId, { owner_name: text, step: 'awaiting_phone' });
        bot.sendMessage(chatId, "Thanks! What's the best *phone number* to reach you on?", { parse_mode: 'Markdown' });
        break;
      }

      case 'awaiting_phone': {
        await setSession(chatId, { phone: text, step: 'awaiting_business_type' });
        bot.sendMessage(chatId, 'Last step before payment â€” what category best fits your business?', {
          reply_markup: { inline_keyboard: BUSINESS_TYPES.map(t => [{ text: t.label, callback_data: 'biztype:' + t.key }]) }
        });
        break;
      }

      case 'awaiting_payment_proof': {
        // Owner typed something instead of sending a photo â€” gently redirect
        bot.sendMessage(chatId, 'Please send a *photo* or *screenshot* of your payment as proof, or type /cancel to stop.', { parse_mode: 'Markdown' });
        break;
      }

      case 'awaiting_product_name': {
        await setSession(chatId, { current_product_name: text, step: 'awaiting_product_desc' });
        bot.sendMessage(chatId, `Nice. Give a short *description* for "${text}".`, { parse_mode: 'Markdown' });
        break;
      }

      case 'awaiting_product_desc': {
        await setSession(chatId, { current_product_description: text, step: 'awaiting_product_price' });
        bot.sendMessage(chatId, "What's the *price*? (numbers only, e.g. 1500)", { parse_mode: 'Markdown' });
        break;
      }

      case 'awaiting_product_price': {
        const price = parseFloat(text.replace(/[^0-9.]/g, ''));
        if (isNaN(price)) {
          bot.sendMessage(chatId, 'Please send the price as a number, e.g. 1500');
          break;
        }
        await handleProductPriceSubmitted(chatId, session, price);
        break;
      }

      case 'awaiting_capture':
      case 'awaiting_admin_approval':
      case 'awaiting_add_another':
        // These steps are driven by button taps or backend events, not free text
        break;

      default:
        break;
    }
  });

  // â”€â”€ Photo handler â€” used for payment proof screenshots â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.on('photo', async msg => {
    const chatId = msg.chat.id;
    const session = await getSession(chatId);
    if (!session || session.step !== 'awaiting_payment_proof') return;

    try {
      const photo = msg.photo[msg.photo.length - 1]; // highest resolution
      const fileLink = await bot.getFileLink(photo.file_id);

      // Create the draft company now, store the payment proof link, move to pending_payment
      const slug = await uniqueSlug(session.company_name);
      const result = await db.query(
        `INSERT INTO companies (name, email, telegram_chat_id, payment_status, slug, business_type, owner_name, phone, store_status, payment_proof_url)
         VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,'pending_payment',$8) RETURNING id`,
        [session.company_name, `tg_${chatId}@x.com`, String(chatId), slug, session.business_type, session.owner_name, session.phone, fileLink]
      );
      const companyId = result.rows[0].id;

      await setSession(chatId, { draft_company_id: companyId, step: 'awaiting_admin_payment_review' });

      bot.sendMessage(chatId, 'âœ… Payment proof received! An admin will verify it shortly. We\'ll notify you here once confirmed.');

      if (adminId) {
        bot.sendPhoto(adminId, photo.file_id, {
          caption: `ðŸ’³ *Payment proof submitted*\n\nCompany: *${session.company_name}*\nOwner: ${session.owner_name}\nPhone: ${session.phone}\nID: ${companyId}\n\n/approvepay ${companyId}\n/rejectpay ${companyId}`,
          parse_mode: 'Markdown'
        });
      }
    } catch (e) {
      bot.sendMessage(chatId, 'Something went wrong saving your payment proof. Please try again.');
    }
  });

  // â”€â”€ Document handler â€” used for the owner sending back a finished GLB â”€â”€â”€
  bot.on('document', async msg => {
    const chatId = msg.chat.id;
    const session = await getSession(chatId);
    const doc = msg.document;
    if (!doc || !doc.file_name || !doc.file_name.toLowerCase().endsWith('.glb')) return;
    if (!session || session.step !== 'awaiting_capture') return;

    try {
      const fileLink = await bot.getFileLink(doc.file_id);
      // Find the in-progress product for this session and attach the model link
      const product = await db.query(
        'SELECT * FROM products WHERE company_id = $1 ORDER BY id DESC LIMIT 1',
        [session.draft_company_id]
      );
      if (product.rows.length) {
        await db.query('UPDATE products SET model_url = $1, capture_status = $2 WHERE id = $3', [fileLink, 'completed', product.rows[0].id]);
      }
      await setSession(chatId, { step: 'awaiting_add_another' });
      bot.sendMessage(chatId, 'ðŸŽ‰ 3D model received and attached to your product!\n\nDo you want to add another product?', {
        reply_markup: { inline_keyboard: [[{ text: 'âž• Yes, add another', callback_data: 'addmore:yes' }, { text: 'âœ… No, I\'m done', callback_data: 'addmore:no' }]] }
      });
    } catch (e) {
      bot.sendMessage(chatId, 'Could not save that file. Please make sure it\'s a valid .glb file.');
    }
  });

  // â”€â”€ Callback queries â€” every inline button tap funnels through here â”€â”€â”€â”€â”€
  bot.on('callback_query', async query => {
    const chatId = query.message.chat.id;
    const data = query.data || '';

    if (data.startsWith('biztype:')) return handleBusinessType(query, chatId, data.replace('biztype:', ''));
    if (data.startsWith('addmore:')) return handleAddMore(query, chatId, data.replace('addmore:', ''));
  });

  async function handleBusinessType(query, chatId, businessType) {
    const session = await getSession(chatId);
    if (!session) return bot.answerCallbackQuery(query.id, { text: 'Session expired. Send /register again.' });

    await setSession(chatId, { business_type: businessType, step: 'awaiting_payment_proof' });
    bot.answerCallbackQuery(query.id, { text: 'Got it!' });

    const typeLabel = (BUSINESS_TYPES.find(t => t.key === businessType) || {}).label || businessType;
    bot.sendMessage(chatId,
      `Business type: ${typeLabel} âœ…\n\n` +
      `ðŸ’³ *Payment*\n\nTo activate your 3D showroom, please send payment to:\n\n` +
      `*Account:* (admin will share details)\n` +
      `*Amount:* Contact admin for current pricing\n\n` +
      `Once paid, send a *screenshot* of your payment confirmation here.`,
      { parse_mode: 'Markdown' }
    );
  }

  async function handleAddMore(query, chatId, answer) {
    bot.answerCallbackQuery(query.id);
    const session = await getSession(chatId);
    if (!session) return;

    if (answer === 'yes') {
      await setSession(chatId, { step: 'awaiting_product_name', current_product_name: null, current_product_description: null, current_product_price: null });
      bot.sendMessage(chatId, "Great! What's the name of the next product?");
    } else {
      await setSession(chatId, { step: 'awaiting_admin_approval' });
      bot.sendMessage(chatId, 'âœ… All set! Your submission is now with our admin team for final review.\n\nWe\'ll notify you here as soon as your store goes live.');
      if (adminId) {
        const company = await db.query('SELECT * FROM companies WHERE id = $1', [session.draft_company_id]);
        const products = await db.query('SELECT name FROM products WHERE company_id = $1', [session.draft_company_id]);
        const c = company.rows[0];
        bot.sendMessage(adminId,
          `ðŸ“‹ *Ready for final approval*\n\nCompany: *${c.name}*\nOwner: ${c.owner_name}\nPhone: ${c.phone}\nProducts: ${products.rows.map(p => p.name).join(', ')}\nID: ${c.id}\n\n/approve ${c.id}\n/reject ${c.id}`,
          { parse_mode: 'Markdown' }
        );
      }
    }
  }

  async function handleProductPriceSubmitted(chatId, session, price) {
    await setSession(chatId, { current_product_price: price });

    // Create the product row now (model_url is temporarily a placeholder until capture completes)
    const captureToken = crypto.randomBytes(16).toString('hex');
    const result = await db.query(
      `INSERT INTO products (company_id, name, description, price, category, model_url, capture_token, capture_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'not_started') RETURNING id`,
      [
        session.draft_company_id,
        session.current_product_name,
        session.current_product_description,
        price,
        session.business_type || 'other',
        'pending',
        captureToken
      ]
    );

    await setSession(chatId, { step: 'awaiting_capture' });

    const captureUrl = `${process.env.BASE_URL}/scan/${captureToken}`;
    bot.sendMessage(chatId,
      `ðŸ“¸ *Time to create the 3D model!*\n\n` +
      `Tap the link below to open the camera and take photos of "${session.current_product_name}". ` +
      `It'll guide you through everything â€” when you're done it'll say "Finished successfully" and we'll take care of the rest.\n\n` +
      `${captureUrl}\n\n` +
      `_Once your 3D model is ready, it'll be attached automatically. If you already have a .glb file, you can also just send it here directly._`,
      { parse_mode: 'Markdown' }
    );
  }

  async function uniqueSlug(name) {
    const base = slugify(name);
    let slug = base, n = 1;
    while ((await db.query('SELECT id FROM companies WHERE slug = $1', [slug])).rows.length) {
      slug = `${base}-${n}`; n++;
    }
    return slug;
  }

  async function promptForStep(chatId, session) {
    const prompts = {
      awaiting_company_name: "What is your *company name*?",
      awaiting_owner_name: "What is your *name* (owner/contact person)?",
      awaiting_phone: "What's the best *phone number* to reach you on?",
      awaiting_payment_proof: 'Please send a *photo* or *screenshot* of your payment as proof.',
      awaiting_product_name: "What's the name of the product?",
      awaiting_product_desc: "Give a short *description* for this product.",
      awaiting_product_price: "What's the *price*? (numbers only)",
      awaiting_capture: 'Please complete the 3D capture using the link sent earlier, or send the .glb file directly.',
      awaiting_admin_payment_review: 'Your payment is being reviewed by our admin. We\'ll notify you here once confirmed.',
      awaiting_admin_approval: 'Your submission is with our admin team for final review.'
    };
    bot.sendMessage(chatId, prompts[session.step] || 'Continuing your registrationâ€¦', { parse_mode: 'Markdown' });
  }

  // â”€â”€ /status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.onText(/\/status$/, async msg => {
    const chatId = msg.chat.id;
    const r = await db.query('SELECT * FROM companies WHERE telegram_chat_id=$1', [String(chatId)]);
    if (!r.rows.length) return bot.sendMessage(chatId, 'Not registered yet. Send /register to begin.');
    bot.sendMessage(chatId, statusMessage(r.rows[0]), { parse_mode: 'Markdown' });
  });

  // â”€â”€ ADMIN: /approvepay <id> â€” confirms payment, unlocks product step â”€â”€â”€â”€
  bot.onText(/\/approvepay (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, 'Admin only.');
    try {
      const r = await db.query(`UPDATE companies SET store_status = 'draft' WHERE id = $1 RETURNING *`, [match[1]]);
      if (!r.rows.length) return bot.sendMessage(chatId, 'Not found.');
      const c = r.rows[0];
      bot.sendMessage(chatId, `âœ… Payment confirmed for: ${c.name}`);

      if (c.telegram_chat_id) {
        await setSession(c.telegram_chat_id, { step: 'awaiting_product_name' });
        bot.sendMessage(c.telegram_chat_id,
          `ðŸŽ‰ Payment confirmed! Let's add your first product.\n\nWhat's the *name* of the product?`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (e) { bot.sendMessage(chatId, 'Error.'); }
  });

  bot.onText(/\/rejectpay (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, 'Admin only.');
    try {
      const r = await db.query('SELECT * FROM companies WHERE id = $1', [match[1]]);
      if (!r.rows.length) return bot.sendMessage(chatId, 'Not found.');
      bot.sendMessage(chatId, `âŒ Payment rejected for: ${r.rows[0].name}`);
      if (r.rows[0].telegram_chat_id) {
        bot.sendMessage(r.rows[0].telegram_chat_id, 'âŒ We couldn\'t verify your payment. Please contact admin or resend proof.');
      }
    } catch (e) { bot.sendMessage(chatId, 'Error.'); }
  });

  // â”€â”€ ADMIN: /approve <id> â€” final approval, store goes live â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.onText(/\/approve (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, 'Admin only.');
    try {
      const r = await db.query(
        `UPDATE companies SET payment_status = 'approved', store_status = 'active' WHERE id = $1 RETURNING *`,
        [match[1]]
      );
      if (!r.rows.length) return bot.sendMessage(chatId, 'Not found.');
      const c = r.rows[0];
      bot.sendMessage(chatId, `âœ… Approved & live: ${c.name}`);

      if (c.telegram_chat_id) {
        await clearSession(c.telegram_chat_id);
        bot.sendMessage(c.telegram_chat_id,
          `ðŸŽ‰ *Your store is now live!*\n\n` +
          `Your page: ${process.env.BASE_URL}/${c.slug}\n` +
          `Dashboard: ${process.env.BASE_URL}/dashboard/${c.id}\n\n` +
          `Customers can now browse your products in 3D & AR, and scan your QR code.`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (e) { bot.sendMessage(chatId, 'Error.'); }
  });

  bot.onText(/\/reject (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, 'Admin only.');
    try {
      const r = await db.query(`UPDATE companies SET payment_status='rejected' WHERE id=$1 RETURNING *`, [match[1]]);
      if (!r.rows.length) return bot.sendMessage(chatId, 'Not found.');
      bot.sendMessage(chatId, `âŒ Rejected: ${r.rows[0].name}`);
      if (r.rows[0].telegram_chat_id) bot.sendMessage(r.rows[0].telegram_chat_id, 'Your submission was not approved. Contact admin for details.');
    } catch (e) { bot.sendMessage(chatId, 'Error.'); }
  });

  // â”€â”€ ADMIN: /review <id> â€” full snapshot of a company before approving â”€â”€â”€â”€
  bot.onText(/\/review (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, 'Admin only.');
    try {
      const c = await db.query('SELECT * FROM companies WHERE id = $1', [match[1]]);
      if (!c.rows.length) return bot.sendMessage(chatId, 'Not found.');
      const company = c.rows[0];
      const products = await db.query('SELECT * FROM products WHERE company_id = $1', [company.id]);

      let text = `*${company.name}*\nOwner: ${company.owner_name}\nPhone: ${company.phone}\nType: ${company.business_type}\nStore status: ${company.store_status}\nPayment: ${company.payment_status}\n\n*Products (${products.rows.length}):*\n`;
      products.rows.forEach(p => {
        text += `â€¢ ${p.name} â€” $${p.price} (3D: ${p.capture_status})\n`;
      });
      text += `\n/approve ${company.id}\n/reject ${company.id}`;

      bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      if (company.payment_proof_url) bot.sendMessage(chatId, 'ðŸ’³ Payment proof: ' + company.payment_proof_url);
    } catch (e) { bot.sendMessage(chatId, 'Error.'); }
  });

  bot.onText(/\/pending/, async msg => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, 'Admin only.');
    try {
      const r = await db.query(`SELECT id, name, store_status FROM companies WHERE payment_status='pending'`);
      if (!r.rows.length) return bot.sendMessage(chatId, 'None pending.');
      let t = `â³ Pending:\n\n`;
      r.rows.forEach(c => { t += `[${c.id}] ${c.name} (${c.store_status})\n/review ${c.id}\n\n`; });
      bot.sendMessage(chatId, t);
    } catch (e) { bot.sendMessage(chatId, 'Error.'); }
  });

  bot.onText(/\/list/, async msg => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, 'Admin only.');
    try {
      const r = await db.query('SELECT id,name,payment_status,store_status FROM companies ORDER BY id DESC LIMIT 20');
      if (!r.rows.length) return bot.sendMessage(chatId, 'No companies yet.');
      let t = 'ðŸ“‹ Companies:\n\n';
      r.rows.forEach(c => { t += `[${c.id}] ${c.name} â€” ${c.store_status}\n`; });
      bot.sendMessage(chatId, t);
    } catch (e) { bot.sendMessage(chatId, 'Error.'); }
  });

  // Exposed so index.js can resume the conversation automatically once
  // KIRI's background processing finishes (the owner never has to do
  // anything after tapping "Finish" in the capture page).
  global.__telegramOnCaptureComplete = async function(companyId, text) {
    try {
      const c = await db.query('SELECT telegram_chat_id FROM companies WHERE id = $1', [companyId]);
      const chatId = c.rows[0] && c.rows[0].telegram_chat_id;
      if (!chatId) return;

      bot.sendMessage(chatId, text);

      const session = await getSession(chatId);
      if (session && session.step === 'awaiting_capture') {
        await setSession(chatId, { step: 'awaiting_add_another' });
        bot.sendMessage(chatId, 'Do you want to add another product?', {
          reply_markup: { inline_keyboard: [[{ text: 'âž• Yes, add another', callback_data: 'addmore:yes' }, { text: 'âœ… No, I\'m done', callback_data: 'addmore:no' }]] }
        });
      }
    } catch (e) { console.error('telegramOnCaptureComplete error:', e); }
  };

  return bot;
}

module.exports = { startBot };
