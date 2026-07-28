(function () {
  const POLL_INTERVAL_MS = 30000;

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  function getToastRoot() {
    let root = document.querySelector('[data-toast-root]');
    if (!root) {
      root = document.createElement('div');
      root.setAttribute('data-toast-root', '');
      root.setAttribute('aria-live', 'polite');
      root.className = 'toast-root';
      document.body.appendChild(root);
    }
    return root;
  }

  function setupMobileNav() {
    const toggle = document.querySelector('[data-nav-toggle]');
    const nav = document.querySelector('[data-site-nav]');
    if (!toggle || !nav) {
      return;
    }

    const closeNav = () => {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    };

    toggle.addEventListener('click', () => {
      const nextState = !nav.classList.contains('is-open');
      nav.classList.toggle('is-open', nextState);
      toggle.setAttribute('aria-expanded', nextState ? 'true' : 'false');
    });

    nav.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', closeNav);
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 720) {
        closeNav();
      }
    });
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type || 'success'}`;
    toast.textContent = message;
    getToastRoot().appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    window.setTimeout(() => {
      toast.classList.remove('is-visible');
      window.setTimeout(() => toast.remove(), 220);
    }, 2800);
  }

  function setButtonLoading(button, loading) {
    if (!button) {
      return;
    }

    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent || '';
    }

    button.disabled = loading;
    button.setAttribute('aria-busy', loading ? 'true' : 'false');
    button.textContent = loading ? button.dataset.loadingText || '处理中...' : button.dataset.originalText;
  }

  function repairStatusLabel(status) {
    return {
      PENDING: '🔴 报修中',
      PROCESSING: '🟡 处理中',
      RESOLVED: '🟢 已解决',
      UNRESOLVED: '⚫ 未解决',
    }[status] || escapeHtml(status);
  }

  function repairStatusClass(status) {
    return `status-badge repair-status repair-status-${String(status).toLowerCase()}`;
  }

  function renderRepairs(items) {
    if (!items.length) {
      return '<p class="empty-state">暂无报修记录。</p>';
    }

    return items
      .map(
        (repair) => `
          <article class="card record-card stack compact">
            <div class="record-meta">
              <strong>${escapeHtml(repair.machine_name || '')}</strong>
              <span>${escapeHtml(formatDateTime(repair.created_at))}</span>
            </div>
            <span class="${repairStatusClass(repair.status)}">${repairStatusLabel(repair.status)}</span>
            <p>${escapeHtml(repair.content)}</p>
          </article>
        `,
      )
      .join('');
  }

  function renderMachineRepairs(items) {
    if (!items.length) {
      return '<p class="empty-state">暂无报修记录。</p>';
    }

    return items
      .map(
        (repair) => `
          <article class="card record-card stack compact">
            <span class="${repairStatusClass(repair.status)}">${repairStatusLabel(repair.status)}</span>
            <span>${escapeHtml(formatDateTime(repair.created_at))}</span>
            <p>${escapeHtml(repair.content)}</p>
          </article>
        `,
      )
      .join('');
  }

  function renderMaintenanceLogs(items) {
    if (!items.length) {
      return '<p class="empty-state">暂无维修记录。</p>';
    }

    return items
      .map(
        (log) => `
          <article class="card record-card stack compact">
            <div class="record-meta">
              <strong>${escapeHtml(log.machine_name || '')}</strong>
              <span>${escapeHtml(formatDateTime(log.created_at))}</span>
            </div>
            <span class="muted">${escapeHtml(log.operator_name || '')}</span>
            <p>${escapeHtml(log.content)}</p>
            <span class="muted">维修说明：${escapeHtml(log.result)}</span>
          </article>
        `,
      )
      .join('');
  }

  function renderMachineMaintenanceLogs(items) {
    if (!items.length) {
      return '<p class="empty-state">暂无维修日志。</p>';
    }

    return items
      .map(
        (log) => `
          <article class="card record-card stack compact">
            <strong>${escapeHtml(log.operator_name || '')}</strong>
            <span>${escapeHtml(formatDateTime(log.created_at))}</span>
            <p>${escapeHtml(log.content)}</p>
            <span>结果：${escapeHtml(log.result)}</span>
          </article>
        `,
      )
      .join('');
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof data.error === 'string' ? data.error : '请求失败，请稍后重试。');
    }
    return data;
  }

  function setupFlashToast() {
    const flash = document.querySelector('[data-flash-toast]');
    if (!flash) {
      return;
    }

    showToast(flash.getAttribute('data-flash-toast') || '', flash.getAttribute('data-flash-toast-type') || 'success');
    flash.remove();

    const url = new URL(window.location.href);
    url.searchParams.delete('message');
    url.searchParams.delete('status');
    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
  }

  function setupHomeOverviewPolling() {
    const root = document.querySelector('[data-home-overview-url]');
    if (!root) {
      return;
    }

    const repairsList = root.querySelector('[data-home-repairs-list]');
    const maintenanceList = root.querySelector('[data-home-maintenance-list]');
    const url = root.getAttribute('data-home-overview-url');
    if (!repairsList || !maintenanceList || !url) {
      return;
    }

    const refresh = async () => {
      const data = await fetchJson(url);
      repairsList.innerHTML = renderRepairs(data.recentRepairs || []);
      maintenanceList.innerHTML = renderMaintenanceLogs(data.recentMaintenanceLogs || []);
    };

    window.setInterval(() => {
      refresh().catch(() => undefined);
    }, POLL_INTERVAL_MS);
  }

  function setupRepairForm() {
    const form = document.querySelector('[data-repair-form]');
    if (!form) {
      return;
    }

    const submitButton = form.querySelector('button[type="submit"]');
    const textarea = form.querySelector('textarea[name="content"]');
    const token = form.getAttribute('data-history-token');
    const apiEndpoint = form.getAttribute('data-api-endpoint');
    const repairsList = document.querySelector('[data-machine-repairs-list]');
    const maintenanceList = document.querySelector('[data-machine-maintenance-list]');

    const refreshHistory = async () => {
      if (!token || !repairsList || !maintenanceList) {
        return;
      }

      const [repairs, logs] = await Promise.all([
        fetchJson(`/api/machines/${encodeURIComponent(token)}/repairs`),
        fetchJson(`/api/machines/${encodeURIComponent(token)}/maintenance-logs`),
      ]);
      repairsList.innerHTML = renderMachineRepairs(repairs.items || []);
      maintenanceList.innerHTML = renderMachineMaintenanceLogs(logs.items || []);
    };

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      if (!textarea || !apiEndpoint) {
        return;
      }

      const content = textarea.value.trim();
      if (!content) {
        textarea.reportValidity();
        showToast('请先填写报修内容。', 'error');
        return;
      }

      try {
        setButtonLoading(submitButton, true);
        await fetchJson(apiEndpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content }),
        });
        textarea.value = '';
        showToast('报修已提交。', 'success');
        await refreshHistory();
      } catch (error) {
        showToast(error instanceof Error ? error.message : '报修提交失败，请稍后重试。', 'error');
      } finally {
        setButtonLoading(submitButton, false);
      }
    });

    window.setInterval(() => {
      refreshHistory().catch(() => undefined);
    }, POLL_INTERVAL_MS);
  }

  function setupStandardForms() {
    document.querySelectorAll('form').forEach((form) => {
      if (form.hasAttribute('data-repair-form')) {
        return;
      }

      form.addEventListener('submit', (event) => {
        const message = form.getAttribute('data-confirm');
        if (message && !window.confirm(message)) {
          event.preventDefault();
          return;
        }

        if (!form.checkValidity()) {
          return;
        }

        form.querySelectorAll('button[type="submit"], input[type="submit"]').forEach((button) => {
          setButtonLoading(button, true);
        });
      });
    });
  }

  setupFlashToast();
  setupMobileNav();
  setupHomeOverviewPolling();
  setupRepairForm();
  setupStandardForms();
})();
