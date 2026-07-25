import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config';

export type MachineStatus = 'normal' | 'maintenance' | 'disabled';
export type MachineTypeStatus = 'active' | 'inactive';
export type RepairStatus = 'PENDING' | 'PROCESSING' | 'RESOLVED' | 'UNRESOLVED';
export type UserStatus = 'active' | 'disabled';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  oauth_provider TEXT NOT NULL,
  oauth_provider_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  avatar TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (oauth_provider, oauth_provider_user_id)
);

CREATE TABLE IF NOT EXISTS machine_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  category TEXT,
  description TEXT,
  image TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_type_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  machine_code TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal', 'maintenance', 'disabled')),
  qr_token TEXT NOT NULL UNIQUE,
  description TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (machine_type_id) REFERENCES machine_types(id)
);

CREATE TABLE IF NOT EXISTS repair_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'RESOLVED', 'UNRESOLVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repair_record_id INTEGER NOT NULL,
  machine_id INTEGER NOT NULL,
  operator_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repair_record_id) REFERENCES repair_records(id),
  FOREIGN KEY (machine_id) REFERENCES machines(id),
  FOREIGN KEY (operator_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_machines_type_id ON machines(machine_type_id);
CREATE INDEX IF NOT EXISTS idx_machines_qr_token ON machines(qr_token);
CREATE INDEX IF NOT EXISTS idx_repairs_machine_id_created_at ON repair_records(machine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repairs_status_created_at ON repair_records(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_machine_id_created_at ON maintenance_logs(machine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_repair_id_created_at ON maintenance_logs(repair_record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_hash ON admin_sessions(session_hash);
`;

db.exec(schema);
