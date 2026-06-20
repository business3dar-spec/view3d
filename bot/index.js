const TelegramBot = require('node-telegram-bot-api');
const db = require('../db');

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}

function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminId = String(process.env.ADMIN_USER_ID);
  if (!token) { console.warn('No bot token'); return null; }
  const bot = new TelegramBot(token, { polling: true });
  console.log('ðŸ¤– Bot started');
  const isAdmin = id => String(id) === adminId;

  bot.onText(/\/start/, async msg => {
    const chatId = msg.chat.id;
    try {
      const r = await db.query('SELECT * FROM companies WHERE telegram_chat_id=$1', [String(chatId)]);
      if (r.rows.length) {
        const c = r.rows[0];
        const e = { approved: 'âœ…', pending: 'â³', rejected: 'âŒ' }[c.payment_status] || 'â“';
        bot.sendMessage(chatId,
          `Welcome back *${c.name}*!\nStatus: ${e} ${c.payment_status}` +
          (c.payment_status === 'approved' ? `\n\nYour store: ${process.env.BASE_URL}/store/${c.slug}` : ''),
          { parse_mode: 'Markdown' }
        );
      } else {
        bot.sendMessage(chatId, 'ðŸ‘‹ Welcome!\n\nTo register send:\n/register Your Company Name');
      }
    } catch (e) { bot.sendMessage(chatId, 'Error. Try again.'); }
  });

  bot.onText(/\/register (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const name = match[1].trim();
    try {
      const ex = await db.query('SELECT id FROM companies WHERE telegram_chat_id=$1', [String(chatId)]);
      if (ex.rows.length) return bot.sendMessage(chatId, 'Already registered. Use /status');

      const baseSlug = slugify(name);
      let slug = baseSlug, n = 1;
      while ((await db.query('SELECT id FROM companies WHERE slug=$1', [slug])).rows.length) {
        slug = `${baseSlug}-${n}`; n++;
      }

      const r = await db.query(
        `INSERT INTO companies (name,email,telegram_chat_id,payment_status,slug) VALUES ($1,$2,$3,'pending',$4) RETURNING id`,
        [name, `tg_${chatId}@x.com`, String(chatId), slug]
      );
      const id = r.rows[0].id;
      bot.sendMessage(chatId, `âœ… Registered!\nCompany: *${name}*\nStatus: â³ Pending approval`, { parse_mode: 'Markdown' });
      if (adminId) bot.sendMessage(adminId, `ðŸ†• New: *${name}* (ID:${id})\n/approve ${id}\n/reject ${id}`, { parse_mode: 'Markdown' });
    } catch (e) { bot.sendMessage(chatId, 'Failed. Try again.'); }
  });

  bot.onText(/\/status/, async msg => {
    const chatId = msg.chat.id;
    try {
      const r = await db.query('SELECT * FROM companies WHERE telegram_chat_id=$1', [String(chatId)]);
      if (!r.rows.length) return bot.sendMessage(chatId, 'Not registered. Use /register');
      const c = r.rows[0];
      const e = { approved: 'âœ…', pending: 'â³', rejected: 'âŒ' }[c.payment_status] || 'â“';
      bot.sendMessage(chatId,
        `*${c.name}*\nStatus: ${e} ${c.payment_status}` +
        (c.payment_status === 'approved' ? `\n\nStore: ${process.env.BASE_URL}/store/${c.slug}\nDashboard: ${process.env.BASE_URL}/dashboard/${c.id}` : ''),
        { parse_mode: 'Markdown' }
      );
    } catch (e) { bot.sendMessage(chatId, 'Error.'); }
  });

  bot.onText(/\/pending/, async msg => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, 'Admin only.');
    try {
      const r = await db.query(`SELECT id,name FROM companies WHERE payment_status='pending'`);
      if (!r.rows.length) return bot.sendMessage(chatId, 'None pending.');
      let t = `â³ Pending:\n\n`;
      r.rows.forEach(c => { t += `[${c.id}] ${c.name}\n/approve ${c.id}  /reject ${c.id}\n\n`; });
      bot.sendMessage(chatId, t);
    } catch (e) { bot.sendMessage(chatId, 'Error.'); }
  });

  bot.onText(/\/approve (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, 'Admin only.');
    try {
      const r = await db.query(`UPDATE companies SET payment_status='approved' WHERE id=$1 RETURNING *`, [match[1]]);
      if (!r.rows.length) return bot.sendMessage(chatId, 'Not found.');
      const c = r.rows[0];
      bot.sendMessage(chatId, `âœ… Approved: ${c.name}`);
      if (c.telegram_chat_id) bot.sendMessage(c.telegram_chat_id,
        `ðŸŽ‰ Approved!\n\nYour store: ${process.env.BASE_URL}/store/${c.slug}\nDashboard (upload products): ${process.env.BASE_URL}/dashboard/${c.id}`
      );
    } catch (e) { bot.sendMessage(chatId, 'Error.'); }
  });

  bot.onText(/\/reject (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, 'Admin only.');
    try {
      const r = await db.query(`UPDATE companies SET payment_status='rejected' WHERE id=$1 RETURNING *`, [match[1]]);
      if (!r.rows.length) return bot.sendMessage(chatId, 'Not found.');
      bot.sendMessage(chatId, `âŒ Rejected: ${r.rows[0].name}`);
      if (r.rows[0].telegram_chat_id) bot.sendMessage(r.rows[0].telegram_chat_id, 'Your registration was not approved.');
    } catch (e) { bot.sendMessage(chatId, 'Error.'); }
  });

  bot.onText(/\/list/, async msg => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return bot.sendMessage(chatId, 'Admin only.');
    try {
      const r = await db.query('SELECT id,name,payment_status FROM companies ORDER BY id DESC LIMIT 20');
      if (!r.rows.length) return bot.sendMessage(chatId, 'No companies yet.');
      let t = 'ðŸ“‹ Companies:\n\n';
      r.rows.forEach(c => { const e = { approved: 'âœ…', pending: 'â³', rejected: 'âŒ' }[c.payment_status] || 'â“'; t += `${e} [${c.id}] ${c.name}\n`; });
      bot.sendMessage(chatId, t);
    } catch (e) { bot.sendMessage(chatId, 'Error.'); }
  });

  return bot;
}
module.exports = { startBot };
