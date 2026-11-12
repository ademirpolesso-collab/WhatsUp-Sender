const Database = require('C:/mm-sender/node_modules/better-sqlite3');
const path = require('path');
const os   = require('os');
const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'whatsapp-sender', 'whatsapp-sender.db');
const d = new Database(dbPath, { readonly: true });

const contacts = d.prepare('SELECT id, name, phone FROM contacts LIMIT 5').all();
console.log('=== Contatos ===');
contacts.forEach(c => console.log(c.id, c.name, c.phone));

const logs = d.prepare('SELECT c.name, c.phone, s.status, s.error_msg FROM send_log s JOIN contacts c ON c.id=s.contact_id ORDER BY s.id DESC LIMIT 5').all();
console.log('\n=== Últimos envios ===');
logs.forEach(l => console.log(l.name, l.phone, l.status, l.error_msg || ''));
d.close();
