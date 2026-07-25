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

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
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
  appUrl: process.env.APP_URL?.trim() || 'http://localhost:3000',
  port: Number(process.env.PORT || 3000),
  databasePath: process.env.DATABASE_PATH?.trim() || path.join(rootDir, 'data', 'arcade-atlas.sqlite'),
  sessionCookieName: 'arcade_atlas_session',
  oauthStateCookieName: 'arcade_atlas_oauth_state',
  allowFirstLogin: parseBoolean(process.env.ALLOW_FIRST_LOGIN, false),
  oauthAllowlist: parseAllowlist(process.env.OAUTH_ALLOWLIST),
  enabledProviders: [] as ProviderConfig[],
};

const githubClientId = readOptionalEnv('GITHUB_CLIENT_ID');
const githubClientSecret = readOptionalEnv('GITHUB_CLIENT_SECRET');

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
