import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config';

export type MachineStatus = 'normal' | 'maintenance' | 'disabled';
export type MachineTypeStatus = 'active' | 'inactive';
export type RepairStatus = 'PENDING' | 'PROCESSING' | 'RESOLVED' | 'UNRESOLVED';
export type UserStatus = 'active' | 'disabled';
export type UserAuthType = 'local' | 'oauth';
const introspectionTables = new Set(['users', 'machine_types', 'machines', 'repair_records', 'maintenance_logs', 'admin_sessions', 'app_settings']);

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function hasTable(name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return Boolean(row);
}

function hasColumn(table: string, column: string): boolean {
  if (!introspectionTables.has(table)) {
    throw new Error(`Unsupported table introspection target: ${table}`);
  }
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function rebuildLegacyUsersTable(): void {
  const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string; notnull: number }>;
  const oauthProviderColumn = columns.find((column) => column.name === 'oauth_provider');
  const oauthUserIdColumn = columns.find((column) => column.name === 'oauth_provider_user_id');
  const needsRebuild =
    !hasColumn('users', 'auth_type')
    || !hasColumn('users', 'username')
    || !hasColumn('users', 'password_hash')
    || !hasColumn('users', 'password_salt')
    || oauthProviderColumn?.notnull === 1
    || oauthUserIdColumn?.notnull === 1;

  if (!needsRebuild) {
    return;
  }

  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN TRANSACTION;
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      auth_type TEXT NOT NULL DEFAULT 'oauth' CHECK (auth_type IN ('local', 'oauth')),
      username TEXT UNIQUE,
      password_hash TEXT,
      password_salt TEXT,
      oauth_provider TEXT,
      oauth_provider_user_id TEXT,
      name TEXT NOT NULL,
      email TEXT,
      avatar TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (oauth_provider, oauth_provider_user_id)
    );
    INSERT INTO users_new (
      id,
      auth_type,
      username,
      password_hash,
      password_salt,
      oauth_provider,
      oauth_provider_user_id,
      name,
      email,
      avatar,
      status,
      created_at,
      updated_at
    )
    SELECT
      id,
      'oauth',
      NULL,
      NULL,
      NULL,
      oauth_provider,
      oauth_provider_user_id,
      name,
      email,
      avatar,
      status,
      created_at,
      updated_at
    FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function ensureUsersTableColumns(): void {
  if (!hasColumn('users', 'auth_type')) {
    db.exec(`ALTER TABLE users ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'oauth' CHECK (auth_type IN ('local', 'oauth'))`);
    db.exec(`UPDATE users SET auth_type = 'oauth' WHERE auth_type IS NULL OR auth_type = ''`);
  }

  if (!hasColumn('users', 'username')) {
    db.exec(`ALTER TABLE users ADD COLUMN username TEXT`);
  }

  if (!hasColumn('users', 'password_hash')) {
    db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
  }

  if (!hasColumn('users', 'password_salt')) {
    db.exec(`ALTER TABLE users ADD COLUMN password_salt TEXT`);
  }
}

function initializeSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      auth_type TEXT NOT NULL DEFAULT 'oauth' CHECK (auth_type IN ('local', 'oauth')),
      username TEXT UNIQUE,
      password_hash TEXT,
      password_salt TEXT,
      oauth_provider TEXT,
      oauth_provider_user_id TEXT,
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

    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_auth_type ON users(auth_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_users_oauth_lookup ON users(oauth_provider, oauth_provider_user_id);
    CREATE INDEX IF NOT EXISTS idx_machines_type_id ON machines(machine_type_id);
    CREATE INDEX IF NOT EXISTS idx_machines_qr_token ON machines(qr_token);
    CREATE INDEX IF NOT EXISTS idx_repairs_machine_id_created_at ON repair_records(machine_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_repairs_status_created_at ON repair_records(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_machine_id_created_at ON maintenance_logs(machine_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_repair_id_created_at ON maintenance_logs(repair_record_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_hash ON admin_sessions(session_hash);
  `);
}

if (hasTable('users')) {
  rebuildLegacyUsersTable();
}

initializeSchema();
ensureUsersTableColumns();

export function closeDatabase(): void {
  db.close();
}
