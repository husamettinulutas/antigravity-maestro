/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();

  /** Last state pushed by the extension. */
  let state = { accounts: [], usage: [] };

  // Which cards are open, remembered across reloads. Every account starts
  // collapsed — the quota rows already answer "how much is left", and stacking
  // the cards shut is what makes several accounts readable at once. Bumping the
  // version drops choices made under an older default.
  const STATE_VERSION = 3;
  const persisted = vscode.getState() || {};
  const restorable = persisted.stateVersion === STATE_VERSION ? persisted : {};
  const openAccounts = new Set(restorable.openAccounts || []);
  /** Cards and bars animate once, on the first render of a session. */
  let firstPaint = true;
  const openModelLists = new Set(restorable.openModelLists || []);

  const el = {
    accounts: document.getElementById('accounts'),
    accountsMeta: document.getElementById('accounts-meta'),
    accountsCount: document.getElementById('accounts-count'),
    empty: document.getElementById('empty'),
    integrations: document.getElementById('integrations'),
    integrationsMeta: document.getElementById('integrations-meta'),
    integrationsSection: document.getElementById('integrations-section'),
    trends: document.getElementById('trends'),
    trendsSection: document.getElementById('trends-section'),
    usageBody: document.getElementById('usage-body'),
    usageCount: document.getElementById('usage-count'),
    usageEmpty: document.getElementById('usage-empty'),
  };

  // ── Events ────────────────────────────────────────────────────────────────

  document.getElementById('add-account').addEventListener('click', () => post('addAccount'));
  document.getElementById('add-account-empty').addEventListener('click', () => post('addAccount'));
  document.getElementById('refresh-all').addEventListener('click', () => post('refreshAll'));
  document.getElementById('clear-history').addEventListener('click', () => post('clearHistory'));
  document.getElementById('open-logs').addEventListener('click', () => post('openLogs'));

  document.querySelectorAll('.tab-btn').forEach((tab) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  });

  // Account card buttons are delegated so re-rendering never loses handlers.
  el.accounts.addEventListener('click', (event) => {
    // Action buttons win over the surrounding toggle they sit inside.
    const button = event.target.closest('button[data-action]');
    if (button) {
      post(button.dataset.action, { accountId: button.dataset.accountId });
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
  });

  // Dragging a card reorders the accounts. The cards move in the DOM while the
  // drag is in flight so the drop lands where it looks like it will; the order
  // is only committed once, on dragend, which fires for a cancelled drag too —
  // and the extension pushes the persisted order straight back.
  el.accounts.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.account-card');
    if (!card) {
      return;
    }
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    // Some hosts refuse to start a drag with an empty payload.
    event.dataTransfer.setData('text/plain', card.dataset.accountId);
  });

  el.accounts.addEventListener('dragover', (event) => {
    const dragged = el.accounts.querySelector('.account-card.dragging');
    if (!dragged) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const over = event.target.closest('.account-card');
    if (!over || over === dragged) {
      return;
    }
    const box = over.getBoundingClientRect();
    const below = event.clientY > box.top + box.height / 2;
    el.accounts.insertBefore(dragged, below ? over.nextSibling : over);
  });

  el.accounts.addEventListener('drop', (event) => {
    if (el.accounts.querySelector('.account-card.dragging')) {
      event.preventDefault();
    }
  });

  el.accounts.addEventListener('dragend', () => {
    const dragged = el.accounts.querySelector('.account-card.dragging');
    if (!dragged) {
      return;
    }
    dragged.classList.remove('dragging');

    const ids = [...el.accounts.querySelectorAll('.account-card')].map(
      (card) => card.dataset.accountId,
    );
    const current = state.accounts.map((account) => account.id);
    if (ids.join('|') !== current.join('|')) {
      post('reorderAccounts', { accountIds: ids });
    }
  });

  document.getElementById('collapse-all').addEventListener('click', () => {
    if (openAccounts.size > 0) {
      openAccounts.clear();
      openModelLists.clear();
    } else {
      state.accounts.forEach((account) => openAccounts.add(account.id));
    }
    savePreferences();
    renderAccounts();
  });

  function savePreferences() {
    vscode.setState({
      stateVersion: STATE_VERSION,
      openAccounts: [...openAccounts],
      openModelLists: [...openModelLists],
    });
  }

  el.integrations.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) {
      return;
    }
    if (button.dataset.agentAction) {
      post(button.dataset.agentAction, { agent: button.dataset.agent });
    } else if (button.dataset.gatewayAction) {
      post(button.dataset.gatewayAction);
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'state') {
      state = message.state;
      render();
    }
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    renderIntegrations();
    renderAccounts();
    renderUsage();
    firstPaint = false;
  }

  // ── Integrations ──────────────────────────────────────────────────────────

  function renderIntegrations() {
    const status = state.status;
    if (!status) {
      el.integrations.innerHTML = '';
      el.integrationsSection.classList.add('hidden');
      return;
    }
    el.integrationsSection.classList.remove('hidden');

    // The gateway only matters to tools outside VS Code, so its row says what
    // it is for rather than assuming the reader knows. The URL sits on its own
    // monospace line: appended to the name, it was the thing that pushed every
    // other row in this list out of shape.
    const running = status.gateway.running;
    const gateway = agentCard({
      target: 'gateway',
      dot: running ? 'on' : 'off',
      name: 'Gateway',
      id: running ? status.gateway.url || '' : '',
      status: running ? 'running' : 'stopped',
      tone: running ? 'on' : 'off',
      title: 'Local endpoint for tools outside VS Code',
      actions:
        '<button class="btn btn-sm" data-gateway-action="copyGatewayInfo" title="Copy the base URL and key for a terminal CLI or another tool">Copy URL + key</button>' +
        '<button class="btn btn-sm btn-ghost" data-gateway-action="restartGateway" title="Restart the local server if the port changed or requests stopped going through">Restart</button>',
    });

    const live = status.integrations.filter((item) => item.active).length;
    const rows = status.integrations.map(function (item) {
      const target = escapeAttribute(item.target);
      const restorable = item.restorable !== false;
      return agentCard({
        target: item.target,
        missing: !item.installed,
        dot: item.active ? 'on' : item.installed ? 'idle' : 'off',
        name: item.label,
        status: !item.installed
          ? 'not detected'
          : item.active
            ? item.modelId || 'a model'
            : item.idleText || 'own defaults',
        tone: !item.installed ? 'off' : item.active ? 'on' : 'idle',
        title: item.detail || '',
        actions:
          '<button class="btn btn-sm" data-agent="' + target + '" data-agent-action="applyAgent">' +
          escapeHtml(item.applyLabel || 'Use model') +
          '</button>' +
          (item.active && restorable
            ? '<button class="btn btn-sm btn-ghost" data-agent="' +
              target +
              '" data-agent-action="restoreAgent">Restore</button>'
            : ''),
      });
    });

    el.integrations.classList.toggle('first-paint', firstPaint);
    el.integrations.innerHTML = gateway + rows.join('');
    el.integrationsMeta.textContent =
      live > 0 ? live + ' of ' + status.integrations.length + ' wired up' : 'none wired up yet';
  }

  /**
   * One integration card. The coloured left edge carries the agent's identity,
   * so the list is scannable before any of it is read; below 560px the buttons
   * take their own line rather than squeezing the name into an ellipsis.
   */
  function agentCard(row) {
    const classes = [
      'agent-card',
      'agent-' + escapeAttribute(row.target),
      row.missing ? 'is-missing' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      '<article class="' + classes + '" title="' + escapeAttribute(row.title || '') + '">' +
      '<span class="dot ' + row.dot + '"></span>' +
      '<div class="agent-info">' +
      '<span class="agent-name">' + escapeHtml(row.name) + '</span>' +
      (row.id ? '<span class="agent-id">' + escapeHtml(row.id) + '</span>' : '') +
      '</div>' +
      '<span class="pill pill-' + row.tone + ' agent-status">' + escapeHtml(row.status) + '</span>' +
      '<div class="agent-actions">' + row.actions + '</div>' +
      '</article>'
    );
  }

  // ── Accounts ──────────────────────────────────────────────────────────────

  function renderAccounts() {
    const accounts = state.accounts || [];
    el.empty.classList.toggle('hidden', accounts.length > 0);
    // The cards rise in and the bars grow from zero on the first paint only.
    // Replaying either on every expand, collapse or drop made the whole panel
    // look like it was reloading itself each time a card was touched.
    el.accounts.classList.toggle('first-paint', firstPaint);
    el.accounts.innerHTML = accounts.map(renderAccount).join('');

    setBadge(el.accountsCount, accounts.length);
    const active = accounts.find((account) => account.isActive);
    el.accountsMeta.textContent = active ? active.email + ' is serving' : '';

    document.getElementById('collapse-all').title =
      openAccounts.size > 0 ? 'Collapse every account' : 'Expand every account';

    paintBars(el.accounts, firstPaint);
  }

  function renderAccount(account) {
    const open = openAccounts.has(account.id);
    const tone = quotaTone(account.lowestQuota);

    const pills = [
      account.needsReauth ? '<span class="pill pill-warn">Sign in again</span>' : '',
      account.tier ? '<span class="pill pill-tier">' + escapeHtml(account.tier) + '</span>' : '',
      account.isActive ? '<span class="pill pill-live">Active</span>' : '',
    ].join('');

    const updated = account.quotaFetchedAt
      ? 'Updated ' + formatTime(account.quotaFetchedAt)
      : 'Quota not loaded yet';

    // The tightest quota on the account, as a figure rather than a chip: it is
    // the number the collapsed card exists to report.
    const lead =
      account.lowestQuota === undefined
        ? ''
        : '<div class="account-lead">' +
          '<span class="lead-value quota-' + tone + '">' + account.lowestQuota + '</span>' +
          '<span class="lead-unit">%</span>' +
          '<span class="lead-label">min</span>' +
          '</div>';

    const actions = [
      account.isActive
        ? ''
        : '<button class="btn btn-sm" data-action="setActive" data-account-id="' +
          account.id +
          '">Use</button>',
      account.needsReauth
        ? '<button class="btn btn-sm btn-primary" data-action="reauth" data-account-id="' +
          account.id +
          '">Re-auth</button>'
        : '<button class="btn btn-sm" data-action="refreshAccount" data-account-id="' +
          account.id +
          '">Refresh</button>',
      '<button class="btn btn-sm btn-danger" data-action="removeAccount" data-account-id="' +
        account.id +
        '">Remove</button>',
    ].join('');

    const avatar = account.picture
      ? '<img class="avatar" src="' + escapeAttribute(account.picture) + '" alt="" />'
      : '<div class="avatar"></div>';

    const classes = [
      'account-card',
      account.isActive ? 'is-active' : '',
      account.needsReauth ? 'is-stale' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      '<article class="' + classes + '" draggable="true" data-account-id="' + account.id + '">' +
      '<header class="account-head" data-toggle="account" data-account-id="' + account.id +
      '" role="button" aria-expanded="' + open + '" title="' + (open ? 'Collapse' : 'Expand') +
      ' this account">' +
      '<span class="grip" title="Drag to reorder. Rotation falls back down this list">⠿</span>' +
      '<span class="chevron ' + (open ? 'open' : '') + '" aria-hidden="true">›</span>' +
      avatar +
      '<div class="account-info">' +
      '<span class="account-email">' + escapeHtml(account.email) + '</span>' +
      '<span class="account-sub">' + pills + '<span>' + escapeHtml(updated) + '</span></span>' +
      '</div>' +
      lead +
      // Inside the header, not under it: the delegated handler lets an action
      // button win over the toggle it sits in, and a separate row left a band
      // of dead space across the card.
      '<div class="account-actions">' + actions + '</div>' +
      '</header>' +
      (account.lastError
        ? '<div class="error-note">' + escapeHtml(account.lastError) + '</div>'
        : '') +
      (open ? renderAccountBody(account) : renderQuotaSummary(account)) +
      '</article>'
    );
  }

  /**
   * The collapsed card's body: one row per quota pool, each with a family dot,
   * a bar and the figure. This replaced a wrap of long text chips, which cost
   * three lines to say what a bar says in one.
   */
  function renderQuotaSummary(account) {
    const pools = account.pools || [];
    if (pools.length === 0) {
      return '';
    }
    const rows = pools.map((pool) => quotaRow(pool.model));
    return '<div class="quota-list">' + rows.join('') + '</div>';
  }

  function quotaRow(model) {
    const tone = quotaTone(model.percentage);
    const name = model.displayName || model.modelId;
    return (
      '<div class="quota-row" title="' + escapeAttribute(model.modelId) + '">' +
      '<span class="quota-dot fam-' + familyOf(model.modelId) + '"></span>' +
      '<span class="quota-name">' + escapeHtml(name) + '</span>' +
      '<span class="quota-bar"><span class="bar-' + tone + '" data-width="' +
      model.percentage + '"></span></span>' +
      '<span class="quota-pct quota-' + tone + '">' + model.percentage + '%</span>' +
      '</div>'
    );
  }

  function renderAccountBody(account) {
    const pools = account.pools || [];
    const cards = pools.length > 0 ? renderPools(pools) : renderModelGrid(account.models);
    return renderGroups(account.groups) + cards + renderModelList(account);
  }

  /**
   * One card per quota pool. Every model in a pool moves together, so listing
   * them all just repeats the same bar — the count says how many are behind it.
   */
  function renderPools(pools) {
    return renderModelGrid(
      pools.map((pool) => pool.model),
      (model, index) => {
        const extra = pools[index].memberCount - 1;
        return extra > 0
          ? '+' + extra + ' more model' + (extra === 1 ? '' : 's') + ' on this quota'
          : model.modelId;
      },
    );
  }

  /** The full per-model breakdown, folded away behind a link. */
  function renderModelList(account) {
    const models = account.models || [];
    if (models.length === 0) {
      return '';
    }
    const shown = openModelLists.has(account.id);
    return (
      '<div class="more"><button class="link" data-toggle="models" data-account-id="' +
      account.id + '">' + (shown ? 'Hide' : 'Show') + ' all ' + models.length +
      ' models</button></div>' +
      (shown ? renderModelGrid(models) : '')
    );
  }

  function renderModelGrid(models, noteFor) {
    if (!models || models.length === 0) {
      return '';
    }
    const cards = models.map((model, index) =>
      renderModelCard(model, noteFor ? noteFor(model, index) : model.modelId),
    );
    return '<div class="model-grid">' + cards.join('') + '</div>';
  }

  function renderModelCard(model, note) {
    const tone = quotaTone(model.percentage);
    const name = model.displayName || model.modelId;
    return (
      '<div class="model-card" title="' + escapeAttribute(model.modelId) + '">' +
      '<div class="model-card-top">' +
      '<span class="model-card-name">' + escapeHtml(name) + '</span>' +
      '<span class="model-card-pct quota-' + tone + '">' + model.percentage + '%</span>' +
      '</div>' +
      '<div class="bar"><span class="bar-' + tone + '" data-width="' + model.percentage +
      '"></span></div>' +
      '<div class="model-card-sub">' +
      '<span class="model-card-id">' + escapeHtml(note) + '</span>' +
      '<span>' + (model.resetsIn ? 'resets in ' + escapeHtml(model.resetsIn) : '') + '</span>' +
      '</div>' +
      '</div>'
    );
  }

  /** The rolling windows (5-hour, weekly), as the same quota rows. */
  function renderGroups(groups) {
    if (!groups || groups.length === 0) {
      return '';
    }
    const blocks = groups
      .filter((group) => group.buckets.length > 0)
      .map((group) => {
        const label = group.displayName
          ? '<div class="quota-group-name" title="' +
            escapeAttribute(group.description || '') + '">' +
            escapeHtml(group.displayName) + '</div>'
          : '';
        const rows = group.buckets.map((bucket) => {
          const tone = quotaTone(bucket.percentage);
          return (
            '<div class="quota-row">' +
            '<span class="quota-dot fam-other"></span>' +
            '<span class="quota-name">' + escapeHtml(bucket.displayName) + '</span>' +
            '<span class="quota-bar"><span class="bar-' + tone + '" data-width="' +
            bucket.percentage + '"></span></span>' +
            '<span class="quota-pct quota-' + tone + '">' + bucket.percentage + '%</span>' +
            '</div>'
          );
        });
        return label + rows.join('');
      });
    return blocks.length > 0 ? '<div class="quota-list">' + blocks.join('') + '</div>' : '';
  }

  // ── Usage ─────────────────────────────────────────────────────────────────

  function renderUsage() {
    renderTrends();
    const rows = state.usage || [];
    el.usageEmpty.classList.toggle('hidden', rows.length > 0);
    el.usageBody.innerHTML = rows.map(renderUsageCard).join('');
    setBadge(el.usageCount, rows.length);
  }

  /**
   * One usage record. Each count keeps its own colour across the panel, so
   * which number you are looking at is answered before the label is read, and
   * the four of them fold to two columns on a sidebar too narrow for four.
   */
  function renderUsageCard(row) {
    const account = state.accounts.find((candidate) => candidate.id === row.accountId);
    return (
      '<article class="usage-card">' +
      '<div class="usage-head">' +
      '<div class="usage-model">' + escapeHtml(row.modelId) + '</div>' +
      '<div class="usage-account">' +
      escapeHtml(account ? account.email : row.accountId) +
      '</div>' +
      '</div>' +
      metric('requests', 'Req', 'requests', row.requests) +
      metric('input', 'In', 'input tokens', row.inputTokens) +
      metric('thinking', 'Think', 'thinking tokens', row.thoughtTokens || 0) +
      metric('output', 'Out', 'output tokens', row.outputTokens) +
      '</article>'
    );
  }

  function metric(kind, label, description, value) {
    const count = Number(value) || 0;
    return (
      '<div class="metric metric-' + kind + '" title="' +
      escapeAttribute(formatNumber(count) + ' ' + description) + '">' +
      '<span class="metric-label">' + label + '</span>' +
      '<span class="metric-value' + (count === 0 ? ' is-zero' : '') + '">' +
      escapeHtml(formatCompact(count)) + '</span>' +
      '</div>'
    );
  }

  // ── Trends ────────────────────────────────────────────────────────────────

  function renderTrends() {
    const series = state.history || [];
    const cards = series
      .map((entry) => {
        const account = state.accounts.find((candidate) => candidate.id === entry.accountId);
        if (!account || entry.points.length < 2) {
          return '';
        }
        const latest = entry.points[entry.points.length - 1];
        const families = familiesOf(entry.points);
        return (
          '<div class="trend">' +
          '<div class="trend-head">' +
          '<span class="trend-name">' + escapeHtml(account.email) + '</span>' +
          '<span class="trend-span">' +
          escapeHtml(formatSpan(entry.points[0].at, latest.at)) +
          '</span>' +
          '</div>' +
          '<div class="spark-frame">' + sparkline(entry.points, families) + '</div>' +
          '<div class="trend-legend">' +
          families
            .map(
              (family) =>
                '<span class="legend"><i class="quota-dot fam-' + family + '"></i>' +
                escapeHtml(familyLabel(family)) +
                ' <b class="legend-value quota-' + quotaTone(latest.byFamily[family]) + '">' +
                latest.byFamily[family] + '%</b></span>',
            )
            .join('') +
          '</div></div>'
        );
      })
      .filter(Boolean);

    el.trends.innerHTML = cards.join('');
    el.trendsSection.classList.toggle('hidden', cards.length === 0);
  }

  /**
   * Families a card has readings for, in the order the panel names them. Only
   * the ones present in the latest point are drawn: a family that stopped
   * reporting would otherwise leave a line hanging in mid-air.
   */
  function familiesOf(points) {
    const latest = points[points.length - 1].byFamily || {};
    return ['claude', 'gemini', 'gpt', 'other'].filter((family) => latest[family] !== undefined);
  }

  function familyLabel(family) {
    if (family === 'claude') {
      return 'Claude';
    }
    if (family === 'gemini') {
      return 'Gemini';
    }
    return family === 'gpt' ? 'GPT-OSS' : 'Other';
  }

  /** Which family a model id belongs to, for the quota row dots. */
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

  /**
   * Inline SVG polylines — no external libraries, and CSP-safe. The vertical
   * padding matters: at 100% the line sat exactly on the viewBox edge and half
   * its stroke was clipped away, which is what made a full account look like
   * it had drawn nothing but a horizontal rule.
   */
  function sparkline(points, families) {
    const width = 240;
    const height = 44;
    const pad = 3;
    const first = points[0].at;
    const span = Math.max(1, points[points.length - 1].at - first);
    const y = (percentage) =>
      pad + (1 - Math.max(0, Math.min(100, percentage)) / 100) * (height - pad * 2);

    const lines = families.map((family) => {
      const coords = points
        .filter((point) => point.byFamily && point.byFamily[family] !== undefined)
        .map(
          (point) =>
            (((point.at - first) / span) * width).toFixed(1) +
            ',' +
            y(point.byFamily[family]).toFixed(1),
        )
        .join(' ');
      return '<polyline class="spark-' + family + '" points="' + coords + '"></polyline>';
    });

    return (
      '<svg class="spark" viewBox="0 0 ' + width + ' ' + height +
      '" preserveAspectRatio="none" aria-hidden="true">' +
      lines.join('') +
      '</svg>'
    );
  }

  function formatSpan(fromAt, toAt) {
    const minutes = Math.round((toAt - fromAt) / 60000);
    if (minutes < 60) {
      return 'last ' + minutes + 'm';
    }
    const hours = Math.round(minutes / 60);
    return hours < 48 ? 'last ' + hours + 'h' : 'last ' + Math.round(hours / 24) + 'd';
  }

  // ── Bars ──────────────────────────────────────────────────────────────────

  /**
   * Paint the quota bars. Animated, the widths are applied a frame late so the
   * transition has two values to run between; instant, the transition is turned
   * off around the write so a re-render lands silently at the same widths.
   */
  function paintBars(container, animate) {
    if (animate) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => applyBarWidths(container));
      });
      return;
    }

    container.classList.add('instant');
    applyBarWidths(container);
    requestAnimationFrame(() => container.classList.remove('instant'));
  }

  /**
   * The webview CSP forbids inline style attributes, so bar widths are applied
   * through the CSSOM after each render.
   */
  function applyBarWidths(container) {
    container.querySelectorAll('[data-width]').forEach((node) => {
      node.style.width = node.dataset.width + '%';
    });
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────

  function selectTab(name) {
    document.querySelectorAll('.tab-btn').forEach((tab) => {
      const selected = tab.dataset.tab === name;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    document.getElementById('accounts-tab').classList.toggle('hidden', name !== 'accounts');
    document.getElementById('usage-tab').classList.toggle('hidden', name !== 'usage');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function post(type, payload) {
    vscode.postMessage(Object.assign({ type }, payload || {}));
  }

  /** A count on a tab, hidden entirely at zero rather than shown as "0". */
  function setBadge(node, count) {
    node.textContent = count > 0 ? String(count) : '';
    node.classList.toggle('zero', count === 0);
  }

  function quotaTone(percentage) {
    if (percentage <= 10) {
      return 'low';
    }
    return percentage <= 40 ? 'warn' : 'good';
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatNumber(value) {
    return (Number(value) || 0).toLocaleString();
  }

  /**
   * Token counts reach the millions, and on a docked sidebar four of them share
   * one line. Past five figures the number is shortened so the strip stays
   * readable at a glance; the exact figure rides along in the tooltip.
   */
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

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
  }

  post('ready');
})();
