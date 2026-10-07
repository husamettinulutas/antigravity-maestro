/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();

  /** Last state pushed by the extension. */
  let state = { accounts: [], usage: [], history: [] };

  // View preferences survive reloads. Bumping the version drops choices made
  // under an older layout. Version 5 starts everything folded except the
  // serving account, now that Connections sits at the top.
  const STATE_VERSION = 5;
  const persisted = vscode.getState() || {};
  const restorable = persisted.stateVersion === STATE_VERSION ? persisted : {};
  const openAccounts = new Set(restorable.openAccounts || []);
  const openModelLists = new Set(restorable.openModelLists || []);
  /** null = decide from the data: open until something is wired, then fold. */
  let connectionsOpen = typeof restorable.connectionsOpen === 'boolean' ? restorable.connectionsOpen : null;
  let currentTab = 'accounts';

  /** Entrance motion runs once per session, never on the frequent re-pushes. */
  let firstPaint = true;
  /** Accounts the user asked to refresh, until their quota comes back. */
  const refreshing = new Map();
  let refreshAllAt = 0;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const FAMILIES = ['claude', 'gemini', 'gpt', 'other'];
  const FAMILY_LABEL = { claude: 'Claude', gemini: 'Gemini', gpt: 'GPT-OSS', other: 'Other' };
  const FAMILY_SHORT = { claude: 'Claude', gemini: 'Gemini', gpt: 'GPT-OSS', other: 'Other' };

  // Remaining-quota thresholds. Fixed and explainable: under 50% is a
  // heads-up (amber), under 20% is low (red). Above that, colour is the family's.
  const WARN_BELOW = 50;
  const LOW_BELOW = 20;

  const el = {
    hero: document.getElementById('hero'),
    accounts: document.getElementById('accounts'),
    accountsMeta: document.getElementById('accounts-meta'),
    accountsCount: document.getElementById('accounts-count'),
    rotationSection: document.getElementById('rotation-section'),
    empty: document.getElementById('empty'),
    integrations: document.getElementById('integrations'),
    integrationsMeta: document.getElementById('integrations-meta'),
    integrationsSection: document.getElementById('integrations-section'),
    trendsSection: document.getElementById('trends-section'),
    trends: document.getElementById('trends'),
    health: document.getElementById('health'),
    healthText: document.getElementById('health-text'),
    collapseAll: document.getElementById('collapse-all'),
    usageBody: document.getElementById('usage-body'),
    usageCount: document.getElementById('usage-count'),
    usageEmpty: document.getElementById('usage-empty'),
    menu: document.getElementById('menu'),
    refreshAll: document.getElementById('refresh-all'),
  };

  // ── Events ────────────────────────────────────────────────────────────────

  document.getElementById('add-account').addEventListener('click', () => post('addAccount'));
  document.getElementById('add-account-empty').addEventListener('click', () => post('addAccount'));
  document.getElementById('clear-history').addEventListener('click', () => post('clearHistory'));

  // The health line sums up Connections, and takes you there.
  el.health.addEventListener('click', () => {
    selectTab('accounts');
    jumpTo('connections');
  });
  document.getElementById('open-logs').addEventListener('click', () => post('openLogs'));

  el.refreshAll.addEventListener('click', () => {
    refreshAllAt = Date.now();
    el.refreshAll.classList.add('is-busy');
    post('refreshAll');
    setTimeout(clearRefreshAll, 20000);
  });

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  });

  // Collapse all when anything is open; otherwise the same button expands
  // every rotation account (its glyph flips from box-minus to box-plus).
  el.collapseAll.addEventListener('click', () => {
    if (openAccounts.size > 0 || openModelLists.size > 0) {
      openAccounts.clear();
      openModelLists.clear();
    } else {
      (state.accounts || []).forEach((account) => {
        if (!account.isActive) {
          openAccounts.add(account.id);
        }
      });
    }
    savePreferences();
    renderAccounts();
  });

  // Account interactions are delegated so re-rendering never loses handlers.
  // Order matters: a button inside a row wins over the row toggle.
  function onAccountClick(event) {
    const menuButton = event.target.closest('[data-menu]');
    if (menuButton) {
      event.stopPropagation();
      toggleMenu(menuButton.dataset.menu, menuButton);
      return;
    }
    const button = event.target.closest('button[data-action]');
    if (button) {
      runAccountAction(button.dataset.action, button.dataset.accountId);
      return;
    }
    const jump = event.target.closest('[data-jump]');
    if (jump) {
      jumpTo(jump.dataset.jump);
      return;
    }
    const toggle = event.target.closest('[data-toggle]');
    if (toggle) {
      const set = toggle.dataset.toggle === 'models' ? openModelLists : openAccounts;
      const id = toggle.dataset.accountId;
      if (set.has(id)) {
        set.delete(id);
      } else {
        set.add(id);
      }
      savePreferences();
      renderAccounts();
    }
  }

  el.hero.addEventListener('click', onAccountClick);
  el.accounts.addEventListener('click', onAccountClick);

  // Rows are role="button": Enter and Space open them like a click would.
  el.accounts.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.acct-row')) {
      event.preventDefault();
      event.target.click();
    }
  });

  // Dragging a card reorders the rotation. Cards move in the DOM while the
  // drag is in flight so the drop lands where it looks like it will; the order
  // is committed once, on dragend.
  el.accounts.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.acct');
    if (!card) {
      return;
    }
    closeMenu();
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.accountId);
  });

  el.accounts.addEventListener('dragover', (event) => {
    const dragged = el.accounts.querySelector('.acct.dragging');
    if (!dragged) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const over = event.target.closest('.acct');
    if (!over || over === dragged) {
      return;
    }
    const box = over.getBoundingClientRect();
    const below = event.clientY > box.top + box.height / 2;
    el.accounts.insertBefore(dragged, below ? over.nextSibling : over);
  });

  el.accounts.addEventListener('drop', (event) => {
    if (el.accounts.querySelector('.acct.dragging')) {
      event.preventDefault();
    }
  });

  el.accounts.addEventListener('dragend', () => {
    const dragged = el.accounts.querySelector('.acct.dragging');
    if (!dragged) {
      return;
    }
    dragged.classList.remove('dragging');
    const ids = [...el.accounts.querySelectorAll('.acct')].map((card) => card.dataset.accountId);
    commitOrder(ids);
  });

  el.integrations.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) {
      return;
    }
    if (button.dataset.agentAction) {
      post(button.dataset.agentAction, { agent: button.dataset.agent });
    } else if (button.dataset.gatewayAction) {
      post(button.dataset.gatewayAction);
    } else if (button.hasAttribute('data-conn-toggle')) {
      connectionsOpen = !isConnectionsOpen();
      savePreferences();
      renderIntegrations();
    }
  });

  // Edge light that follows the pointer on cards: CSS variables only, no
  // re-render, and off for reduced motion or high contrast.
  document.addEventListener('pointermove', (event) => {
    if (reduceMotion.matches || document.body.classList.contains('vscode-high-contrast')) {
      return;
    }
    const card = event.target.closest && event.target.closest('.spot');
    if (!card) {
      return;
    }
    const box = card.getBoundingClientRect();
    card.style.setProperty('--mx', event.clientX - box.left + 'px');
    card.style.setProperty('--my', event.clientY - box.top + 'px');
  });

  // Overflow menu
  el.menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-menu-action]');
    if (!item || item.disabled) {
      return;
    }
    const id = el.menu.dataset.accountId;
    const action = item.dataset.menuAction;
    closeMenu();
    if (action === 'moveUp' || action === 'moveDown') {
      moveAccount(id, action === 'moveUp' ? -1 : 1);
    } else {
      runAccountAction(action, id);
    }
  });

  el.menu.addEventListener('keydown', (event) => {
    const items = [...el.menu.querySelectorAll('.menu-item:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1) % items.length].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length].focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (!el.menu.classList.contains('hidden') && !el.menu.contains(event.target)) {
      closeMenu();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu(true);
    }
  });
  window.addEventListener('blur', () => closeMenu());
  window.addEventListener('resize', () => closeMenu());
  window.addEventListener('scroll', () => closeMenu(), true);

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'state') {
      state = message.state || state;
      settleRefreshes();
      render();
    }
  });

  // Relative times tick in place; nothing else re-renders for them.
  setInterval(() => {
    document.querySelectorAll('[data-ago]').forEach((node) => {
      node.textContent = formatAgo(Number(node.dataset.ago));
    });
  }, 30000);

  // ── Actions ───────────────────────────────────────────────────────────────

  function runAccountAction(action, accountId) {
    if (action === 'refreshAccount') {
      const account = findAccount(accountId);
      refreshing.set(accountId, account ? account.quotaFetchedAt : undefined);
      setTimeout(() => {
        if (refreshing.delete(accountId)) {
          renderAccounts();
        }
      }, 20000);
      renderAccounts();
    }
    post(action, { accountId });
  }

  function moveAccount(id, delta) {
    const ids = (state.accounts || []).map((account) => account.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) {
      return;
    }
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    commitOrder(ids);
  }

  function commitOrder(ids) {
    const current = (state.accounts || []).map((account) => account.id);
    if (ids.join('|') !== current.join('|')) {
      post('reorderAccounts', { accountIds: ids });
    }
  }

  function settleRefreshes() {
    refreshing.forEach((fetchedAt, id) => {
      const account = findAccount(id);
      if (!account || account.quotaFetchedAt !== fetchedAt || account.lastError) {
        refreshing.delete(id);
      }
    });
    if (refreshAllAt && Date.now() - refreshAllAt > 700) {
      clearRefreshAll();
    }
  }

  function clearRefreshAll() {
    refreshAllAt = 0;
    el.refreshAll.classList.remove('is-busy');
  }

  function jumpTo(target) {
    if (target === 'connections' && !isConnectionsOpen()) {
      connectionsOpen = true;
      savePreferences();
      renderIntegrations();
    }
    const node = target === 'connections' ? el.integrationsSection : el.hero;
    const card = target === 'connections' ? el.integrations : el.hero.querySelector('.hero');
    if (!node || !card) {
      return;
    }
    node.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
  }

  function savePreferences() {
    vscode.setState({
      stateVersion: STATE_VERSION,
      openAccounts: [...openAccounts],
      openModelLists: [...openModelLists],
      connectionsOpen,
    });
  }

  // ── Menu ──────────────────────────────────────────────────────────────────

  function toggleMenu(accountId, anchor) {
    if (!el.menu.classList.contains('hidden') && el.menu.dataset.accountId === accountId) {
      closeMenu();
      return;
    }
    const account = findAccount(accountId);
    if (!account) {
      return;
    }
    const ids = state.accounts.map((candidate) => candidate.id);
    const position = ids.indexOf(accountId);
    const items = [];
    if (!account.isActive && !account.needsReauth) {
      items.push(menuItem('setActive', ICON.bolt, 'Serve from this account'));
    }
    if (account.needsReauth) {
      items.push(menuItem('reauth', ICON.key, 'Sign in again'));
    }
    items.push(menuItem('refreshAccount', ICON.refresh, 'Refresh quota'));
    items.push('<div class="menu-sep"></div>');
    items.push(menuItem('moveUp', ICON.up, 'Move up in rotation', position <= 0));
    items.push(menuItem('moveDown', ICON.down, 'Move down in rotation', position >= ids.length - 1));
    items.push('<div class="menu-sep"></div>');
    items.push(menuItem('removeAccount', ICON.trash, 'Remove account…', false, 'danger'));

    el.menu.innerHTML = items.join('');
    el.menu.dataset.accountId = accountId;
    el.menu.classList.remove('hidden');
    el.menu._anchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');

    const box = anchor.getBoundingClientRect();
    const width = el.menu.offsetWidth;
    const height = el.menu.offsetHeight;
    const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8));
    const below = box.bottom + 6 + height < window.innerHeight;
    el.menu.style.left = left + 'px';
    el.menu.style.top = (below ? box.bottom + 6 : Math.max(8, box.top - height - 6)) + 'px';
    el.menu.style.transformOrigin = below ? 'top right' : 'bottom right';
    const first = el.menu.querySelector('.menu-item:not(:disabled)');
    if (first) {
      first.focus();
    }
  }

  function menuItem(action, icon, label, disabled, extra) {
    return (
      '<button class="menu-item' + (extra ? ' ' + extra : '') + '" role="menuitem" data-menu-action="' +
      action + '"' + (disabled ? ' disabled' : '') + '>' + icon + '<span>' + escapeHtml(label) + '</span></button>'
    );
  }

  function closeMenu(restoreFocus) {
    if (el.menu.classList.contains('hidden')) {
      return;
    }
    el.menu.classList.add('hidden');
    const anchor = el.menu._anchor;
    if (anchor) {
      anchor.setAttribute('aria-expanded', 'false');
      if (restoreFocus && document.contains(anchor)) {
        anchor.focus();
      }
    }
    el.menu._anchor = null;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    renderAccounts();
    renderIntegrations();
    renderUsage();
    firstPaint = false;
  }

  /** Re-render without losing keyboard focus: focus follows data-key. */
  function keepFocus(fn) {
    const active = document.activeElement;
    const key = active && active.dataset ? active.dataset.key : undefined;
    fn();
    if (key) {
      const again = document.querySelector('[data-key="' + key + '"]');
      if (again) {
        again.focus({ preventScroll: true });
      }
    }
  }

  // ── Accounts ──────────────────────────────────────────────────────────────

  function renderAccounts() {
    keepFocus(() => {
      const accounts = state.accounts || [];
      const active = accounts.find((account) => account.isActive);
      el.empty.classList.toggle('hidden', accounts.length > 0);
      el.rotationSection.classList.toggle('hidden', accounts.length === 0);
      el.collapseAll.classList.toggle('hidden', accounts.length === 0);
      el.refreshAll.classList.toggle('hidden', accounts.length === 0);

      el.hero.classList.toggle('animate', firstPaint);
      el.accounts.classList.toggle('animate', firstPaint);
      el.empty.classList.toggle('animate', firstPaint);
      el.hero.innerHTML = active ? renderHero(active, accounts) : '';
      el.accounts.innerHTML = accounts.map((account, index) => renderRow(account, index)).join('');

      setCount(el.accountsCount, accounts.length);
      el.accountsMeta.innerHTML = accounts.length > 1
        ? '<span class="meta-long">falls back top to bottom · drag to reorder</span><span class="meta-short">falls back top to bottom</span>'
        : '';
      const anyOpen = openAccounts.size > 0 || openModelLists.size > 0;
      el.collapseAll.title = anyOpen ? 'Collapse all' : 'Expand all';
      el.collapseAll.setAttribute('aria-label', anyOpen ? 'Collapse all accounts' : 'Expand all accounts');
      el.collapseAll.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M5.5 8h5' + (anyOpen ? '' : 'M8 5.5v5') + '"/></svg>';

      applySizes(el.hero);
      applySizes(el.accounts);
      if (firstPaint) {
        // Drop the entrance class once it has played, so nothing can replay it.
        setTimeout(() => {
          el.hero.classList.remove('animate');
          el.accounts.classList.remove('animate');
          el.empty.classList.remove('animate');
        }, 450);
      }
    });
  }

  /** Signed in, readable and with at least one pool that still answers. */
  function isReady(account) {
    if (account.needsReauth || account.lastError) {
      return false;
    }
    const pools = account.pools || [];
    return pools.length === 0 || pools.some((pool) => pool.model && pool.model.percentage > 0);
  }

  /** The serving account, first thing in the panel. */
  function renderHero(account, accounts) {
    const open = openAccounts.has(account.id);
    const loading = refreshing.has(account.id);
    const models = account.models || [];
    const ready = accounts.filter(isReady).length;
    const position = accounts.indexOf(account) + 1;

    return (
      '<section class="hero spot" data-account-id="' + escapeAttribute(account.id) + '">' +
      '<div class="hero-top">' +
      '<span class="live"><i class="live-dot"></i>Serving now</span>' +
      '<span class="hero-top-end">' +
      '<span class="ready-count tnum" title="Accounts that are signed in and still have quota">' + ready + ' of ' + accounts.length + ' ready</span>' +
      moreButton(account) +
      '</span>' +
      '</div>' +
      '<div class="hero-id">' +
      avatar(account, 'lg') +
      '<div class="id-text">' +
      emailHtml(account.email, 'id-email') +
      '<div class="id-meta">' +
      (account.tier ? '<span class="chip chip-tier">' + escapeHtml(account.tier) + '</span>' : '') +
      (accounts.length > 1 ? '<span class="rank tnum" title="Position in the fallback order">#' + position + ' in rotation</span>' : '') +
      updatedHtml(account, loading) +
      '</div>' +
      '</div>' +
      '</div>' +
      troublePanel(account) +
      gauges(account, 'md', loading, true) +
      insight(account) +
      suggestion(account, accounts) +
      renderWindows(account.groups, account.needsReauth || !!account.lastError) +
      (models.length > 0
        ? '<button class="disclosure" data-toggle="account" data-account-id="' + escapeAttribute(account.id) +
          '" data-key="models-' + escapeAttribute(account.id) + '" aria-expanded="' + open + '">' +
          '<span>' + (open ? 'Hide' : 'All') + ' ' + models.length + ' models</span>' + ICON.chevron + '</button>' +
          (open ? renderModelList(models) : '')
        : '') +
      '</section>'
    );
  }

  /** One account in the rotation. Compact, with the pacing numbers always visible. */
  function renderRow(account, index) {
    const id = escapeAttribute(account.id);
    const handle =
      '<span class="acct-handle" title="Drag to reorder — rotation falls back down this list" aria-hidden="true">' +
      '<span class="acct-idx">' + (index + 1) + '</span>' + ICON.grip + '</span>';

    // The serving account keeps its place in the order, but its detail lives
    // in the hero: here it is one slim line that points up there.
    if (account.isActive) {
      return (
        '<article class="acct spot is-serving" draggable="true" data-account-id="' + id + '">' +
        '<div class="acct-row acct-slim" role="button" tabindex="0" data-key="row-' + id + '" data-jump="hero" ' +
        'title="' + escapeAttribute(account.email + ' — serving now; details are at the top') + '" aria-label="' +
        escapeAttribute(account.email + ', serving now. Show details at the top') + '">' +
        handle +
        avatar(account, 'xs', true) +
        emailHtml(account.email, 'acct-email', sharedDomain()) +
        '<span class="serving-tag">Serving<span class="serving-arrow" aria-hidden="true">↑</span></span>' +
        '<div class="acct-actions">' + moreButton(account) + '</div>' +
        '</div>' +
        '</article>'
      );
    }

    const open = openAccounts.has(account.id);
    const status = statusOf(account);
    const loading = refreshing.has(account.id);

    const primary = account.needsReauth
      ? '<button class="btn btn-row btn-warn" data-action="reauth" data-account-id="' + id +
        '" data-key="primary-' + id + '">Sign in</button>'
      : '<button class="btn btn-row btn-use" data-action="setActive" data-account-id="' + id +
        '" data-key="primary-' + id + '" title="Serve requests from this account">Use</button>';

    const classes = [
      'acct',
      'spot',
      open ? 'is-open' : '',
      account.needsReauth || account.lastError ? 'is-trouble' : '',
    ].filter(Boolean).join(' ');

    return (
      '<article class="' + classes + '" draggable="true" data-account-id="' + id + '">' +
      '<div class="acct-row" role="button" tabindex="0" data-key="row-' + id + '" data-toggle="account" data-account-id="' + id +
      '" aria-expanded="' + open + '" aria-label="' + escapeAttribute(account.email + ' — ' + status.plain) + '" title="' +
      escapeAttribute(account.email + ' — ' + (open ? 'hide details' : 'show details')) + '">' +
      handle +
      avatar(account, 'sm') +
      '<div class="acct-main">' +
      emailHtml(account.email, 'acct-email', sharedDomain()) +
      '<div class="acct-status tone-' + status.tone + '" title="' + escapeAttribute(status.title || status.plain) + '">' +
      status.html + '</div>' +
      '</div>' +
      pills(account, loading) +
      '<div class="acct-actions">' + primary + moreButton(account) + '</div>' +
      '</div>' +
      (open ? '<div class="acct-body">' + renderDetail(account, loading) + '</div>' : '') +
      '</article>'
    );
  }

  /** Numbered ring pills in a fixed family order: the Batteries-widget glance. */
  function pills(account, loading) {
    const pools = familyPools(account);
    if (pools.length === 0) {
      return '<div class="pills"></div>';
    }
    const dim = account.needsReauth || !!account.lastError;
    return (
      '<div class="pills' + (dim ? ' is-dim' : '') + (loading ? ' is-loading' : '') + '">' +
      pools.map((entry) => {
        const pct = clamp(Math.round(Number(entry.model.percentage) || 0), 0, 100);
        const tone = toneOf(pct);
        const tip = FAMILY_LABEL[entry.family] + ' ' + pct + '%' + (entry.model.resetsIn ? ' · resets in ' + entry.model.resetsIn : '');
        return (
          '<span class="pill paint-' + entry.family + ' tone-' + tone + '" role="img" title="' + escapeAttribute(tip) +
          '" aria-label="' + escapeAttribute(tip) + '">' +
          '<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="pill-track" cx="50" cy="50" r="37"></circle>' +
          (pct > 0
            ? '<circle class="pill-value" cx="50" cy="50" r="37" pathLength="100" stroke-dasharray="' + pct +
              ' 100" transform="rotate(-90 50 50)"></circle>'
            : '') +
          '</svg><b class="tnum">' + pct + '</b></span>'
        );
      }).join('') +
      '</div>'
    );
  }

  function renderDetail(account, loading) {
    const id = escapeAttribute(account.id);
    const models = account.models || [];
    const shown = openModelLists.has(account.id);
    return (
      troublePanel(account, true) +
      gauges(account, 'md', loading, false) +
      insight(account) +
      renderWindows(account.groups, account.needsReauth || !!account.lastError) +
      '<div class="detail-foot">' +
      '<span class="detail-meta">' +
      (account.tier ? '<span class="chip chip-tier">' + escapeHtml(account.tier) + '</span>' : '') +
      updatedHtml(account, loading) +
      '</span>' +
      (models.length > 0
        ? '<button class="disclosure inline" data-toggle="models" data-account-id="' + id + '" data-key="mlist-' + id +
          '" aria-expanded="' + shown + '"><span>' + (shown ? 'Hide' : 'All') + ' ' + models.length + ' models</span>' +
          ICON.chevron + '</button>'
        : '') +
      '</div>' +
      (shown ? renderModelList(models) : '')
    );
  }

  function moreButton(account) {
    const id = escapeAttribute(account.id);
    return (
      '<button class="icon-btn more" data-menu="' + id + '" data-key="more-' + id +
      '" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ' + escapeAttribute(account.email) +
      '" title="More actions">' + ICON.more + '</button>'
    );
  }

  function updatedHtml(account, loading) {
    if (loading) {
      return '<span class="updated is-loading">Refreshing…</span>';
    }
    if (!account.quotaFetchedAt) {
      return '<span class="updated">Quota not loaded</span>';
    }
    return (
      '<span class="updated" title="Updated ' + escapeAttribute(new Date(account.quotaFetchedAt).toLocaleString()) +
      '"><span data-ago="' + account.quotaFetchedAt + '">' + formatAgo(account.quotaFetchedAt) + '</span></span>'
    );
  }

  /** Errors replace confidence: a short panel, with the one action that fixes it. */
  function troublePanel(account, inRow) {
    const id = escapeAttribute(account.id);
    if (account.needsReauth) {
      // In a rotation row the row's own primary button is already "Sign in".
      return (
        '<div class="trouble tone-warn' + (inRow ? ' no-action' : '') + '">' + ICON.key +
        '<div class="trouble-text"><b>Signed out</b><span>Google needs you to sign in again. The figures below are from before.</span></div>' +
        (inRow
          ? ''
          : '<button class="btn btn-sm btn-warn" data-action="reauth" data-account-id="' + id + '" data-key="fix-' + id + '">Sign in</button>') +
        '</div>'
      );
    }
    if (account.lastError) {
      return (
        '<div class="trouble tone-low">' + ICON.alert +
        '<div class="trouble-text"><b>Refresh failed</b><span>' + escapeHtml(account.lastError) + '</span></div>' +
        '<button class="btn btn-sm" data-action="refreshAccount" data-account-id="' + id + '" data-key="fix-' + id + '">Retry</button>' +
        '</div>'
      );
    }
    return '';
  }

  // ── Gauges ────────────────────────────────────────────────────────────────

  /** The tightest pool per family, in fixed family order for spatial memory. */
  function familyPools(account) {
    const byFamily = {};
    (account.pools || []).forEach((pool) => {
      if (!pool || !pool.model) {
        return;
      }
      const family = familyOf(pool.model.modelId);
      const previous = byFamily[family];
      if (!previous || pool.model.percentage < previous.model.percentage) {
        byFamily[family] = pool;
      }
    });
    return FAMILIES.filter((family) => byFamily[family]).map((family) => ({
      family,
      pool: byFamily[family],
      model: byFamily[family].model,
    }));
  }

  function tightest(account) {
    const pools = familyPools(account);
    return pools.length > 0 ? pools.slice().sort((a, b) => a.model.percentage - b.model.percentage)[0] : undefined;
  }

  function gauges(account, size, loading, glow) {
    const pools = familyPools(account);
    if (pools.length === 0) {
      return '';
    }
    const dim = account.needsReauth || !!account.lastError;
    const rings = pools.map((entry) =>
      ring(entry.model.percentage, entry.family, {
        reset: entry.model.resetsIn,
        members: entry.pool.memberCount,
        glow: glow && !dim,
      }),
    );
    const classes = ['gauges', 'gauges-' + size, dim ? 'is-dim' : '', loading ? 'is-loading' : '', glow ? 'has-glow' : '']
      .filter(Boolean)
      .join(' ');
    return '<div class="' + classes + '">' + rings.join('') + '</div>';
  }

  // A 270° open arc (SwiftUI .circular, r = 42): the gap at the bottom holds the name.
  const RING_R = 42;
  const ARC = 'M20.302 79.698A42 42 0 1 1 79.698 79.698';

  /** Family name for a ring cap; GPT-OSS sheds its suffix only in a very narrow panel. */
  function familyCap(family) {
    return family === 'gpt' ? 'GPT<span class="oss">-OSS</span>' : escapeHtml(FAMILY_LABEL[family]);
  }

  function ring(percentage, family, info) {
    const pct = clamp(Math.round(Number(percentage) || 0), 0, 100);
    const tone = toneOf(pct);
    const paint = tone === 'good' ? family : tone;
    const reset = info.reset ? 'resets in ' + info.reset : pct >= 100 ? 'full' : '';
    const label =
      FAMILY_LABEL[family] + ' pool, ' + pct + ' percent left' + (info.reset ? ', resets in ' + info.reset : '') +
      (info.members > 1 ? ', shared by ' + info.members + ' models' : '');
    let value = '';
    if (pct > 0) {
      const angle = ((135 + 2.7 * pct) * Math.PI) / 180;
      const tipX = (50 + RING_R * Math.cos(angle)).toFixed(2);
      const tipY = (50 + RING_R * Math.sin(angle)).toFixed(2);
      value =
        '<path class="ring-value" d="' + ARC + '" pathLength="100" stroke-dasharray="' + pct + ' 100" stroke="url(#g-' + paint + ')"></path>' +
        (info.glow ? '<circle class="ring-tip" cx="' + tipX + '" cy="' + tipY + '" r="2.6"></circle>' : '');
    }
    const svg =
      '<svg viewBox="0 0 100 100" aria-hidden="true"><path class="ring-track" d="' + ARC + '"></path>' + value + '</svg>';

    return (
      '<div class="gauge tone-' + tone + '" role="img" aria-label="' + escapeAttribute(label) + '">' +
      '<span class="ring ring-md paint-' + paint + '">' + svg +
      '<span class="ring-num tnum' + (pct >= 100 ? ' is-full' : '') + '">' + pct + '<i>%</i></span>' +
      '<span class="ring-cap paint-' + family + '">' + familyCap(family) + '</span>' +
      '</span>' +
      '<span class="gauge-reset" title="' + escapeAttribute(reset ? reset.charAt(0).toUpperCase() + reset.slice(1) : '') + '">' +
      (info.reset ? ICON.reset + escapeHtml(info.reset) : pct >= 100 ? 'full' : '—') + '</span>' +
      '</div>'
    );
  }

  // ── Status, pace, suggestion ──────────────────────────────────────────────

  /**
   * One escalating line per account: names the binding pool and its reset.
   * The connective words ("resets", "back in") sit in .w-long so a very narrow
   * panel can drop them instead of cutting the time off.
   */
  function statusOf(account) {
    const make = (tone, parts, title) => {
      const plain = parts.map((part) => (Array.isArray(part) ? part.join('') : part)).join('');
      const html = parts
        .map((part) => (Array.isArray(part) ? '<span class="w-long">' + escapeHtml(part[0]) + '</span>' + escapeHtml(part[1]) : escapeHtml(part)))
        .join('');
      return { tone, html: '<span class="acct-status-text">' + html + '</span>', plain, title };
    };
    if (account.needsReauth) {
      return make('warn', ['Signed out · sign in again']);
    }
    if (account.lastError) {
      return make('low', ['Refresh failed · ' + shortError(account.lastError)], account.lastError);
    }
    const tight = tightest(account);
    if (!tight) {
      return make('muted', ['Quota not loaded yet']);
    }
    const pct = tight.model.percentage;
    const name = FAMILY_SHORT[tight.family];
    if (pct >= 100) {
      return make('muted', ['All pools full']);
    }
    const resetsIn = tight.model.resetsIn;
    if (pct <= 0) {
      return make('low', [name + ' empty'].concat(resetsIn ? [' · ', ['back in ', resetsIn]] : []));
    }
    const tone = toneOf(pct) === 'good' ? 'muted' : toneOf(pct);
    return make(tone, [name + ' ' + pct + '%'].concat(resetsIn ? [' · ', ['resets ', resetsIn]] : []));
  }

  /** "Will I hit the limit before it resets?" — answered from the history. */
  function insight(account) {
    if (account.needsReauth || account.lastError) {
      return '';
    }
    const tight = tightest(account);
    if (!tight) {
      return '';
    }
    const pct = tight.model.percentage;
    const name = FAMILY_LABEL[tight.family];
    const resetMin = parseDuration(tight.model.resetsIn);
    const at = tight.model.resetTime ? Date.parse(tight.model.resetTime) : NaN;
    const clock = Number.isFinite(at) ? ' <span class="insight-at">(' + escapeHtml(formatTime(at)) + ')</span>' : '';

    if (pct <= 0) {
      return insightLine('low', ICON.clock, '<b>' + name + ' is empty.</b> ' +
        (tight.model.resetsIn ? 'It refills in ' + escapeHtml(tight.model.resetsIn) + clock + '.' : 'Waiting for the reset.'));
    }
    const rate = drainRate(account.id, tight.family);
    if (!rate || rate < 0.5) {
      return '';
    }
    const minutesLeft = (pct / rate) * 60;
    if (resetMin !== undefined && minutesLeft < resetMin) {
      const early = resetMin - minutesLeft;
      return insightLine(pct < LOW_BELOW ? 'low' : 'warn', ICON.trend,
        'At this pace <b>' + name + ' runs out in ~' + formatMinutes(minutesLeft) + '</b>, ' +
        formatMinutes(early) + ' before it resets' + clock + '.');
    }
    return insightLine('good', ICON.check,
      name + ' lasts until its reset' + (tight.model.resetsIn ? ' in ' + escapeHtml(tight.model.resetsIn) : '') + clock +
      ' at this pace (−' + rate.toFixed(rate < 10 ? 1 : 0) + '%/h).');
  }

  function insightLine(tone, icon, html) {
    return '<div class="insight tone-' + tone + '">' + icon + '<span class="insight-text">' + html + '</span></div>';
  }

  /** Percent per hour a family has been falling, over the last ~3 hours of readings. */
  function drainRate(accountId, family) {
    const entry = (state.history || []).find((candidate) => candidate.accountId === accountId);
    if (!entry || !entry.points || entry.points.length < 2) {
      return undefined;
    }
    const points = entry.points.filter((point) => point.byFamily && point.byFamily[family] !== undefined);
    if (points.length < 2) {
      return undefined;
    }
    const last = points[points.length - 1];
    let first = points[0];
    for (let index = points.length - 2; index >= 0; index--) {
      first = points[index];
      if (last.at - first.at >= 3 * 3600e3) {
        break;
      }
    }
    const hours = (last.at - first.at) / 3600e3;
    if (hours < 0.25) {
      return undefined;
    }
    const drop = first.byFamily[family] - last.byFamily[family];
    return drop > 0 ? drop / hours : 0;
  }

  /** When the serving account is running low, name the account that is not. */
  function suggestion(active, accounts) {
    let family;
    let current;
    if (active.needsReauth || active.lastError) {
      current = -1;
    } else {
      const tight = tightest(active);
      if (!tight || tight.model.percentage >= WARN_BELOW) {
        return '';
      }
      family = tight.family;
      current = tight.model.percentage;
    }

    let best;
    let bestValue = -1;
    accounts.forEach((candidate) => {
      if (candidate.isActive || candidate.needsReauth || candidate.lastError) {
        return;
      }
      const entry = familyPools(candidate).find((item) => !family || item.family === family);
      const value = family
        ? entry ? entry.model.percentage : -1
        : candidate.lowestQuota !== undefined ? candidate.lowestQuota : -1;
      if (value > bestValue) {
        best = candidate;
        bestValue = value;
      }
    });
    if (!best || bestValue < current + 25) {
      return '';
    }
    const id = escapeAttribute(best.id);
    return (
      '<div class="suggest">' +
      avatar(best, 'xs') +
      '<span class="suggest-text"><b title="' + escapeAttribute(best.email) + '">' + escapeHtml(localPart(best.email)) + '</b> has ' +
      (family ? '<span class="suggest-fam paint-' + family + '">' + escapeHtml(FAMILY_SHORT[family]) + ' ' + bestValue + '%</span>' : 'quota ready') +
      '</span>' +
      '<button class="btn btn-primary btn-switch" data-action="setActive" data-account-id="' + id +
      '" data-key="suggest-' + id + '">Switch</button>' +
      '</div>'
    );
  }

  // ── Rolling windows ───────────────────────────────────────────────────────

  function renderWindows(groups, dim) {
    if (!groups || groups.length === 0) {
      return '';
    }
    const blocks = groups
      .filter((group) => (group.buckets || []).length > 0)
      .map((group) => {
        const name = String(group.displayName || '');
        const family = /gemini/i.test(name) ? 'gemini' : /claude|gpt/i.test(name) ? 'claude' : 'other';
        const short = /gemini/i.test(name)
          ? 'Gemini'
          : /claude/i.test(name) && /gpt/i.test(name)
            ? 'Claude + GPT-OSS'
            : name.replace(/\s*models?$/i, '');
        // Shortest window first: the 5-hour one is what bites today.
        const buckets = group.buckets.slice().sort((a, b) => windowLength(a) - windowLength(b));
        const kinds = buckets.map((bucket) => {
          const length = windowLength(bucket);
          return length === 300 ? '5-hour' : length === 10080 ? 'Weekly' : String(bucket.displayName || '');
        });
        const full = buckets.every((bucket) => Math.round(Number(bucket.percentage) || 0) >= 100);
        const dot = '<i class="fam-dot fam-' + family + '"></i>';

        // Nothing used: one hairline line instead of two full bars.
        if (full) {
          return (
            '<div class="wgroup is-full" title="' + escapeAttribute((group.description || name) + ' — every window is full') + '">' +
            '<div class="wfull">' + dot + '<span class="wfull-name">' + escapeHtml(short) + '</span>' +
            '<span class="wfull-state">' + escapeHtml(kinds.join(' + ')) + ' <b>full</b></span></div></div>'
          );
        }

        const rows = buckets.map((bucket, index) => {
          const pct = clamp(Math.round(Number(bucket.percentage) || 0), 0, 100);
          const tone = toneOf(pct);
          const paint = tone === 'good' ? family : tone;
          const length = windowLength(bucket);
          const remaining = parseDuration(bucket.resetsIn);
          let tick = '';
          if (pct < 100 && length < Infinity && remaining !== undefined && remaining <= length) {
            const even = Math.round((remaining / length) * 100);
            tick = '<b class="win-tick" data-left="' + even + '" title="At an even pace you would have ' + even + '% left by now"></b>';
          }
          return (
            '<div class="wrow paint-' + paint + '">' +
            '<span class="wrow-kind">' + escapeHtml(kinds[index]) + '</span>' +
            '<span class="win-bar"><i class="win-fill" data-width="' + pct + '"></i>' + tick + '</span>' +
            '<span class="wrow-pct tnum tone-' + tone + '">' + pct + '%</span>' +
            '<span class="wrow-reset tnum" title="' + escapeAttribute(bucket.resetsIn ? 'Resets in ' + bucket.resetsIn : '') + '">' +
            (pct >= 100 ? 'full' : bucket.resetsIn ? escapeHtml(bucket.resetsIn) : '—') + '</span>' +
            '</div>'
          );
        });
        return (
          '<div class="wgroup" title="' + escapeAttribute(group.description || name) + '">' +
          '<div class="wgroup-head">' + dot + escapeHtml(short) +
          '<span class="wgroup-hint">resets in</span></div>' + rows.join('') + '</div>'
        );
      });
    return blocks.length > 0
      ? '<div class="windows' + (dim ? ' is-dim' : '') + '"><div class="windows-head">Rolling limits</div>' + blocks.join('') + '</div>'
      : '';
  }

  function windowLength(bucket) {
    const name = String(bucket.displayName || '');
    if (/five|5\s*h/i.test(name)) {
      return 300;
    }
    return /week/i.test(name) ? 10080 : Infinity;
  }

  /** Every model, grouped under its family. */
  function renderModelList(models) {
    const groups = {};
    models.forEach((model) => {
      const family = familyOf(model.modelId);
      (groups[family] = groups[family] || []).push(model);
    });
    const sections = FAMILIES.filter((family) => groups[family]).map((family) => {
      const rows = groups[family].map((model) => {
        const pct = clamp(Math.round(Number(model.percentage) || 0), 0, 100);
        const tone = toneOf(pct);
        return (
          '<div class="mrow" title="' + escapeAttribute(model.modelId) + '">' +
          '<span class="mrow-name">' + escapeHtml(model.displayName || model.modelId) + '</span>' +
          '<span class="mrow-reset tnum">' + (model.resetsIn ? escapeHtml(model.resetsIn) : pct >= 100 ? 'full' : '') + '</span>' +
          '<span class="mrow-bar paint-' + (tone === 'good' ? family : tone) + '"><i data-width="' + pct + '"></i></span>' +
          '<span class="mrow-pct tnum tone-' + tone + '">' + pct + '%</span>' +
          '</div>'
        );
      });
      return (
        '<div class="mgroup"><div class="mgroup-head"><i class="fam-dot fam-' + family + '"></i>' +
        FAMILY_LABEL[family] + '<span>' + groups[family].length + '</span></div>' + rows.join('') + '</div>'
      );
    });
    return '<div class="models">' + sections.join('') + '</div>';
  }

  // ── Integrations ──────────────────────────────────────────────────────────

  function isConnectionsOpen() {
    // Connections sits above the serving account, so it starts folded to its
    // gateway line and opens only when asked.
    return connectionsOpen === true;
  }

  function renderIntegrations() {
    keepFocus(() => {
      const status = state.status;
      if (!status) {
        el.integrations.innerHTML = '';
        el.integrationsSection.classList.add('hidden');
        el.health.classList.add('hidden');
        return;
      }
      el.integrationsSection.classList.remove('hidden');
      const list = status.integrations || [];
      const live = list.filter((item) => item.active).length;
      const open = isConnectionsOpen();
      const gw = status.gateway || {};

      el.health.classList.remove('hidden');
      el.health.classList.toggle('is-off', !gw.running);
      el.healthText.innerHTML =
        (gw.running ? 'Gateway on' : 'Gateway off') +
        (list.length
          ? ' · <span class="hl-long">' + live + ' of ' + list.length + ' tools</span><span class="hl-short">' + live + '/' + list.length + ' tools</span>'
          : '');
      el.health.title = (gw.running ? 'Local gateway running at ' + hostOf(gw.url) : 'Local gateway is stopped') + ' — show connections';

      const gateway =
        '<div class="conn-row conn-gw">' +
        '<i class="sdot ' + (gw.running ? 'on' : 'off') + '"></i>' +
        '<div class="conn-text"><span class="conn-name">Gateway <span class="conn-state">' +
        (gw.running ? 'running' : 'stopped') + '</span></span>' +
        '<span class="conn-sub mono" title="Local endpoint for tools outside VS Code">' +
        escapeHtml(gw.running ? hostOf(gw.url) : 'Local endpoint for tools outside VS Code') + '</span></div>' +
        '<div class="conn-actions">' +
        '<button class="icon-btn" data-gateway-action="copyGatewayInfo" data-key="gw-copy" aria-label="Copy URL and key" title="Copy the base URL and key for a terminal CLI or another tool">' + ICON.copy + '</button>' +
        '<button class="icon-btn" data-gateway-action="restartGateway" data-key="gw-restart" aria-label="Restart gateway" title="Restart the local server if the port changed or requests stopped going through">' + ICON.restart + '</button>' +
        '</div></div>';

      const chips = list
        .map((item) =>
          '<span class="cchip ' + (item.active ? 'on' : item.installed ? 'idle' : 'off') + '"><i class="sdot"></i>' +
          escapeHtml(item.label) + '</span>',
        )
        .join('');

      const toggle =
        '<button class="conn-toggle" data-conn-toggle data-key="conn-toggle" aria-expanded="' + open + '">' +
        (open ? '<span class="conn-toggle-label">AI clients</span>' : '<span class="cchips">' + chips + '</span>') +
        '<span class="conn-toggle-end">' + (open ? 'Less' : 'Manage') + ICON.chevron + '</span></button>';

      const rows = open
        ? list
            .map((item) => {
              const target = escapeAttribute(item.target);
              const canRestore = item.active && item.restorable !== false;
              const sub = !item.installed
                ? 'Not detected'
                : item.active
                  ? item.modelId || 'Using a gateway model'
                  : item.idleText || 'Using its own defaults';
              return (
                '<div class="conn-row' + (item.installed ? '' : ' is-missing') + '" title="' + escapeAttribute(item.detail || '') + '">' +
                '<i class="sdot ' + (item.active ? 'on' : item.installed ? 'idle' : 'off') + '"></i>' +
                '<div class="conn-text"><span class="conn-name">' + escapeHtml(item.label) + '</span>' +
                '<span class="conn-sub' + (item.active ? ' is-on' : '') + '">' + escapeHtml(sub) + '</span></div>' +
                '<div class="conn-actions">' +
                (canRestore
                  ? '<button class="btn btn-sm btn-ghost" data-agent="' + target + '" data-agent-action="restoreAgent" data-key="restore-' + target + '" title="Put back this tool\'s own settings">Restore</button>'
                  : '') +
                '<button class="btn btn-sm" data-agent="' + target + '" data-agent-action="applyAgent" data-key="apply-' + target + '">' +
                escapeHtml(item.applyLabel || (item.active ? 'Change' : 'Use model')) + '</button>' +
                '</div></div>'
              );
            })
            .join('')
        : '';

      el.integrations.innerHTML = gateway + toggle + (open ? '<div class="conn-list">' + rows + '</div>' : '');
      el.integrationsMeta.textContent = list.length
        ? live > 0 ? live + ' of ' + list.length + ' wired' : 'none wired yet'
        : '';
    });
  }

  // ── Usage ─────────────────────────────────────────────────────────────────

  function renderUsage() {
    const rows = state.usage || [];
    const names = modelNames();
    el.usageEmpty.classList.toggle('hidden', rows.length > 0);

    // Merge per model across accounts: the question is which models eat tokens.
    const byModel = new Map();
    const byAccount = new Map();
    const totals = { requests: 0, input: 0, thinking: 0, output: 0 };
    const familyTokens = {};
    rows.forEach((row) => {
      const input = Number(row.inputTokens) || 0;
      const thinking = Number(row.thoughtTokens) || 0;
      const output = Number(row.outputTokens) || 0;
      const requests = Number(row.requests) || 0;
      const tokens = input + thinking + output;
      totals.requests += requests;
      totals.input += input;
      totals.thinking += thinking;
      totals.output += output;
      const family = familyOf(row.modelId);
      familyTokens[family] = (familyTokens[family] || 0) + tokens;

      const model = byModel.get(row.modelId) || { modelId: row.modelId, requests: 0, input: 0, thinking: 0, output: 0, accounts: new Map() };
      model.requests += requests;
      model.input += input;
      model.thinking += thinking;
      model.output += output;
      model.accounts.set(row.accountId, (model.accounts.get(row.accountId) || 0) + tokens);
      byModel.set(row.modelId, model);

      const account = byAccount.get(row.accountId) || { accountId: row.accountId, requests: 0, tokens: 0 };
      account.requests += requests;
      account.tokens += tokens;
      byAccount.set(row.accountId, account);
    });

    setCount(el.usageCount, byModel.size);
    const nameOf = (id) => {
      const account = findAccount(id);
      return account ? localPart(account.email) : id;
    };

    if (rows.length === 0) {
      el.usageBody.innerHTML = '';
    } else {
      const all = totals.input + totals.thinking + totals.output;
      const share = (value) => (all > 0 ? (value / all) * 100 : 0);
      const families = ['claude', 'gemini', 'gpt', 'other'].filter((family) => familyTokens[family] > 0);
      const headline =
        '<section class="uhead glass">' +
        '<div class="uhead-top">' +
        '<div class="uhead-main"><span class="eyebrow">Tokens served</span>' +
        '<span class="uhead-big tnum" title="' + escapeAttribute(formatNumber(all) + ' tokens') + '">' + formatCompact(all) + '</span></div>' +
        '<div class="uhead-side">' +
        '<span class="uhead-stat"><b class="tnum">' + formatNumber(totals.requests) + '</b> requests</span>' +
        '<span class="uhead-stat"><b class="tnum">' + byAccount.size + '</b> ' + (byAccount.size === 1 ? 'account' : 'accounts') + ' active</span>' +
        '</div>' +
        '</div>' +
        '<div class="mix" role="img" aria-label="' + escapeAttribute('Token mix: input ' + Math.round(share(totals.input)) + '%, thinking ' +
          Math.round(share(totals.thinking)) + '%, output ' + Math.round(share(totals.output)) + '%') + '">' +
        '<i class="mix-in" data-width="' + share(totals.input).toFixed(2) + '"></i>' +
        '<i class="mix-think" data-width="' + share(totals.thinking).toFixed(2) + '"></i>' +
        '<i class="mix-out" data-width="' + share(totals.output).toFixed(2) + '"></i>' +
        '</div>' +
        '<div class="mix-legend">' +
        legend('in', 'Input', share(totals.input), totals.input) +
        legend('think', 'Thinking', share(totals.thinking), totals.thinking) +
        legend('out', 'Output', share(totals.output), totals.output) +
        '</div>' +
        (families.length > 1
          ? '<div class="fam-share">' +
            families.map((family) =>
              '<span class="fchip paint-' + family + '" title="' + escapeAttribute(formatNumber(familyTokens[family]) + ' tokens') + '">' +
              '<i class="fam-dot fam-' + family + '"></i>' + FAMILY_LABEL[family] + ' <b class="tnum">' +
              Math.round(share(familyTokens[family])) + '%</b></span>').join('') +
            '</div>'
          : '') +
        '</section>';

      const models = [...byModel.values()].sort((a, b) => b.input + b.thinking + b.output - (a.input + a.thinking + a.output));
      const max = Math.max(1, ...models.map((model) => model.input + model.thinking + model.output));
      const modelRows = models
        .map((model) => {
          const total = model.input + model.thinking + model.output;
          const family = familyOf(model.modelId);
          const split = [...model.accounts.entries()].sort((a, b) => b[1] - a[1]);
          const who = split.length > 1
            ? split.map(([id, tokens]) => escapeHtml(nameOf(id)) + ' <b class="tnum">' + formatCompact(tokens) + '</b>').join('<span class="sep"> · </span>')
            : escapeHtml(nameOf(split[0][0]));
          return (
            '<div class="urow" title="' + escapeAttribute(model.modelId) + '">' +
            '<div class="urow-top"><i class="fam-dot fam-' + family + '"></i>' +
            '<span class="urow-name">' + escapeHtml(names.get(model.modelId) || prettyModel(model.modelId)) + '</span>' +
            '<span class="urow-total tnum" title="' + escapeAttribute(formatNumber(total) + ' tokens') + '">' + formatCompact(total) + '</span></div>' +
            '<div class="ubar">' +
            '<i class="mix-in" data-width="' + ((model.input / max) * 100).toFixed(2) + '" title="' + escapeAttribute(formatNumber(model.input) + ' input') + '"></i>' +
            '<i class="mix-think" data-width="' + ((model.thinking / max) * 100).toFixed(2) + '" title="' + escapeAttribute(formatNumber(model.thinking) + ' thinking') + '"></i>' +
            '<i class="mix-out" data-width="' + ((model.output / max) * 100).toFixed(2) + '" title="' + escapeAttribute(formatNumber(model.output) + ' output') + '"></i>' +
            '</div>' +
            // The split behind the bar, as figures: the bar shows the shape,
            // these say how much went in, how much was thought, what came out.
            '<div class="urow-mix">' +
            tokenFigure('in', 'In', model.input) +
            tokenFigure('think', 'Think', model.thinking) +
            tokenFigure('out', 'Out', model.output) +
            '</div>' +
            '<div class="urow-sub"><span class="urow-who">' + who + '</span>' +
            '<span class="urow-req tnum">' + formatNumber(model.requests) + ' req</span></div>' +
            '</div>'
          );
        })
        .join('');

      const accounts = [...byAccount.values()].sort((a, b) => b.tokens - a.tokens);
      const accountTotal = Math.max(1, accounts.reduce((sum, item) => sum + item.tokens, 0));
      const accountRows = accounts
        .map((item) => {
          const account = findAccount(item.accountId);
          const pct = (item.tokens / accountTotal) * 100;
          return (
            '<div class="arow">' +
            (account ? avatar(account, 'xs') : '<span class="avatar avatar-xs"></span>') +
            '<span class="arow-name">' + escapeHtml(nameOf(item.accountId)) + '</span>' +
            '<span class="arow-bar"><i data-width="' + pct.toFixed(2) + '"></i></span>' +
            '<span class="arow-pct tnum">' + Math.round(pct) + '%</span>' +
            '<span class="arow-total tnum" title="' + escapeAttribute(formatNumber(item.requests) + ' requests') + '">' + formatCompact(item.tokens) + '</span>' +
            '</div>'
          );
        })
        .join('');

      el.usageBody.innerHTML =
        headline +
        '<section class="section"><div class="section-head"><span class="eyebrow">By model</span>' +
        '<span class="section-meta">tokens, largest first</span></div>' +
        '<div class="list glass-quiet">' + modelRows + '</div></section>' +
        (accounts.length > 1
          ? '<section class="section"><div class="section-head"><span class="eyebrow">By account</span>' +
            '<span class="section-meta">share of tokens</span></div>' +
            '<div class="list glass-quiet arows">' + accountRows + '</div></section>'
          : '');
    }

    renderTrends(byAccount);
    applySizes(el.usageBody);
    applySizes(el.trendsSection);
  }

  function tokenFigure(kind, label, value) {
    return '<span class="mix-key' + (value === 0 ? ' is-zero' : '') + '" title="' +
      escapeAttribute(formatNumber(value) + ' ' + ({ in: 'input', think: 'thinking', out: 'output' }[kind]) + ' tokens') + '">' +
      '<i class="key key-' + kind + '"></i>' + label + ' <b class="tnum">' + formatCompact(value) + '</b></span>';
  }

  function legend(kind, label, pct, value) {
    return '<span class="mix-key" title="' + escapeAttribute(formatNumber(value) + ' ' + label.toLowerCase() + ' tokens') + '">' +
      '<i class="key key-' + kind + '"></i>' + label + ' <b class="tnum">' +
      (pct > 0 && pct < 1 ? '<1' : Math.round(pct)) + '%</b><span class="mix-val tnum">' + formatCompact(value) + '</span></span>';
  }

  // ── Quota history ─────────────────────────────────────────────────────────

  /**
   * One compact row per account: who, a strip with a block per reading (its
   * height the lowest pool at that moment), and where it stands now. Full or
   * steady readings are neutral; colour only arrives under 50% and 20%.
   */
  function renderTrends(byAccount) {
    const series = state.history || [];
    const rows = series
      .map((entry) => {
        const account = findAccount(entry.accountId);
        if (!account || !entry.points || entry.points.length < 2) {
          return '';
        }
        const stale = account.needsReauth || !!account.lastError;
        const points = sample(entry.points, 24);
        const latest = entry.points[entry.points.length - 1];
        const bars = points
          .map((point) => {
            const min = clamp(Math.round(point.min !== undefined ? point.min : 100), 0, 100);
            const detail = Object.keys(point.byFamily || {})
              .map((family) => (FAMILY_SHORT[family] || family) + ' ' + point.byFamily[family] + '%')
              .join(' · ');
            return '<i class="tb tone-' + toneOf(min) + '" data-h="' + Math.max(10, min) + '" title="' +
              escapeAttribute(formatTime(point.at) + ' — ' + (detail || min + '%')) + '"></i>';
          })
          .join('');

        // The binding pool now, and how fast the fastest family is moving.
        const families = Object.keys(latest.byFamily || {});
        const tightFamily = families.slice().sort((a, b) => latest.byFamily[a] - latest.byFamily[b])[0];
        let drain = '';
        let drainTone = 'muted';
        let fastest = 0;
        families.forEach((family) => {
          const rate = drainRate(entry.accountId, family) || 0;
          const now = latest.byFamily[family];
          if (rate > fastest && rate >= 0.5 && now > 0) {
            fastest = rate;
            drain = (FAMILY_SHORT[family] || family) + ' −' + rate.toFixed(rate < 10 ? 1 : 0) + '%/h · empty in ~' + formatMinutes((now / rate) * 60);
            drainTone = toneOf(now) === 'good' ? 'muted' : toneOf(now);
          }
        });
        const emptyFamily = families.find((family) => latest.byFamily[family] <= 0);
        if (emptyFamily && !drain) {
          drain = (FAMILY_SHORT[emptyFamily] || emptyFamily) + ' empty';
          drainTone = 'low';
        }
        const min = clamp(Math.round(latest.min !== undefined ? latest.min : 100), 0, 100);
        const poolName = min >= 100 ? 'all full' : tightFamily ? FAMILY_SHORT[tightFamily] || tightFamily : '';
        const usage = byAccount && byAccount.get(entry.accountId);
        const requests = usage ? formatNumber(usage.requests) + ' req' : '';
        const staleLabel = account.needsReauth ? 'signed out' : account.lastError ? 'last read failed' : '';
        const sub = stale
          ? '<span class="trow-flag tone-' + (account.needsReauth ? 'warn' : 'low') + '">' + staleLabel + '</span>'
          : drain
            ? '<span class="tone-' + drainTone + '">' + escapeHtml(drain) + '</span>'
            : '';
        return (
          '<div class="trow' + (stale ? ' is-stale' : '') + '" title="' + escapeAttribute(account.email + ' — ' + formatSpan(entry.points[0].at, latest.at)) + '">' +
          '<div class="trow-line">' +
          avatar(account, 'xs') +
          '<span class="trow-name">' + escapeHtml(localPart(account.email)) +
          (account.isActive ? '<i class="live-dot" title="Serving now"></i>' : '') + '</span>' +
          '<div class="tbars" role="img" aria-label="' + escapeAttribute('Lowest pool over the ' + formatSpan(entry.points[0].at, latest.at)) + '">' + bars + '</div>' +
          '<span class="trow-now"><b class="tnum tone-' + (stale ? 'muted' : toneOf(min)) + '">' + min + '%</b><small>' + escapeHtml(poolName) + '</small></span>' +
          '</div>' +
          (sub || requests ? '<div class="trow-sub">' + (sub || '<span></span>') + (requests ? '<span class="tnum">' + requests + '</span>' : '') + '</div>' : '') +
          '</div>'
        );
      })
      .filter(Boolean);

    el.trendsSection.classList.toggle('hidden', rows.length === 0);
    el.trends.innerHTML = rows.join('');
  }

  function sample(points, max) {
    if (points.length <= max) {
      return points;
    }
    const out = [];
    for (let index = 0; index < max; index++) {
      out.push(points[Math.round((index * (points.length - 1)) / (max - 1))]);
    }
    return out;
  }

  // ── Sizes (CSP forbids style="" in markup, so sizes go through the CSSOM) ──

  function applySizes(container) {
    container.querySelectorAll('[data-width]').forEach((node) => {
      node.style.width = node.dataset.width + '%';
    });
    container.querySelectorAll('[data-h]').forEach((node) => {
      node.style.height = node.dataset.h + '%';
    });
    container.querySelectorAll('[data-left]').forEach((node) => {
      node.style.left = node.dataset.left + '%';
    });
    container.querySelectorAll('[data-hue]').forEach((node) => {
      node.style.setProperty('--h', node.dataset.hue);
    });
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────

  function selectTab(name) {
    currentTab = name;
    closeMenu();
    document.querySelectorAll('.seg').forEach((tab) => {
      const selected = tab.dataset.tab === name;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    document.getElementById('accounts-tab').classList.toggle('hidden', name !== 'accounts');
    document.getElementById('usage-tab').classList.toggle('hidden', name !== 'usage');
  }

  // ── Pieces ────────────────────────────────────────────────────────────────

  /**
   * The real picture when Google gives one; otherwise a gradient disc whose hue
   * is hashed inside the cool brand range (190-300), so no avatar can be
   * mistaken for Claude orange or GPT-OSS green.
   */
  function avatar(account, size, live) {
    const initial = (account.name || account.email || '?').trim().charAt(0).toUpperCase();
    const badge = live ? '<i class="avatar-badge" aria-hidden="true"></i>' : '';
    if (account.picture) {
      return '<span class="avatar avatar-' + size + ' has-img"><img src="' + escapeAttribute(account.picture) +
        '" alt="" referrerpolicy="no-referrer" />' + badge + '</span>';
    }
    const hue = 190 + (Math.imul(hash(account.email || account.id), 2654435761) >>> 0) % 111;
    return '<span class="avatar avatar-' + size + ' av-disc" data-hue="' + hue + '" aria-hidden="true">' + escapeHtml(initial) + badge + '</span>';
  }

  /** The local part carries identity; the shared domain steps back. */
  function emailHtml(email, className, hideDomain) {
    const value = String(email || '');
    const at = value.indexOf('@');
    if (at < 0 || hideDomain) {
      if (at > 0) {
        return '<div class="' + className + '" title="' + escapeAttribute(value) + '"><span class="local">' +
          escapeHtml(value.slice(0, at)) + '</span></div>';
      }
      return '<div class="' + className + '" title="' + escapeAttribute(value) + '">' + escapeHtml(value) + '</div>';
    }
    return (
      '<div class="' + className + '" title="' + escapeAttribute(value) + '"><span class="local">' + escapeHtml(value.slice(0, at)) +
      '</span><span class="domain">' + escapeHtml(value.slice(at)) + '</span></div>'
    );
  }

  const ICON = {
    more: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
    chevron: '<svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>',
    grip: '<svg class="grip" width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.1"/><circle cx="7" cy="3" r="1.1"/><circle cx="3" cy="7" r="1.1"/><circle cx="7" cy="7" r="1.1"/><circle cx="3" cy="11" r="1.1"/><circle cx="7" cy="11" r="1.1"/></svg>',
    bolt: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M9 1.5 3.5 9h4L7 14.5 12.5 7h-4z"/></svg>',
    key: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="5.5" cy="10.5" r="3"/><path d="M7.7 8.3 13.5 2.5M11.5 4.5l1.5 1.5"/></svg>',
    refresh: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 6.2A5.3 5.3 0 0 0 3.6 4.4"/><path d="M2.8 9.8a5.3 5.3 0 0 0 9.6 1.8"/><path d="M13.4 2.6v3.6H9.8"/><path d="M2.6 13.4V9.8h3.6"/></svg>',
    up: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4"/></svg>',
    down: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M4 9l4 4 4-4"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9"/></svg>',
    copy: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 5.5V4.3c0-1-.8-1.8-1.8-1.8H4.3c-1 0-1.8.8-1.8 1.8v4.4c0 1 .8 1.8 1.8 1.8h1.2"/></svg>',
    restart: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M4.3 1.8v2.8h2.8"/></svg>',
    alert: '<svg class="trouble-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v3.6M8 11h.01"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.5"/></svg>',
    trend: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5l4.5 4.5 2.5-2.5 5 5"/><path d="M14 8v3.5h-3.5"/></svg>',
    reset: '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1"/><path d="M4.2 1.5v2.6h2.6"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  };
  ICON.key = ICON.key.replace('<svg ', '<svg class="trouble-icon" ');

  // ── Helpers ───────────────────────────────────────────────────────────────

  function post(type, payload) {
    vscode.postMessage(Object.assign({ type }, payload || {}));
  }

  function findAccount(id) {
    return (state.accounts || []).find((account) => account.id === id);
  }

  function setCount(node, count) {
    node.textContent = count > 0 ? String(count) : '';
  }

  function toneOf(percentage) {
    if (percentage < LOW_BELOW) {
      return 'low';
    }
    return percentage < WARN_BELOW ? 'warn' : 'good';
  }

  function familyOf(modelId) {
    const id = String(modelId || '').toLowerCase();
    if (id.includes('claude')) {
      return 'claude';
    }
    if (id.includes('gemini')) {
      return 'gemini';
    }
    return id.includes('gpt') ? 'gpt' : 'other';
  }

  function modelNames() {
    const names = new Map();
    (state.accounts || []).forEach((account) => {
      (account.models || []).forEach((model) => {
        if (model.displayName && !names.has(model.modelId)) {
          names.set(model.modelId, model.displayName);
        }
      });
    });
    return names;
  }

  /** claude-opus-5-5-medium → Claude Opus 5.5 Medium, when no display name is known. */
  function prettyModel(modelId) {
    const parts = String(modelId || '').split('-');
    const out = [];
    parts.forEach((part) => {
      const previous = out[out.length - 1];
      if (/^\d+$/.test(part) && previous && /^\d+(\.\d+)*$/.test(previous)) {
        out[out.length - 1] = previous + '.' + part;
      } else if (/^gpt$/i.test(part) || /^oss$/i.test(part)) {
        out.push(part.toUpperCase());
      } else {
        out.push(part.charAt(0).toUpperCase() + part.slice(1));
      }
    });
    return out.join(' ').replace('GPT OSS', 'GPT-OSS');
  }

  /** When every account shares a domain, the domain says nothing in a list. */
  function sharedDomain() {
    const domains = new Set((state.accounts || []).map((account) => String(account.email || '').split('@')[1] || ''));
    return domains.size === 1 && (state.accounts || []).length > 1;
  }

  function localPart(email) {
    const value = String(email || '');
    const at = value.indexOf('@');
    return at > 0 ? value.slice(0, at) : value;
  }

  function hostOf(url) {
    return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  function portOf(url) {
    const match = /:(\d+)/.exec(hostOf(url));
    return match ? ':' + match[1] : 'on';
  }

  function shortError(message) {
    const code = /\b([45]\d\d)\b/.exec(String(message));
    if (code) {
      return code[1];
    }
    return String(message).replace(/^quota refresh failed:?\s*/i, '').slice(0, 40);
  }

  /** "1d 4h", "3h 12m", "45m" → minutes. */
  function parseDuration(text) {
    if (!text) {
      return undefined;
    }
    let minutes = 0;
    let matched = false;
    String(text).replace(/(\d+(?:\.\d+)?)\s*([dhm])/g, (_, value, unit) => {
      matched = true;
      minutes += Number(value) * (unit === 'd' ? 1440 : unit === 'h' ? 60 : 1);
      return '';
    });
    return matched ? minutes : undefined;
  }

  function formatMinutes(minutes) {
    const value = Math.max(1, Math.round(minutes));
    if (value < 60) {
      return value + 'm';
    }
    if (value < 1440) {
      const hours = Math.floor(value / 60);
      const rest = value % 60;
      return hours + 'h' + (rest ? ' ' + rest + 'm' : '');
    }
    return Math.floor(value / 1440) + 'd ' + Math.floor((value % 1440) / 60) + 'h';
  }

  function formatAgo(timestamp) {
    const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
    if (seconds < 45) {
      return 'updated just now';
    }
    if (seconds < 3600) {
      return 'updated ' + Math.round(seconds / 60) + 'm ago';
    }
    if (seconds < 86400) {
      return 'updated ' + Math.round(seconds / 3600) + 'h ago';
    }
    return 'updated ' + new Date(timestamp).toLocaleDateString();
  }

  function formatSpan(fromAt, toAt) {
    const minutes = Math.round((toAt - fromAt) / 60000);
    if (minutes < 60) {
      return 'last ' + Math.max(1, minutes) + 'm';
    }
    const hours = Math.round(minutes / 60);
    return hours < 48 ? 'last ' + hours + 'h' : 'last ' + Math.round(hours / 24) + 'd';
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatNumber(value) {
    return (Number(value) || 0).toLocaleString();
  }

  function formatCompact(value) {
    const count = Number(value) || 0;
    if (count < 10000) {
      return formatNumber(count);
    }
    if (count < 1000000) {
      return (count / 1000).toFixed(count < 100000 ? 1 : 0) + 'k';
    }
    return (count / 1000000).toFixed(1) + 'M';
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function hash(text) {
    let value = 0;
    String(text).split('').forEach((char) => {
      value = (value * 31 + char.charCodeAt(0)) >>> 0;
    });
    return value;
  }

  function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
  }

  void currentTab;
  post('ready');
})();
