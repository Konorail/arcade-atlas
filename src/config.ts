import './env';
import path from 'node:path';

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

const rootDir = process.cwd();

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

  return parsed.toString().replace(/\/+$/, '');
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

function parseAllowlist(value: string | undefined): Set<string> {
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

export const config = {
  appName: process.env.APP_NAME?.trim() || 'Arcade Atlas',
  appUrl: parseAppUrl(process.env.APP_URL, 'http://localhost:3000'),
  port: parsePort(process.env.PORT, 3000),
  databasePath: resolveDatabasePath(process.env.DATABASE_PATH),
  sessionCookieName: 'arcade_atlas_session',
  oauthStateCookieName: 'arcade_atlas_oauth_state',
  allowFirstLogin: parseBoolean(process.env.ALLOW_FIRST_LOGIN, false),
  oauthAllowlist: parseAllowlist(process.env.OAUTH_ALLOWLIST),
  enabledProviders: [] as ProviderConfig[],
};

const githubClientId = readOptionalEnv('GITHUB_CLIENT_ID');
const githubClientSecret = readOptionalEnv('GITHUB_CLIENT_SECRET');

if ((githubClientId && !githubClientSecret) || (!githubClientId && githubClientSecret)) {
  throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be configured together.');
}

if (githubClientId && githubClientSecret) {
  config.enabledProviders.push({
    name: 'github',
    displayName: 'GitHub',
    clientId: githubClientId,
    clientSecret: githubClientSecret,
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    scopes: ['read:user', 'user:email'],
  });
}

export function getProvider(name: string): ProviderConfig | undefined {
  return config.enabledProviders.find((provider) => provider.name === name);
}

export function getRedirectUri(providerName: OAuthProviderName): string {
  return `${config.appUrl}/auth/${providerName}/callback`;
}

export function getAllowlistKey(providerName: string, providerUserId: string): string {
  return `${providerName}:${providerUserId}`;
}

export function isAllowlisted(providerName: string, providerUserId: string): boolean {
  if (config.oauthAllowlist.size === 0) {
    return false;
  }

  return config.oauthAllowlist.has(getAllowlistKey(providerName, providerUserId));
}
