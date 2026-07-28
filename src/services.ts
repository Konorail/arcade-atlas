import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { AuthMode, ProviderConfig, authModeAllowsGithub, authModeAllowsLocal, config, getRedirectUri, parseAllowlist, serializeAllowlist } from './config';
import { db, MachineStatus, MachineTypeStatus, RepairStatus, UserAuthType, UserStatus } from './db';

export type User = {
  id: number;
  auth_type: UserAuthType;
  username: string | null;
  password_hash: string | null;
  password_salt: string | null;
  oauth_provider: string | null;
  oauth_provider_user_id: string | null;
  name: string;
  email: string | null;
  avatar: string | null;
  status: UserStatus;
  created_at: string;
  updated_at: string;
};

export type MachineType = {
  id: number;
  name: string;
  brand: string | null;
  version: string | null;
  description: string | null;
  notes: string | null;
  status: MachineTypeStatus;
  created_at: string;
  updated_at: string;
  active_machine_count?: number;
};

export type Machine = {
  id: number;
  machine_type_id: number;
  name: string;
  machine_code: string;
  status: MachineStatus;
  qr_token: string;
  description: string | null;
  notes: string | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
  type_name?: string;
  brand?: string | null;
  version?: string | null;
};

export type RepairRecord = {
  id: number;
  machine_id: number;
  content: string;
  status: RepairStatus;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
  machine_name?: string;
  machine_code?: string;
  type_name?: string;
};

export type MaintenanceLog = {
  id: number;
  repair_record_id: number;
  machine_id: number;
  operator_id: number;
  content: string;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
  operator_name?: string;
  machine_name?: string;
  machine_code?: string;
  type_name?: string;
  repair_status?: RepairStatus;
  repair_content?: string;
};

export type MachineView = {
  machine: Machine;
  machineType: MachineType;
  recentRepairs: RepairRecord[];
  recentMaintenanceLogs: MaintenanceLog[];
};

export type GithubOAuthSettings = {
  clientId: string;
  clientSecret: string;
  allowlist: Set<string>;
  allowlistRaw: string;
};

export type AuthSettingsView = {
  authMode: AuthMode;
  localUsers: Array<Pick<User, 'id' | 'username' | 'name' | 'status'>>;
  github: {
    configured: boolean;
    clientId: string;
    allowlistRaw: string;
    callbackUrl: string;
    loginUrl: string;
  };
};

const repairStatuses: RepairStatus[] = ['PENDING', 'PROCESSING', 'RESOLVED'];
const machineStatuses: MachineStatus[] = ['normal', 'maintenance', 'disabled'];
const machineTypeStatuses: MachineTypeStatus[] = ['active', 'inactive'];
const githubProviderTemplate = {
  name: 'github' as const,
  displayName: 'GitHub',
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  userUrl: 'https://api.github.com/user',
  scopes: ['read:user', 'user:email'],
};
const settingKeys = {
  authMode: 'auth.mode',
  githubClientId: 'github.client_id',
  githubClientSecret: 'github.client_secret',
  githubAllowlist: 'github.allowlist',
} as const;

function now(): string {
  return new Date().toISOString();
}

const disallowedControlCharacterPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const dangerousSqlPattern = /(?:'|%27)\s*(?:or|and)\s+\d+\s*=\s*\d+|(?:--|#)\s*$|\/\*|\*\/|\bunion\s+select\b|;\s*(?:drop|delete|update|insert|select|alter|create|pragma)\b/i;

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateText(value: unknown, fieldName: string, options: { required?: boolean; maxLength: number }): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    if (options.required) {
      throw new Error(`${fieldName}不能为空。`);
    }
    return null;
  }

  if (normalized.length > options.maxLength) {
    throw new Error(`${fieldName}不能超过 ${options.maxLength} 个字符。`);
  }

  if (disallowedControlCharacterPattern.test(normalized)) {
    throw new Error(`${fieldName}包含无效字符。`);
  }

  if (dangerousSqlPattern.test(normalized)) {
    throw new Error(`${fieldName}包含不允许的危险字符组合。`);
  }

  return normalized;
}

function requiredText(value: unknown, fieldName: string, maxLength: number): string {
  const normalized = validateText(value, fieldName, { required: true, maxLength });
  if (!normalized) {
    throw new Error(`${fieldName}不能为空。`);
  }
  return normalized;
}

function optionalText(value: unknown, fieldName: string, maxLength: number): string | null {
  return validateText(value, fieldName, { maxLength });
}

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function optionalField(
  input: Record<string, unknown>,
  key: string,
  fieldName: string,
  maxLength: number,
  fallback: string | null,
): string | null {
  return hasOwn(input, key) ? optionalText(input[key], fieldName, maxLength) : fallback;
}

function optionalStatus<T extends string>(value: unknown, allowed: readonly T[], fieldName: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Invalid ${fieldName}.`);
  }
  return value as T;
}

function getSetting(key: string): string | undefined {
  const row = db.prepare(`SELECT setting_value FROM app_settings WHERE setting_key = ?`).get(key) as { setting_value: string } | undefined;
  return row?.setting_value;
}

function setSetting(key: string, value: string): void {
  const timestamp = now();
  db.prepare(
    `INSERT INTO app_settings (setting_key, setting_value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
  ).run(key, value, timestamp);
}

export function deleteSetting(key: string): void {
  db.prepare(`DELETE FROM app_settings WHERE setting_key = ?`).run(key);
}

export function getEffectiveAuthMode(): AuthMode {
  const stored = getSetting(settingKeys.authMode);
  if (stored === 'local' || stored === 'github' || stored === 'both') {
    return stored;
  }
  return config.authMode;
}

export function setEffectiveAuthMode(authMode: AuthMode): void {
  setSetting(settingKeys.authMode, authMode);
}

export function getGithubOAuthSettings(): GithubOAuthSettings | null {
  const clientId = getSetting(settingKeys.githubClientId) ?? config.oauthEnvConfig?.clientId;
  const clientSecret = getSetting(settingKeys.githubClientSecret) ?? config.oauthEnvConfig?.clientSecret;

  if (!clientId || !clientSecret) {
    return null;
  }

  const allowlistRaw = getSetting(settingKeys.githubAllowlist) ?? serializeAllowlist(config.oauthEnvConfig?.allowlist ?? []);
  return {
    clientId,
    clientSecret,
    allowlist: parseAllowlist(allowlistRaw),
    allowlistRaw,
  };
}

export function saveGithubOAuthSettings(input: { clientId: string; clientSecret?: string; allowlistRaw: string }): void {
  const clientId = requiredText(input.clientId, 'GitHub Client ID', 200);
  const existing = getGithubOAuthSettings();
  const clientSecret = input.clientSecret?.trim() ? requiredText(input.clientSecret, 'GitHub Client Secret', 200) : existing?.clientSecret;

  if (!clientSecret) {
    throw new Error('GitHub Client Secret is required when enabling GitHub OAuth.');
  }

  setSetting(settingKeys.githubClientId, clientId);
  setSetting(settingKeys.githubClientSecret, clientSecret);
  setSetting(settingKeys.githubAllowlist, optionalText(input.allowlistRaw, 'OAuth allowlist', 2000) ?? '');
}

export function getEnabledProviders(): ProviderConfig[] {
  if (!authModeAllowsGithub(getEffectiveAuthMode())) {
    return [];
  }

  const github = getGithubOAuthSettings();
  if (!github) {
    return [];
  }

  return [
    {
      ...githubProviderTemplate,
      clientId: github.clientId,
      clientSecret: github.clientSecret,
    },
  ];
}

export function getOAuthAllowlist(): Set<string> {
  return getGithubOAuthSettings()?.allowlist ?? new Set();
}

export function listLocalUsers(): Array<Pick<User, 'id' | 'username' | 'name' | 'status'>> {
  return db
    .prepare(`SELECT id, username, name, status FROM users WHERE auth_type = 'local' ORDER BY id ASC`)
    .all() as Array<Pick<User, 'id' | 'username' | 'name' | 'status'>>;
}

export function isLocalLoginEnabled(): boolean {
  return authModeAllowsLocal(getEffectiveAuthMode()) && listLocalUsers().length > 0;
}

export function findLocalUserByUsername(username: string): User | null {
  return (
    (db.prepare(`SELECT * FROM users WHERE auth_type = 'local' AND username = ?`).get(username) as User | undefined) ?? null
  );
}

export function upsertLocalUser(input: { username: string; passwordHash: string; passwordSalt: string; name?: string }): User {
  const username = requiredText(input.username, 'Local username', 80);
  const passwordHash = requiredText(input.passwordHash, 'Local password hash', 512);
  const passwordSalt = requiredText(input.passwordSalt, 'Local password salt', 512);
  const name = optionalText(input.name, 'User name', 80) ?? username;
  const timestamp = now();
  const existing = findLocalUserByUsername(username);

  if (existing) {
    db.prepare(
      `UPDATE users
       SET auth_type = 'local', password_hash = ?, password_salt = ?, name = ?, status = 'active', updated_at = ?
       WHERE id = ?`,
    ).run(passwordHash, passwordSalt, name || existing.name, timestamp, existing.id);
    return db.prepare(`SELECT * FROM users WHERE id = ?`).get(existing.id) as User;
  }

  const result = db
    .prepare(
      `INSERT INTO users (
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
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, 'active', ?, ?)`,
    )
    .run('local', username, passwordHash, passwordSalt, name, timestamp, timestamp);

  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(result.lastInsertRowid) as User;
}

export function ensureBootstrapAuthConfig(): void {
  if (config.localAdminBootstrap) {
    upsertLocalUser({
      username: config.localAdminBootstrap.username,
      passwordHash: config.localAdminBootstrap.passwordHash,
      passwordSalt: config.localAdminBootstrap.passwordSalt,
      name: config.localAdminBootstrap.username,
    });
  }
}

export function getAuthSettingsView(): AuthSettingsView {
  const github = getGithubOAuthSettings();
  return {
    authMode: getEffectiveAuthMode(),
    localUsers: listLocalUsers(),
    github: {
      configured: Boolean(github),
      clientId: github?.clientId ?? '',
      allowlistRaw: github?.allowlistRaw ?? '',
      callbackUrl: getRedirectUri('github'),
      loginUrl: `${config.appUrl}/login`,
    },
  };
}

export function createQrToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function hashSessionToken(sessionToken: string): string {
  return crypto.createHash('sha256').update(sessionToken).digest('hex');
}

export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  const timestamp = now();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();

  db.prepare(
    `INSERT INTO admin_sessions (session_hash, user_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(hashSessionToken(token), userId, timestamp, expiresAt, timestamp);

  return token;
}

export function getSessionUser(sessionToken: string | undefined): User | null {
  if (!sessionToken) {
    return null;
  }

  const row = db
    .prepare(
      `SELECT users.*
       FROM admin_sessions
       JOIN users ON users.id = admin_sessions.user_id
       WHERE admin_sessions.session_hash = ?
         AND admin_sessions.expires_at > ?
         AND users.status = 'active'`,
    )
    .get(hashSessionToken(sessionToken), now()) as User | undefined;

  if (!row) {
    return null;
  }

  db.prepare(`UPDATE admin_sessions SET last_seen_at = ? WHERE session_hash = ?`).run(now(), hashSessionToken(sessionToken));
  return row;
}

export function deleteSession(sessionToken: string | undefined): void {
  if (!sessionToken) {
    return;
  }

  db.prepare(`DELETE FROM admin_sessions WHERE session_hash = ?`).run(hashSessionToken(sessionToken));
}

export function upsertOAuthUser(input: {
  provider: string;
  providerUserId: string;
  name: string;
  email?: string | null;
  avatar?: string | null;
}): User {
  const timestamp = now();
  const name = requiredText(input.name, 'User name', 80);
  const email = optionalText(input.email, 'User email', 254);
  const avatar = optionalText(input.avatar, 'User avatar', 500);
  const existing = db
    .prepare(`SELECT * FROM users WHERE oauth_provider = ? AND oauth_provider_user_id = ?`)
    .get(input.provider, input.providerUserId) as User | undefined;

  if (existing) {
    db.prepare(
      `UPDATE users
       SET auth_type = 'oauth', name = ?, email = ?, avatar = ?, updated_at = ?
       WHERE id = ?`,
    ).run(name, email, avatar, timestamp, existing.id);

    return db.prepare(`SELECT * FROM users WHERE id = ?`).get(existing.id) as User;
  }

  const result = db
    .prepare(
      `INSERT INTO users (
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
       ) VALUES (?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run('oauth', input.provider, input.providerUserId, name, email, avatar, timestamp, timestamp);

  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(result.lastInsertRowid) as User;
}

export function findUserByProvider(provider: string, providerUserId: string): User | null {
  return (
    (db
      .prepare(`SELECT * FROM users WHERE oauth_provider = ? AND oauth_provider_user_id = ?`)
      .get(provider, providerUserId) as User | undefined) ?? null
  );
}

export function listMachineTypes(): MachineType[] {
  return db
    .prepare(
      `SELECT machine_types.*, COUNT(machines.id) AS active_machine_count
       FROM machine_types
       LEFT JOIN machines ON machines.machine_type_id = machine_types.id AND machines.status != 'disabled' AND machines.deleted_at IS NULL
       GROUP BY machine_types.id
       ORDER BY machine_types.status = 'active' DESC, machine_types.name ASC`,
    )
    .all() as MachineType[];
}

export function getMachineType(id: number): MachineType | null {
  return ((db.prepare(`SELECT * FROM machine_types WHERE id = ?`).get(id) as MachineType | undefined) ?? null);
}

export function createMachineType(input: Record<string, unknown>): MachineType {
  const timestamp = now();
  const result = db
    .prepare(
      `INSERT INTO machine_types (name, brand, version, description, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      requiredText(input.name, '机台类型名称', 80),
      optionalText(input.brand, '品牌', 80),
      optionalText(input.version, '版本', 80),
      optionalText(input.description, '描述', 1000),
      optionalText(input.notes, '备注', 1000),
      optionalStatus(input.status ?? 'active', machineTypeStatuses, 'machine type status'),
      timestamp,
      timestamp,
    );

  return db.prepare(`SELECT * FROM machine_types WHERE id = ?`).get(result.lastInsertRowid) as MachineType;
}

export function updateMachineType(id: number, input: Record<string, unknown>): MachineType {
  const machineType = getMachineType(id);
  if (!machineType) {
    throw new Error('Machine type not found.');
  }

  const timestamp = now();
  db.prepare(
    `UPDATE machine_types
     SET name = ?, brand = ?, version = ?, description = ?, notes = ?, status = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    requiredText(input.name ?? machineType.name, '机台类型名称', 80),
    optionalField(input, 'brand', '品牌', 80, machineType.brand),
    optionalField(input, 'version', '版本', 80, machineType.version),
    optionalField(input, 'description', '描述', 1000, machineType.description),
    optionalField(input, 'notes', '备注', 1000, machineType.notes),
    optionalStatus(input.status ?? machineType.status, machineTypeStatuses, 'machine type status'),
    timestamp,
    id,
  );

  return db.prepare(`SELECT * FROM machine_types WHERE id = ?`).get(id) as MachineType;
}

export function listMachines(): Machine[] {
  return db
    .prepare(
      `SELECT machines.*, machine_types.name AS type_name, machine_types.brand, machine_types.version
       FROM machines
       JOIN machine_types ON machine_types.id = machines.machine_type_id
       WHERE machines.deleted_at IS NULL
       ORDER BY machines.status != 'disabled' DESC, machines.created_at DESC`,
    )
    .all() as Machine[];
}

export function listPublicMachines(): Machine[] {
  return db
    .prepare(
      `SELECT machines.*, machine_types.name AS type_name, machine_types.brand, machine_types.version
       FROM machines
       JOIN machine_types ON machine_types.id = machines.machine_type_id
       WHERE machine_types.status = 'active'
         AND machines.deleted_at IS NULL
       ORDER BY machine_types.name ASC, machines.name ASC`,
    )
    .all() as Machine[];
}

export function getMachine(id: number): Machine | null {
  return (
    (db
      .prepare(
        `SELECT machines.*, machine_types.name AS type_name, machine_types.brand, machine_types.version
         FROM machines
         JOIN machine_types ON machine_types.id = machines.machine_type_id
         WHERE machines.id = ?
           AND machines.deleted_at IS NULL`,
      )
      .get(id) as Machine | undefined) ?? null
  );
}

export function getMachineByToken(token: string): Machine | null {
  return (
    (db
      .prepare(
        `SELECT machines.*, machine_types.name AS type_name, machine_types.brand, machine_types.version
         FROM machines
         JOIN machine_types ON machine_types.id = machines.machine_type_id
        WHERE machines.qr_token = ?
          AND machines.deleted_at IS NULL`,
      )
      .get(token) as Machine | undefined) ?? null
  );
}

export function createMachine(input: Record<string, unknown>): Machine {
  const machineTypeId = Number(input.machine_type_id);
  if (!Number.isInteger(machineTypeId)) {
    throw new Error('Machine type is required.');
  }

  if (!getMachineType(machineTypeId)) {
    throw new Error('Machine type not found.');
  }

  const timestamp = now();
  const result = db
    .prepare(
      `INSERT INTO machines (machine_type_id, name, machine_code, location, status, qr_token, description, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      machineTypeId,
      requiredText(input.name, '机台名称', 80),
      requiredText(input.machine_code, '机台编号', 64),
      '',
      optionalStatus(input.status ?? 'normal', machineStatuses, 'machine status'),
      createQrToken(),
      optionalText(input.description, '描述', 1000),
      optionalText(input.notes, '备注', 1000),
      timestamp,
      timestamp,
    );

  return getMachine(Number(result.lastInsertRowid)) as Machine;
}

export function updateMachine(id: number, input: Record<string, unknown>): Machine {
  const machine = getMachine(id);
  if (!machine) {
    throw new Error('Machine not found.');
  }

  const machineTypeId = Number(input.machine_type_id ?? machine.machine_type_id);
  if (!Number.isInteger(machineTypeId) || !getMachineType(machineTypeId)) {
    throw new Error('Machine type not found.');
  }

  const timestamp = now();
  db.prepare(
    `UPDATE machines
     SET machine_type_id = ?, name = ?, machine_code = ?, status = ?, description = ?, notes = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    machineTypeId,
    requiredText(input.name ?? machine.name, '机台名称', 80),
    requiredText(input.machine_code ?? machine.machine_code, '机台编号', 64),
    optionalStatus(input.status ?? machine.status, machineStatuses, 'machine status'),
    optionalField(input, 'description', '描述', 1000, machine.description),
    optionalField(input, 'notes', '备注', 1000, machine.notes),
    timestamp,
    id,
  );

  return getMachine(id) as Machine;
}

export function regenerateMachineQrToken(id: number): Machine {
  const machine = getMachine(id);
  if (!machine) {
    throw new Error('Machine not found.');
  }

  db.prepare(`UPDATE machines SET qr_token = ?, updated_at = ? WHERE id = ?`).run(createQrToken(), now(), id);
  return getMachine(id) as Machine;
}

export function deleteMachine(id: number): { machine: Machine; relatedRepairs: number; relatedMaintenanceLogs: number } {
  const machine = getMachine(id);
  if (!machine) {
    throw new Error('Machine not found.');
  }

  const relatedRepairs = db.prepare(`SELECT COUNT(*) AS count FROM repair_records WHERE machine_id = ?`).get(id) as { count: number };
  const relatedMaintenanceLogs = db.prepare(`SELECT COUNT(*) AS count FROM maintenance_logs WHERE machine_id = ?`).get(id) as { count: number };
  const timestamp = now();

  db.prepare(`UPDATE machines SET deleted_at = ?, status = 'disabled', updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(timestamp, timestamp, id);

  return {
    machine,
    relatedRepairs: relatedRepairs.count,
    relatedMaintenanceLogs: relatedMaintenanceLogs.count,
  };
}

export async function createQrCodeDataUrl(machine: Machine): Promise<string> {
  const publicUrl = `${config.appUrl}/machine/${machine.qr_token}`;
  return QRCode.toDataURL(publicUrl, { margin: 1, width: 320 });
}

export async function createQrCodeBuffer(machine: Machine): Promise<Buffer> {
  const publicUrl = `${config.appUrl}/machine/${machine.qr_token}`;
  return QRCode.toBuffer(publicUrl, { margin: 1, width: 640 });
}

export function listRepairs(filters: { machineId?: number; status?: string; query?: string; from?: string; to?: string } = {}): RepairRecord[] {
  const conditions = ['repair_records.deleted_at IS NULL'];
  const values: Array<number | string> = [];

  if (filters.machineId) {
    conditions.push('repair_records.machine_id = ?');
    values.push(filters.machineId);
  }

  if (filters.status && repairStatuses.includes(filters.status as RepairStatus)) {
    conditions.push('repair_records.status = ?');
    values.push(filters.status);
  }

  if (filters.query) {
    conditions.push('repair_records.content LIKE ?');
    values.push(`%${filters.query.trim()}%`);
  }

  if (filters.from) {
    conditions.push('repair_records.created_at >= ?');
    values.push(filters.from);
  }

  if (filters.to) {
    conditions.push('repair_records.created_at <= ?');
    values.push(filters.to);
  }

  return db
    .prepare(
      `SELECT repair_records.*, machines.name AS machine_name, machines.machine_code, machine_types.name AS type_name
       FROM repair_records
       JOIN machines ON machines.id = repair_records.machine_id
       JOIN machine_types ON machine_types.id = machines.machine_type_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY repair_records.created_at DESC`,
    )
    .all(...values) as RepairRecord[];
}

export function getRepair(id: number): RepairRecord | null {
  return (
    (db
      .prepare(
        `SELECT repair_records.*, machines.name AS machine_name, machines.machine_code, machine_types.name AS type_name
         FROM repair_records
         JOIN machines ON machines.id = repair_records.machine_id
         JOIN machine_types ON machine_types.id = machines.machine_type_id
         WHERE repair_records.id = ?
           AND repair_records.deleted_at IS NULL`,
      )
      .get(id) as RepairRecord | undefined) ?? null
  );
}

export function getRecentMachineRepairs(machineId: number, limit = 10): RepairRecord[] {
  return db
    .prepare(
      `SELECT * FROM repair_records WHERE machine_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`,
    )
    .all(machineId, limit) as RepairRecord[];
}

export function createRepairForMachineToken(machineToken: string, input: Record<string, unknown>): RepairRecord {
  const machine = getMachineByToken(machineToken);
  if (!machine) {
    throw new Error('Machine not found.');
  }

  const timestamp = now();
  const result = db
    .prepare(
      `INSERT INTO repair_records (machine_id, content, status, created_at, updated_at)
       VALUES (?, ?, 'PENDING', ?, ?)`,
    )
    .run(machine.id, requiredText(input.content, '报修内容', 1000), timestamp, timestamp);

  return getRepair(Number(result.lastInsertRowid)) as RepairRecord;
}

export function updateRepairStatus(id: number, status: string): RepairRecord {
  const repair = getRepair(id);
  if (!repair) {
    throw new Error('Repair record not found.');
  }

  const normalizedStatus = optionalStatus(status, repairStatuses, 'repair status');
  db.prepare(`UPDATE repair_records SET status = ?, updated_at = ? WHERE id = ?`).run(normalizedStatus, now(), id);
  return getRepair(id) as RepairRecord;
}

export function deleteRepair(id: number): { repair: RepairRecord; maintenanceLogs: number } {
  const repair = getRepair(id);
  if (!repair) {
    throw new Error('Repair record not found.');
  }

  const maintenanceLogs = db.prepare(`SELECT COUNT(*) AS count FROM maintenance_logs WHERE repair_record_id = ? AND deleted_at IS NULL`).get(id) as { count: number };
  const timestamp = now();
  db.prepare(`UPDATE repair_records SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(timestamp, timestamp, id);
  return { repair, maintenanceLogs: maintenanceLogs.count };
}

export function listMaintenanceLogsForMachine(machineId: number, limit = 10): MaintenanceLog[] {
  return db
    .prepare(
      `SELECT maintenance_logs.*, users.name AS operator_name
       FROM maintenance_logs
       JOIN repair_records ON repair_records.id = maintenance_logs.repair_record_id
       JOIN users ON users.id = maintenance_logs.operator_id
       WHERE maintenance_logs.machine_id = ?
        AND maintenance_logs.deleted_at IS NULL
        AND repair_records.deleted_at IS NULL
       ORDER BY maintenance_logs.created_at DESC
       LIMIT ?`,
    )
    .all(machineId, limit) as MaintenanceLog[];
}

export function listMaintenanceLogsForRepair(repairId: number): MaintenanceLog[] {
  return db
    .prepare(
      `SELECT maintenance_logs.*, users.name AS operator_name, machines.name AS machine_name, machines.machine_code, machine_types.name AS type_name, repair_records.status AS repair_status, repair_records.content AS repair_content
       FROM maintenance_logs
       JOIN repair_records ON repair_records.id = maintenance_logs.repair_record_id
       JOIN users ON users.id = maintenance_logs.operator_id
       JOIN machines ON machines.id = maintenance_logs.machine_id
       JOIN machine_types ON machine_types.id = machines.machine_type_id
       WHERE maintenance_logs.repair_record_id = ?
        AND maintenance_logs.deleted_at IS NULL
        AND repair_records.deleted_at IS NULL
       ORDER BY maintenance_logs.created_at DESC`,
    )
    .all(repairId) as MaintenanceLog[];
}

export function listMaintenanceLogs(): MaintenanceLog[] {
  return db
    .prepare(
      `SELECT maintenance_logs.*, users.name AS operator_name, machines.name AS machine_name, machines.machine_code, machine_types.name AS type_name, repair_records.status AS repair_status, repair_records.content AS repair_content
       FROM maintenance_logs
       JOIN repair_records ON repair_records.id = maintenance_logs.repair_record_id
       JOIN users ON users.id = maintenance_logs.operator_id
       JOIN machines ON machines.id = maintenance_logs.machine_id
       JOIN machine_types ON machine_types.id = machines.machine_type_id
       WHERE maintenance_logs.deleted_at IS NULL
        AND repair_records.deleted_at IS NULL
       ORDER BY maintenance_logs.created_at DESC`,
    )
    .all() as MaintenanceLog[];
}

export function getMaintenanceLog(id: number): MaintenanceLog | null {
  return (
    (db
      .prepare(
       `SELECT maintenance_logs.*, users.name AS operator_name, machines.name AS machine_name, machines.machine_code, machine_types.name AS type_name, repair_records.status AS repair_status, repair_records.content AS repair_content
        FROM maintenance_logs
        JOIN repair_records ON repair_records.id = maintenance_logs.repair_record_id
        JOIN users ON users.id = maintenance_logs.operator_id
        JOIN machines ON machines.id = maintenance_logs.machine_id
        JOIN machine_types ON machine_types.id = machines.machine_type_id
        WHERE maintenance_logs.id = ?
          AND maintenance_logs.deleted_at IS NULL
          AND repair_records.deleted_at IS NULL`,
      )
      .get(id) as MaintenanceLog | undefined) ?? null
  );
}

export function listRecentRepairs(limit = 15): RepairRecord[] {
  return db
    .prepare(
      `SELECT repair_records.*, machines.name AS machine_name, machines.machine_code, machine_types.name AS type_name
       FROM repair_records
       JOIN machines ON machines.id = repair_records.machine_id
       JOIN machine_types ON machine_types.id = machines.machine_type_id
       WHERE repair_records.deleted_at IS NULL
       ORDER BY repair_records.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as RepairRecord[];
}

export function listRecentMaintenanceLogs(limit = 15): MaintenanceLog[] {
  return db
    .prepare(
      `SELECT maintenance_logs.*, users.name AS operator_name, machines.name AS machine_name
       FROM maintenance_logs
       JOIN repair_records ON repair_records.id = maintenance_logs.repair_record_id
       JOIN users ON users.id = maintenance_logs.operator_id
       JOIN machines ON machines.id = maintenance_logs.machine_id
       WHERE maintenance_logs.deleted_at IS NULL
         AND repair_records.deleted_at IS NULL
       ORDER BY maintenance_logs.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as MaintenanceLog[];
}

export function createMaintenanceLog(repairId: number, operatorId: number, input: Record<string, unknown>): MaintenanceLog {
  const repair = getRepair(repairId);
  if (!repair) {
    throw new Error('Repair record not found.');
  }

  const content = [optionalText(input.result, '处理结果', 1000), requiredText(input.content, '处理内容', 2000)]
    .filter((value): value is string => Boolean(value))
    .join('\n\n');
  const timestamp = now();
  const result = db
    .prepare(
      `INSERT INTO maintenance_logs (repair_record_id, machine_id, operator_id, content, result, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      repairId,
      repair.machine_id,
      operatorId,
      content,
      '',
      timestamp,
      timestamp,
    );

  if (typeof input.repair_status === 'string' && repairStatuses.includes(input.repair_status as RepairStatus)) {
    updateRepairStatus(repairId, input.repair_status);
  }

  return getMaintenanceLog(Number(result.lastInsertRowid)) as MaintenanceLog;
}

export function deleteMaintenanceLog(id: number): MaintenanceLog {
  const maintenanceLog = getMaintenanceLog(id);
  if (!maintenanceLog) {
    throw new Error('Maintenance log not found.');
  }

  const timestamp = now();
  db.prepare(`UPDATE maintenance_logs SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`).run(timestamp, timestamp, id);
  return maintenanceLog;
}

export function getMachineViewByToken(token: string): MachineView | null {
  const machine = getMachineByToken(token);
  if (!machine) {
    return null;
  }

  const machineType = getMachineType(machine.machine_type_id);
  if (!machineType) {
    return null;
  }

  return {
    machine,
    machineType,
    recentRepairs: getRecentMachineRepairs(machine.id, 10),
    recentMaintenanceLogs: listMaintenanceLogsForMachine(machine.id, 10),
  };
}

export function getMachineHistory(id: number): MachineView | null {
  const machine = getMachine(id);
  if (!machine) {
    return null;
  }

  const machineType = getMachineType(machine.machine_type_id);
  if (!machineType) {
    return null;
  }

  return {
    machine,
    machineType,
    recentRepairs: getRecentMachineRepairs(machine.id, 50),
    recentMaintenanceLogs: listMaintenanceLogsForMachine(machine.id, 50),
  };
}

export function getStatusOptions() {
  return {
    repairStatuses,
    machineStatuses,
    machineTypeStatuses,
  };
}
