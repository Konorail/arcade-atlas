import crypto from 'node:crypto';
import { Request, Response } from 'express';
import { config, getProvider, getRedirectUri, isAllowlisted } from './config';
import { createSession, deleteSession, findUserByProvider, getSessionUser, upsertOAuthUser } from './services';

export type OAuthProfile = {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
};

export function parseCookies(request: Request): Record<string, string> {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return {};
  }

  return Object.fromEntries(
    cookieHeader
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separatorIndex = item.indexOf('=');
        if (separatorIndex < 0) {
          return [item, ''];
        }

        const key = item.slice(0, separatorIndex).trim();
        const value = item.slice(separatorIndex + 1).trim();
        return [key, decodeURIComponent(value)];
      }),
  );
}

export function setCookie(response: Response, name: string, value: string, maxAgeSeconds: number): void {
  response.cookie(name, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.appUrl.startsWith('https://'),
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearCookie(response: Response, name: string): void {
  response.cookie(name, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.appUrl.startsWith('https://'),
    path: '/',
    expires: new Date(0),
  });
}

export function getCurrentUser(request: Request) {
  const cookies = parseCookies(request);
  return getSessionUser(cookies[config.sessionCookieName]);
}

export function startAdminSession(response: Response, userId: number): void {
  const sessionToken = createSession(userId);
  setCookie(response, config.sessionCookieName, sessionToken, 60 * 60 * 24 * 14);
}

export function endAdminSession(request: Request, response: Response): void {
  const cookies = parseCookies(request);
  deleteSession(cookies[config.sessionCookieName]);
  clearCookie(response, config.sessionCookieName);
}

export function buildOAuthState(providerName: string): string {
  return `${providerName}:${crypto.randomBytes(16).toString('hex')}`;
}

export function getOAuthState(request: Request): string | undefined {
  return parseCookies(request)[config.oauthStateCookieName];
}

export function setOAuthState(response: Response, state: string): void {
  setCookie(response, config.oauthStateCookieName, state, 60 * 10);
}

export function clearOAuthState(response: Response): void {
  clearCookie(response, config.oauthStateCookieName);
}

export function createAuthorizationUrl(providerName: string, state: string): string {
  const provider = getProvider(providerName);
  if (!provider) {
    throw new Error('OAuth provider is not configured.');
  }

  const url = new URL(provider.authorizeUrl);
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', getRedirectUri(provider.name));
  url.searchParams.set('scope', provider.scopes.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCodeForProfile(providerName: string, code: string): Promise<OAuthProfile> {
  const provider = getProvider(providerName);
  if (!provider) {
    throw new Error('OAuth provider is not configured.');
  }

  const tokenResponse = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': config.appName,
    },
    body: JSON.stringify({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: getRedirectUri(provider.name),
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error('Failed to exchange OAuth code.');
  }

  const tokenPayload = (await tokenResponse.json()) as { access_token?: string; error?: string };
  if (!tokenPayload.access_token) {
    throw new Error(tokenPayload.error || 'OAuth token was not returned.');
  }

  const profileResponse = await fetch(provider.userUrl, {
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + tokenPayload.access_token,
      'User-Agent': config.appName,
    },
  });

  if (!profileResponse.ok) {
    throw new Error('Failed to fetch OAuth profile.');
  }

  const profilePayload = (await profileResponse.json()) as {
    id: number | string;
    login?: string;
    name?: string;
    email?: string | null;
    avatar_url?: string | null;
  };

  return {
    id: String(profilePayload.id),
    name: profilePayload.name?.trim() || profilePayload.login?.trim() || `user-${profilePayload.id}`,
    email: profilePayload.email ?? null,
    avatar: profilePayload.avatar_url ?? null,
  };
}

export function ensureOAuthAccess(providerName: string, providerUserId: string): void {
  const existingUser = findUserByProvider(providerName, providerUserId);
  const listed = isAllowlisted(providerName, providerUserId);

  if (config.oauthAllowlist.size > 0 && !listed) {
    throw new Error('This OAuth account is not allowed to access the admin area.');
  }

  if (!existingUser && !listed && !config.allowFirstLogin) {
    throw new Error('First-login auto provisioning is disabled for this OAuth account.');
  }
}

export function completeOAuthLogin(providerName: string, profile: OAuthProfile) {
  ensureOAuthAccess(providerName, profile.id);
  return upsertOAuthUser({
    provider: providerName,
    providerUserId: profile.id,
    name: profile.name,
    email: profile.email,
    avatar: profile.avatar,
  });
}
