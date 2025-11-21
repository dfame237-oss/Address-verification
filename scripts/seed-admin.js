// scripts/seed-admin.js
require('dotenv').config();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');

(async () => {
  try {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);
    const now = new Date().toISOString();

    const exists = db.prepare('SELECT id FROM admin WHERE username = ?').get(username);
    if (exists) {
      db.prepare('UPDATE admin SET password_hash = ? WHERE username = ?').run(password_hash, username);
      console.log('Admin exists — password updated.');
      process.exit(0);
    }

    const id = uuidv4();
    db.prepare('INSERT INTO admin (id, username, password_hash, created_at) VALUES (?,?,?,?)')
      .run(id, username, password_hash, now);

    console.log(`Seeded admin ${username}`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
