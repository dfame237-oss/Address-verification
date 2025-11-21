// db/db.js
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'app.db');
const INIT_SQL = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8');

const db = new Database(DB_FILE);
db.exec(INIT_SQL);

module.exports = db;
