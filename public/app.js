(function () {
  const POLL_INTERVAL_MS = 30000;
  const THEME_STORAGE_KEY = 'arcade-atlas-theme';
  const root = document.documentElement;
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function getSavedTheme() {
    try {
      const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
      return savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : null;
    } catch (_error) {
      return null;
    }
  }

  function setTheme(theme) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    const toggle = document.querySelector('[data-theme-toggle]');
    if (themeColor) {
      themeColor.setAttribute('content', theme === 'dark' ? '#171815' : '#efebe2');
    }
    if (toggle) {
      toggle.setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
      toggle.setAttribute('title', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
    }
  }

  function setupTheme() {
    const toggle = document.querySelector('[data-theme-toggle]');
    setTheme(getSavedTheme() || (systemTheme.matches ? 'dark' : 'light'));

    if (toggle) {
      toggle.addEventListener('click', () => {
        const nextTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        setTheme(nextTheme);
        try {
          window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
        } catch (_error) {
          // The selected theme still applies for the current page when storage is unavailable.
        }
      });
    }

    systemTheme.addEventListener('change', (event) => {
      if (!getSavedTheme()) {
        setTheme(event.matches ? 'dark' : 'light');
      }
    });
  }

  function setupRevealAnimations() {
    const elements = Array.from(document.querySelectorAll('[data-reveal]'));
    if (!elements.length || reducedMotion.matches || !('IntersectionObserver' in window)) {
      elements.forEach((element) => element.classList.add('is-visible'));
      return;
    }

    root.classList.add('motion-ready');
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry, index) => {
          if (!entry.isIntersecting) {
            return;
          }
          entry.target.style.transitionDelay = `${Math.min(index * 55, 220)}ms`;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -4% 0px' },
    );

    elements.forEach((element) => observer.observe(element));
  }

  function setupHeroParallax() {
    const shell = document.querySelector('[data-hero-parallax]');
    const finePointer = window.matchMedia('(pointer: fine)');
    if (!shell || !finePointer.matches || reducedMotion.matches) {
      return;
    }

    let frame = 0;
    let nextTransform = '';
    const render = () => {
      shell.style.transform = nextTransform;
      frame = 0;
    };

    shell.addEventListener('pointermove', (event) => {
      const bounds = shell.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - 0.5;
      const y = (event.clientY - bounds.top) / bounds.height - 0.5;
      nextTransform = `perspective(1200px) rotateX(${y * -1.1}deg) rotateY(${x * 1.35}deg)`;
      if (!frame) {
        frame = window.requestAnimationFrame(render);
      }
    });

    shell.addEventListener('pointerleave', () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      shell.style.transform = 'perspective(1200px) rotateX(0) rotateY(0)';
    });
  }

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
      if (window.innerWidth > 1120) {
        closeNav();
      }
    });
  }

  function setupHistoryBack() {
    document.querySelectorAll('[data-history-back]').forEach((control) => {
      control.addEventListener('click', () => {
        if (window.history.length > 1) {
          window.history.back();
          return;
        }
        window.location.assign('/');
      });
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
      UNRESOLVED: '⚪ 历史未解决',
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
      if (data.stats) {
        Object.entries(data.stats).forEach(([name, value]) => {
          const target = document.querySelector(`[data-overview-stat="${name}"]`);
          if (target && (typeof value === 'string' || typeof value === 'number')) {
            target.textContent = String(value);
          }
        });
      }
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

  function createConfirmDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog-backdrop';
    overlay.innerHTML = `
      <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <h2 id="confirm-dialog-title">请确认操作</h2>
        <p class="confirm-dialog-message"></p>
        <div class="actions">
          <button type="button" class="button danger" data-confirm-accept>确认</button>
          <button type="button" class="button secondary" data-confirm-cancel>取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  function showConfirmDialog(message, confirmText, cancelText) {
    const dialog = document.querySelector('.confirm-dialog-backdrop') || createConfirmDialog();
    const messageNode = dialog.querySelector('.confirm-dialog-message');
    const acceptButton = dialog.querySelector('[data-confirm-accept]');
    const cancelButton = dialog.querySelector('[data-confirm-cancel]');

    if (!messageNode || !acceptButton || !cancelButton) {
      return Promise.resolve(window.confirm(message));
    }

    messageNode.textContent = message || '请确认操作。';
    acceptButton.textContent = confirmText || '确认';
    cancelButton.textContent = cancelText || '取消';
    dialog.classList.add('is-visible');

    return new Promise((resolve) => {
      const cleanup = (result) => {
        dialog.classList.remove('is-visible');
        acceptButton.removeEventListener('click', onAccept);
        cancelButton.removeEventListener('click', onCancel);
        dialog.removeEventListener('click', onBackdropClick);
        document.removeEventListener('keydown', onKeyDown);
        resolve(result);
      };

      const onAccept = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onBackdropClick = (event) => {
        if (event.target === dialog) {
          cleanup(false);
        }
      };
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          cleanup(false);
        }
      };

      acceptButton.addEventListener('click', onAccept);
      cancelButton.addEventListener('click', onCancel);
      dialog.addEventListener('click', onBackdropClick);
      document.addEventListener('keydown', onKeyDown);
      acceptButton.focus();
    });
  }

  function setupStandardForms() {
    document.querySelectorAll('form').forEach((form) => {
      if (form.hasAttribute('data-repair-form')) {
        return;
      }

      form.addEventListener('submit', async (event) => {
        event.preventDefault();

        if (!form.checkValidity()) {
          form.reportValidity();
          return;
        }

        const message = form.getAttribute('data-confirm');
        if (message) {
          const confirmed = await showConfirmDialog(
            message,
            form.getAttribute('data-confirm-confirm-text') || '确认',
            form.getAttribute('data-confirm-cancel-text') || '取消',
          );

          if (!confirmed) {
            return;
          }
        }

        form.querySelectorAll('button[type="submit"], input[type="submit"]').forEach((button) => {
          setButtonLoading(button, true);
        });
        form.submit();
      });
    });
  }

  setupTheme();
  setupRevealAnimations();
  setupHeroParallax();
  setupFlashToast();
  setupMobileNav();
  setupHomeOverviewPolling();
  setupRepairForm();
  setupHistoryBack();
  setupStandardForms();
})();
