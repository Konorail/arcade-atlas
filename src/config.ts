import './env';
import path from 'node:path';

export type AuthMode = 'local' | 'github' | 'both';
export type OAuthProviderName = 'github';

export type ProviderConfig = {
  name: OAuthProviderName;
  displayName: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  scopes: string[];
};

export type GithubOAuthConfig = {
  clientId: string;
  clientSecret: string;
  allowlist: Set<string>;
};

export type LocalAdminBootstrapConfig = {
  username: string;
  passwordHash: string;
  passwordSalt: string;
};

const rootDir = process.cwd();
const trailingSlashesPattern = /\/+$/;

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseAppUrl(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('APP_URL must be a valid http(s) URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('APP_URL must start with http:// or https://.');
  }

  return parsed.toString().replace(trailingSlashesPattern, '');
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  return port;
}

function resolveDatabasePath(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate) {
    return path.join(rootDir, 'data', 'arcade-atlas.sqlite');
  }

  return path.isAbsolute(candidate) ? candidate : path.resolve(rootDir, candidate);
}

export function parseAllowlist(value: string | undefined): Set<string> {
  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function serializeAllowlist(value: Iterable<string>): string {
  return [...value].join(',');
}

function parseAuthMode(value: string | undefined, fallback: AuthMode): AuthMode {
  const candidate = value?.trim().toLowerCase();
  if (!candidate) {
    return fallback;
  }

  if (candidate === 'local' || candidate === 'github' || candidate === 'both') {
    return candidate;
  }

  throw new Error('AUTH_MODE must be one of: local, github, both.');
}

function parseLocalAdminBootstrap(): LocalAdminBootstrapConfig | null {
  const username = readOptionalEnv('LOCAL_ADMIN_USERNAME');
  const passwordHash = readOptionalEnv('LOCAL_ADMIN_PASSWORD_HASH');
  const passwordSalt = readOptionalEnv('LOCAL_ADMIN_PASSWORD_SALT');

  if (!username && !passwordHash && !passwordSalt) {
    return null;
  }

  if (!username || !passwordHash || !passwordSalt) {
    throw new Error('LOCAL_ADMIN_USERNAME, LOCAL_ADMIN_PASSWORD_HASH, and LOCAL_ADMIN_PASSWORD_SALT must be configured together.');
  }

  return {
    username,
    passwordHash,
    passwordSalt,
  };
}

function parseGithubOAuthFromEnv(): GithubOAuthConfig | null {
  const clientId = readOptionalEnv('GITHUB_CLIENT_ID');
  const clientSecret = readOptionalEnv('GITHUB_CLIENT_SECRET');

  if (!clientId && !clientSecret) {
    return null;
  }

  if (!clientId || !clientSecret) {
    throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be configured together.');
  }

  return {
    clientId,
    clientSecret,
    allowlist: parseAllowlist(readOptionalEnv('OAUTH_ALLOWLIST')),
  };
}

const oauthEnvConfig = parseGithubOAuthFromEnv();
const localAdminBootstrap = parseLocalAdminBootstrap();

export const config = {
  appName: process.env.APP_NAME?.trim() || 'Arcade Atlas',
  appUrl: parseAppUrl(process.env.APP_URL, 'http://localhost:3000'),
  port: parsePort(process.env.PORT, 3000),
  databasePath: resolveDatabasePath(process.env.DATABASE_PATH),
  sessionCookieName: 'arcade_atlas_session',
  oauthStateCookieName: 'arcade_atlas_oauth_state',
  allowFirstLogin: parseBoolean(process.env.ALLOW_FIRST_LOGIN, false),
  authMode: parseAuthMode(process.env.AUTH_MODE, oauthEnvConfig ? 'github' : 'local'),
  oauthEnvConfig,
  localAdminBootstrap,
};

export function authModeAllowsLocal(authMode: AuthMode): boolean {
  return authMode === 'local' || authMode === 'both';
}

export function authModeAllowsGithub(authMode: AuthMode): boolean {
  return authMode === 'github' || authMode === 'both';
}

export function getRedirectUri(providerName: OAuthProviderName): string {
  return `${config.appUrl}/auth/${providerName}/callback`;
}

export function getAllowlistKey(providerName: string, providerUserId: string): string {
  return `${providerName}:${providerUserId}`;
}
