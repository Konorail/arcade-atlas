import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { config } from './config';
import { closeDatabase, getDatabaseHealth } from './db';
import {
  authenticateLocalUser,
  buildOAuthState,
  clearOAuthState,
  completeOAuthLogin,
  createAuthorizationUrl,
  endAdminSession,
  exchangeCodeForProfile,
  getCurrentUser,
  getOAuthState,
  setOAuthState,
  startAdminSession,
} from './auth';
import {
  createMachine,
  createMachineType,
  createMaintenanceLog,
  createQrCodeBuffer,
  createRepairForMachineToken,
  deleteMachine,
  deleteMaintenanceLog,
  deleteRepair,
  ensureBootstrapAuthConfig,
  getAuthSettingsView,
  getEnabledProviders,
  getEffectiveAuthMode,
  getMachine,
  getMachineHistory,
  getMachineType,
  getMachineViewByToken,
  getMaintenanceLog,
  getRepair,
  getStatusOptions,
  isLocalLoginEnabled,
  listMaintenanceLogs,
  listPublicMachines,
  listRecentMaintenanceLogs,
  listRecentRepairs,
  listMachineTypes,
  listMachines,
  listMaintenanceLogsForRepair,
  listRepairs,
  saveGithubOAuthSettings,
  setEffectiveAuthMode,
  regenerateMachineQrToken,
  updateMachine,
  updateMachineType,
  updateRepairStatus,
} from './services';

ensureBootstrapAuthConfig();

const app = express();
const viewsDir = path.join(process.cwd(), 'views');
const publicDir = path.join(process.cwd(), 'public');
const SHUTDOWN_TIMEOUT_MS = 10_000;
const machineStatusLabels = {
  normal: '🟢 正常',
  maintenance: '🟡 维护中',
  disabled: '⚫ 离线',
} as const;
const repairStatusLabels = {
  PENDING: '🔴 报修中',
  PROCESSING: '🟡 处理中',
  RESOLVED: '🟢 已解决',
  UNRESOLVED: '⚪ 历史未解决',
} as const;
const machineTypeStatusLabels = {
  active: '启用',
  inactive: '停用',
} as const;
const userStatusLabels = {
  active: '启用',
  disabled: '停用',
} as const;
const userRoleLabels = {
  user: '普通用户',
  repair: '维修人员',
  admin: '管理员',
} as const;
const authEntryRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: '请求过于频繁，请稍后再试。',
});
const adminRouteRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: '后台请求过于频繁，请稍后再试。',
});

app.set('view engine', 'ejs');
app.set('views', viewsDir);
app.use(express.static(publicDir));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/auth', authEntryRateLimit);
app.use('/admin', adminRouteRateLimit);
app.use('/api/admin', adminRouteRateLimit);

function buildLoginViewData(overrides: { errorMessage?: string } = {}) {
  return {
    authMode: getEffectiveAuthMode(),
    localLoginEnabled: isLocalLoginEnabled(),
    providers: getEnabledProviders(),
    errorMessage: overrides.errorMessage,
  };
}

app.use((request, response, next) => {
  response.locals.appName = config.appName;
  response.locals.currentPath = request.path;
  response.locals.currentUser = getCurrentUser(request);
  response.locals.providers = getEnabledProviders();
  response.locals.localLoginEnabled = isLocalLoginEnabled();
  response.locals.authMode = getEffectiveAuthMode();
  response.locals.statuses = getStatusOptions();
  response.locals.flashMessage =
    typeof request.query.message === 'string' && request.query.message.trim()
      ? {
          type: request.query.status === 'error' ? 'error' : 'success',
          text: request.query.message.trim(),
        }
      : null;
  response.locals.ui = {
    machineStatusLabels,
    repairStatusLabels,
    machineTypeStatusLabels,
    userStatusLabels,
    userRoleLabels,
    machineStatusClass: (status: keyof typeof machineStatusLabels) => `status-badge machine-status machine-status-${status}`,
    repairStatusClass: (status: keyof typeof repairStatusLabels) => `status-badge repair-status repair-status-${status.toLowerCase()}`,
  };
  response.locals.formatDateTime = formatDateTime;
  next();
});

function asyncHandler(handler: (request: Request, response: Response, next: NextFunction) => Promise<void> | void) {
  return (request: Request, response: Response, next: NextFunction) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function rejectUnauthorized(request: Request, response: Response, message: string): void {
  if (wantsJson(request)) {
    response.status(403).json({ error: message });
    return;
  }

  response.status(403).render('error', { message });
}

function requireRole(roles: readonly string[], message: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const user = getCurrentUser(request);
    if (!user) {
      if (wantsJson(request)) {
        response.status(401).json({ error: 'Authentication required.' });
        return;
      }

      response.redirect('/login');
      return;
    }

    if (!roles.includes(user.role)) {
      rejectUnauthorized(request, response, message);
      return;
    }

    response.locals.currentUser = user;
    next();
  };
}

const requireAdmin = requireRole(['admin'], '需要管理员权限。');
const requireRepairOrAdmin = requireRole(['repair', 'admin'], '需要维修人员或管理员权限。');

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid identifier.');
  }
  return id;
}

function routeParam(value: string | string[] | undefined, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing ${name}.`);
  }

  return value;
}

function wantsJson(request: Request): boolean {
  return request.path.startsWith('/api/') || request.accepts(['json', 'html']) === 'json';
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function groupMachinesByCategory() {
  const groups = new Map<string, ReturnType<typeof listPublicMachines>>();
  for (const machine of listPublicMachines()) {
    const category = machine.type_name?.trim() || '未命名类型';
    const items = groups.get(category) ?? [];
    items.push(machine);
    groups.set(category, items);
  }

  return Array.from(groups.entries()).map(([name, items]) => ({ name, items }));
}

function respondError(request: Request, response: Response, error: unknown, statusCode = 400): void {
  const message = error instanceof Error ? error.message : 'Unexpected error.';
  if (wantsJson(request)) {
    response.status(statusCode).json({ error: message });
    return;
  }

  response.status(statusCode).render('error', { message });
}

function redirectWithMessage(response: Response, targetPath: string, message: string, type: 'success' | 'error' = 'success'): void {
  const separator = targetPath.includes('?') ? '&' : '?';
  response.redirect(`${targetPath}${separator}status=${encodeURIComponent(type)}&message=${encodeURIComponent(message)}`);
}

app.get('/health', (_request, response) => {
  const database = getDatabaseHealth();
  response.json({
    status: database.initialized ? 'ok' : 'degraded',
    app: config.appName,
    version: config.appVersion,
    checks: {
      api: 'ok',
      database: database.initialized ? 'ok' : 'error',
      redis: 'not-configured',
      frontend: 'ok',
    },
    database,
  });
});

app.get('/', (_request, response) => {
  response.render('home', {
    recentRepairs: listRecentRepairs(15),
    recentMaintenanceLogs: listRecentMaintenanceLogs(15),
  });
});

app.get('/repairs', (_request, response) => {
  response.render('public-repairs', {
    machineGroups: groupMachinesByCategory(),
  });
});

app.get('/login', authEntryRateLimit, (_request, response) => {
  response.render('login', buildLoginViewData());
});

app.post('/login', authEntryRateLimit, (request, response) => {
  if (!isLocalLoginEnabled()) {
    response.status(400).render('login', buildLoginViewData({ errorMessage: '当前部署未启用用户名和密码登录。' }));
    return;
  }

  try {
    const user = authenticateLocalUser(String(request.body.username || ''), String(request.body.password || ''));
    startAdminSession(response, user.id);
    response.redirect('/admin');
  } catch (error) {
    const message = error instanceof Error ? error.message : '登录失败。';
    response.status(401).render('login', buildLoginViewData({ errorMessage: message }));
  }
});

app.get('/logout', (request, response) => {
  endAdminSession(request, response);
  response.redirect('/');
});

app.get(
  '/auth/:provider/redirect',
  asyncHandler(async (request, response) => {
    const state = buildOAuthState(routeParam(request.params.provider, 'provider'));
    setOAuthState(response, state);
    response.redirect(createAuthorizationUrl(routeParam(request.params.provider, 'provider'), state));
  }),
);

app.get(
  '/auth/:provider/callback',
  asyncHandler(async (request, response) => {
    const providerName = routeParam(request.params.provider, 'provider');
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const code = typeof request.query.code === 'string' ? request.query.code : '';
    const storedState = getOAuthState(request);

    if (!code || !state || state !== storedState) {
      throw new Error('Invalid OAuth callback state.');
    }

    clearOAuthState(response);
    const profile = await exchangeCodeForProfile(providerName, code);
    const user = completeOAuthLogin(providerName, profile);
    startAdminSession(response, user.id);
    response.redirect('/admin');
  }),
);

app.get(
  '/machine/:token',
  asyncHandler(async (request, response) => {
    const view = getMachineViewByToken(routeParam(request.params.token, 'token'));
    if (!view) {
      response.status(404).render('error', { message: 'Machine not found.' });
      return;
    }

    response.render('public-machine', {
      ...view,
    });
  }),
);

app.post(
  '/machine/:token/repairs',
  asyncHandler(async (request, response) => {
    const token = routeParam(request.params.token, 'token');
    try {
      createRepairForMachineToken(token, request.body as Record<string, unknown>);
      response.redirect(`/machine/${token}?message=${encodeURIComponent('报修已提交。')}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '报修提交失败，请稍后重试。';
      response.redirect(`/machine/${token}?status=error&message=${encodeURIComponent(message)}`);
    }
  }),
);

app.get('/admin', requireRepairOrAdmin, (_request, response) => {
  response.render('admin-dashboard', {
    machineTypes: listMachineTypes().length,
    machines: listMachines().length,
    repairs: listRepairs().length,
    maintenanceLogs: listMaintenanceLogs().length,
    authMode: getEffectiveAuthMode(),
  });
});

app.get('/admin/auth-settings', requireAdmin, (_request, response) => {
  response.render('auth-settings', {
    settings: getAuthSettingsView(),
    errorMessage: null,
    successMessage: null,
  });
});

app.post('/admin/auth-settings', requireAdmin, (request, response) => {
  const authMode = String(request.body.auth_mode || '').trim();
  const githubClientId = String(request.body.github_client_id || '').trim();
  const githubClientSecret = String(request.body.github_client_secret || '');
  const oauthAllowlist = String(request.body.oauth_allowlist || '').trim();

  if (authMode !== 'local' && authMode !== 'github' && authMode !== 'both') {
    response.status(400).render('auth-settings', {
      settings: getAuthSettingsView(),
      errorMessage: '认证方式必须是 local、github 或 both。',
      successMessage: null,
    });
    return;
  }

  try {
    if (githubClientId || githubClientSecret || oauthAllowlist || authMode !== 'local') {
      saveGithubOAuthSettings({
        clientId: githubClientId || getAuthSettingsView().github.clientId,
        clientSecret: githubClientSecret,
        allowlistRaw: oauthAllowlist,
      });
    }

    setEffectiveAuthMode(authMode);
    response.render('auth-settings', {
      settings: getAuthSettingsView(),
      errorMessage: null,
      successMessage: '认证配置已保存。Docker 部署请重启容器后再使新配置生效。',
    });
  } catch (error) {
    response.status(400).render('auth-settings', {
      settings: getAuthSettingsView(),
      errorMessage: error instanceof Error ? error.message : '保存认证配置失败。',
      successMessage: null,
    });
  }
});

app.get('/admin/machine-types', requireAdmin, (_request, response) => {
  response.render('machine-types', { machineTypes: listMachineTypes(), editing: null });
});

app.get('/admin/machine-types/:id', requireAdmin, (request, response) => {
  const machineType = getMachineType(parseId(routeParam(request.params.id, 'id')));
  if (!machineType) {
    response.status(404).render('error', { message: 'Machine type not found.' });
    return;
  }

  response.render('machine-types', { machineTypes: listMachineTypes(), editing: machineType });
});

app.post('/admin/machine-types', requireAdmin, (request, response) => {
  createMachineType(request.body as Record<string, unknown>);
  response.redirect('/admin/machine-types');
});

app.post('/admin/machine-types/:id', requireAdmin, (request, response) => {
  updateMachineType(parseId(routeParam(request.params.id, 'id')), request.body as Record<string, unknown>);
  response.redirect('/admin/machine-types');
});

app.get('/admin/machines', requireAdmin, (_request, response) => {
  response.render('machines', {
    machines: listMachines(),
    machineTypes: listMachineTypes().filter((item) => item.status === 'active'),
    editing: null,
  });
});

app.get('/admin/machines/:id', requireAdmin, asyncHandler(async (request, response) => {
  const machineId = parseId(routeParam(request.params.id, 'id'));
  const history = getMachineHistory(machineId);
  const machine = getMachine(machineId);
  if (!history || !machine) {
    response.status(404).render('error', { message: 'Machine not found.' });
    return;
  }

  response.render('machine-detail', {
    history,
    machine,
    machineTypes: listMachineTypes().filter((item) => item.status === 'active' || item.id === machine.machine_type_id),
    qrCodeDataUrl: await createQrCodeBuffer(machine).then((buffer) => `data:image/png;base64,${buffer.toString('base64')}`),
  });
}));

app.post('/admin/machines', requireAdmin, (request, response) => {
  const machine = createMachine(request.body as Record<string, unknown>);
  response.redirect(`/admin/machines/${machine.id}`);
});

app.post('/admin/machines/:id', requireAdmin, (request, response) => {
  updateMachine(parseId(routeParam(request.params.id, 'id')), request.body as Record<string, unknown>);
  response.redirect(`/admin/machines/${routeParam(request.params.id, 'id')}`);
});

app.post('/admin/machines/:id/delete', requireAdmin, (request, response) => {
  try {
    const result = deleteMachine(parseId(routeParam(request.params.id, 'id')));
    const message =
      result.relatedRepairs > 0 || result.relatedMaintenanceLogs > 0
        ? '机台已删除，并已保留关联报修与维护历史记录。'
        : '机台已删除。';
    redirectWithMessage(response, '/admin/machines', message);
  } catch (error) {
    redirectWithMessage(response, '/admin/machines', error instanceof Error ? error.message : '删除机台失败。', 'error');
  }
});

app.post('/admin/machines/:id/regenerate-qr', requireAdmin, (request, response) => {
  regenerateMachineQrToken(parseId(routeParam(request.params.id, 'id')));
  response.redirect(`/admin/machines/${routeParam(request.params.id, 'id')}`);
});

app.get('/admin/machines/:id/qr.png', requireAdmin, asyncHandler(async (request, response) => {
  const machine = getMachine(parseId(routeParam(request.params.id, 'id')));
  if (!machine) {
    response.status(404).render('error', { message: 'Machine not found.' });
    return;
  }

  const buffer = await createQrCodeBuffer(machine);
  response.setHeader('Content-Type', 'image/png');
  response.setHeader('Content-Disposition', `attachment; filename="${machine.machine_code}-qr.png"`);
  response.send(buffer);
}));

app.get('/admin/repairs', requireRepairOrAdmin, (request, response) => {
  const machineId = typeof request.query.machine_id === 'string' && request.query.machine_id ? Number(request.query.machine_id) : undefined;
  response.render('repairs', {
    repairs: listRepairs({
      machineId: machineId && Number.isInteger(machineId) ? machineId : undefined,
      status: typeof request.query.status === 'string' ? request.query.status : undefined,
      query: typeof request.query.query === 'string' ? request.query.query : undefined,
      from: typeof request.query.from === 'string' ? request.query.from : undefined,
      to: typeof request.query.to === 'string' ? request.query.to : undefined,
    }),
    machines: listMachines(),
    filters: request.query,
  });
});

app.get('/admin/repairs/:id', requireRepairOrAdmin, (request, response) => {
  const repair = getRepair(parseId(routeParam(request.params.id, 'id')));
  if (!repair) {
    response.status(404).render('error', { message: 'Repair record not found.' });
    return;
  }

  response.render('repair-detail', {
    repair,
    machine: getMachine(repair.machine_id),
    maintenanceLogs: listMaintenanceLogsForRepair(repair.id),
  });
});

app.post('/admin/repairs/:id/status', requireRepairOrAdmin, (request, response) => {
  updateRepairStatus(parseId(routeParam(request.params.id, 'id')), String(request.body.status || ''));
  response.redirect(`/admin/repairs/${routeParam(request.params.id, 'id')}`);
});

app.post('/admin/repairs/:id/delete', requireAdmin, (request, response) => {
  try {
    const result = deleteRepair(parseId(routeParam(request.params.id, 'id')));
    const message =
      result.maintenanceLogs > 0
        ? '报修记录已删除，关联维护记录已从管理列表隐藏。'
        : '报修记录已删除。';
    redirectWithMessage(response, '/admin/repairs', message);
  } catch (error) {
    redirectWithMessage(response, '/admin/repairs', error instanceof Error ? error.message : '删除报修记录失败。', 'error');
  }
});

app.post('/admin/repairs/:id/maintenance-logs', requireRepairOrAdmin, (request, response) => {
  const user = getCurrentUser(request);
  if (!user) {
    response.redirect('/login');
    return;
  }

  createMaintenanceLog(parseId(routeParam(request.params.id, 'id')), user.id, request.body as Record<string, unknown>);
  response.redirect(`/admin/repairs/${routeParam(request.params.id, 'id')}`);
});

app.get('/admin/maintenance-logs', requireRepairOrAdmin, (request, response) => {
  response.render('maintenance-logs', {
    maintenanceLogs: listMaintenanceLogs(),
  });
});

app.get('/admin/maintenance-logs/:id', requireRepairOrAdmin, (request, response) => {
  const maintenanceLog = getMaintenanceLog(parseId(routeParam(request.params.id, 'id')));
  if (!maintenanceLog) {
    response.status(404).render('error', { message: 'Maintenance log not found.' });
    return;
  }

  response.render('maintenance-log-detail', {
    maintenanceLog,
  });
});

app.post('/admin/maintenance-logs/:id/delete', requireAdmin, (request, response) => {
  try {
    deleteMaintenanceLog(parseId(routeParam(request.params.id, 'id')));
    redirectWithMessage(response, '/admin/maintenance-logs', '维护记录已删除。');
  } catch (error) {
    redirectWithMessage(response, '/admin/maintenance-logs', error instanceof Error ? error.message : '删除维护记录失败。', 'error');
  }
});

app.get('/api/machines/:token', (request, response) => {
  const view = getMachineViewByToken(routeParam(request.params.token, 'token'));
  if (!view) {
    response.status(404).json({ error: 'Machine not found.' });
    return;
  }

  response.json({ machine: view.machine, machineType: view.machineType });
});

app.get('/api/machines/:token/repairs', (request, response) => {
  const view = getMachineViewByToken(routeParam(request.params.token, 'token'));
  if (!view) {
    response.status(404).json({ error: 'Machine not found.' });
    return;
  }

  response.json({ items: view.recentRepairs });
});

app.post('/api/machines/:token/repairs', (request, response) => {
  try {
    const repair = createRepairForMachineToken(routeParam(request.params.token, 'token'), request.body as Record<string, unknown>);
    response.status(201).json({ repair });
  } catch (error) {
    respondError(request, response, error, 400);
  }
});

app.get('/api/machines/:token/maintenance-logs', (request, response) => {
  const view = getMachineViewByToken(routeParam(request.params.token, 'token'));
  if (!view) {
    response.status(404).json({ error: 'Machine not found.' });
    return;
  }

  response.json({ items: view.recentMaintenanceLogs });
});

app.get('/api/public/overview', (_request, response) => {
  response.json({
    recentRepairs: listRecentRepairs(15),
    recentMaintenanceLogs: listRecentMaintenanceLogs(15),
  });
});

app.get('/api/admin/machine-types', requireAdmin, (_request, response) => {
  response.json({ items: listMachineTypes() });
});

app.post('/api/admin/machine-types', requireAdmin, (request, response) => {
  try {
    response.status(201).json({ machineType: createMachineType(request.body as Record<string, unknown>) });
  } catch (error) {
    respondError(request, response, error, 400);
  }
});

app.patch('/api/admin/machine-types/:id', requireAdmin, (request, response) => {
  try {
    response.json({ machineType: updateMachineType(parseId(routeParam(request.params.id, 'id')), request.body as Record<string, unknown>) });
  } catch (error) {
    respondError(request, response, error, 400);
  }
});

app.get('/api/admin/machines', requireAdmin, (_request, response) => {
  response.json({ items: listMachines() });
});

app.post('/api/admin/machines', requireAdmin, (request, response) => {
  try {
    response.status(201).json({ machine: createMachine(request.body as Record<string, unknown>) });
  } catch (error) {
    respondError(request, response, error, 400);
  }
});

app.get('/api/admin/machines/:id', requireAdmin, (request, response) => {
  const history = getMachineHistory(parseId(routeParam(request.params.id, 'id')));
  if (!history) {
    response.status(404).json({ error: 'Machine not found.' });
    return;
  }

  response.json(history);
});

app.patch('/api/admin/machines/:id', requireAdmin, (request, response) => {
  try {
    response.json({ machine: updateMachine(parseId(routeParam(request.params.id, 'id')), request.body as Record<string, unknown>) });
  } catch (error) {
    respondError(request, response, error, 400);
  }
});

app.delete('/api/admin/machines/:id', requireAdmin, (request, response) => {
  try {
    response.json({ result: deleteMachine(parseId(routeParam(request.params.id, 'id'))) });
  } catch (error) {
    respondError(request, response, error, 400);
  }
});

app.post('/api/admin/machines/:id/regenerate-qr', requireAdmin, (request, response) => {
  try {
    response.json({ machine: regenerateMachineQrToken(parseId(routeParam(request.params.id, 'id'))) });
  } catch (error) {
    respondError(request, response, error, 400);
  }
});

app.get('/api/admin/repairs', requireRepairOrAdmin, (request, response) => {
  const machineId = typeof request.query.machine_id === 'string' && request.query.machine_id ? Number(request.query.machine_id) : undefined;
  response.json({
    items: listRepairs({
      machineId: machineId && Number.isInteger(machineId) ? machineId : undefined,
      status: typeof request.query.status === 'string' ? request.query.status : undefined,
      query: typeof request.query.query === 'string' ? request.query.query : undefined,
      from: typeof request.query.from === 'string' ? request.query.from : undefined,
      to: typeof request.query.to === 'string' ? request.query.to : undefined,
    }),
  });
});

app.get('/api/admin/repairs/:id', requireRepairOrAdmin, (request, response) => {
  const repair = getRepair(parseId(routeParam(request.params.id, 'id')));
  if (!repair) {
    response.status(404).json({ error: 'Repair record not found.' });
    return;
  }

  response.json({ repair, maintenanceLogs: listMaintenanceLogsForRepair(repair.id) });
});

app.delete('/api/admin/repairs/:id', requireAdmin, (request, response) => {
  try {
    response.json({ result: deleteRepair(parseId(routeParam(request.params.id, 'id'))) });
  } catch (error) {
    respondError(request, response, error, 400);
  }
});

app.patch('/api/admin/repairs/:id/status', requireRepairOrAdmin, (request, response) => {
  try {
    response.json({ repair: updateRepairStatus(parseId(routeParam(request.params.id, 'id')), String(request.body.status || '')) });
  } catch (error) {
    respondError(request, response, error, 400);
  }
});

app.get('/api/admin/repairs/:id/maintenance-logs', requireRepairOrAdmin, (request, response) => {
  const repair = getRepair(parseId(routeParam(request.params.id, 'id')));
  if (!repair) {
    response.status(404).json({ error: 'Repair record not found.' });
    return;
  }

  response.json({ items: listMaintenanceLogsForRepair(repair.id) });
});

app.post('/api/admin/repairs/:id/maintenance-logs', requireRepairOrAdmin, (request, response) => {
  const user = getCurrentUser(request);
  if (!user) {
    response.status(401).json({ error: 'Authentication required.' });
    return;
  }

  try {
    response.status(201).json({
      maintenanceLog: createMaintenanceLog(parseId(routeParam(request.params.id, 'id')), user.id, request.body as Record<string, unknown>),
    });
  } catch (error) {
    respondError(request, response, error, 400);
  }
});

app.get('/api/admin/maintenance-logs', requireRepairOrAdmin, (_request, response) => {
  response.json({ items: listMaintenanceLogs() });
});

app.get('/api/admin/maintenance-logs/:id', requireRepairOrAdmin, (request, response) => {
  const maintenanceLog = getMaintenanceLog(parseId(routeParam(request.params.id, 'id')));
  if (!maintenanceLog) {
    response.status(404).json({ error: 'Maintenance log not found.' });
    return;
  }

  response.json({ maintenanceLog });
});

app.delete('/api/admin/maintenance-logs/:id', requireAdmin, (request, response) => {
  try {
    response.json({ maintenanceLog: deleteMaintenanceLog(parseId(routeParam(request.params.id, 'id'))) });
  } catch (error) {
    respondError(request, response, error, 400);
  }
});

app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
  const statusCode = error instanceof Error && error.message.includes('not found') ? 404 : 400;
  respondError(request, response, error, statusCode);
});

const server = app.listen(config.port, () => {
  console.log(`${config.appName} is running at ${config.appUrl}`);
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
