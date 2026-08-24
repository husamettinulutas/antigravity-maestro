/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();

  /** Last state pushed by the extension. */
  let state = { accounts: [], usage: [] };

  // Which cards are open, remembered across reloads. Every account starts
  // collapsed — the pool chips already answer "how much is left", and stacking
  // the cards shut is what makes several accounts readable at once. Bumping the
  // version drops choices made under an older default.
  const STATE_VERSION = 3;
  const persisted = vscode.getState() || {};
  const restorable = persisted.stateVersion === STATE_VERSION ? persisted : {};
  const openAccounts = new Set(restorable.openAccounts || []);
  /** Cards and bars animate once, on the first render of a session. */
  let barsAnimated = false;
  const openModelLists = new Set(restorable.openModelLists || []);

  const el = {
    accounts: document.getElementById('accounts'),
    empty: document.getElementById('empty'),
    integrations: document.getElementById('integrations'),
    trends: document.getElementById('trends'),
    usageTable: document.querySelector('.table-wrap'),
    usageBody: document.getElementById('usage-body'),
    usageEmpty: document.getElementById('usage-empty'),
  };

  // ── Events ────────────────────────────────────────────────────────────────

  document.getElementById('add-account').addEventListener('click', () => post('addAccount'));
  document.getElementById('add-account-empty').addEventListener('click', () => post('addAccount'));
  document.getElementById('refresh-all').addEventListener('click', () => post('refreshAll'));
  document.getElementById('clear-history').addEventListener('click', () => post('clearHistory'));
  document.getElementById('open-logs').addEventListener('click', () => post('openLogs'));

  document.querySelectorAll('.tab').forEach((tab) => {
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
    const card = event.target.closest('.account');
    if (!card) {
      return;
    }
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    // Some hosts refuse to start a drag with an empty payload.
    event.dataTransfer.setData('text/plain', card.dataset.accountId);
  });

  el.accounts.addEventListener('dragover', (event) => {
    const dragged = el.accounts.querySelector('.account.dragging');
    if (!dragged) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const over = event.target.closest('.account');
    if (!over || over === dragged) {
      return;
    }
    const box = over.getBoundingClientRect();
    const below = event.clientY > box.top + box.height / 2;
    el.accounts.insertBefore(dragged, below ? over.nextSibling : over);
  });

  el.accounts.addEventListener('drop', (event) => {
    if (el.accounts.querySelector('.account.dragging')) {
      event.preventDefault();
    }
  });

  el.accounts.addEventListener('dragend', () => {
    const dragged = el.accounts.querySelector('.account.dragging');
    if (!dragged) {
      return;
    }
    dragged.classList.remove('dragging');

    const ids = [...el.accounts.querySelectorAll('.account')].map((card) => card.dataset.accountId);
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
  }

  function renderIntegrations() {
    const status = state.status;
    if (!status) {
      el.integrations.innerHTML = '';
      return;
    }

    // The gateway only matters to tools outside VS Code, so its row says what
    // it is for rather than assuming the reader knows. The URL goes on its own
    // line: appended to the name it was the thing that pushed every other row
    // in this list out of shape.
    const running = status.gateway.running;
    const gateway = integrationRow({
      dot: running ? 'on' : 'off',
      name: 'Gateway',
      note: running ? status.gateway.url || '' : 'not running',
      status: running ? 'running' : 'stopped',
      tone: running ? 'on' : 'off',
      title: 'Local endpoint for tools outside VS Code',
      actions:
        '<button class="btn" data-gateway-action="copyGatewayInfo" title="Copy the base URL and key for a terminal CLI or another tool">Copy URL + key</button>' +
        '<button class="btn subtle" data-gateway-action="restartGateway" title="Restart the local server if the port changed or requests stopped going through">Restart</button>',
    });

    const rows = status.integrations.map(function (item) {
      const target = escapeAttribute(item.target);
      const restorable = item.restorable !== false;
      return integrationRow({
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
          '<button class="btn" data-agent="' + target + '" data-agent-action="applyAgent">' +
          escapeHtml(item.applyLabel || 'Use model') +
          '</button>' +
          (item.active && restorable
            ? '<button class="btn subtle" data-agent="' + target + '" data-agent-action="restoreAgent">Restore</button>'
            : ''),
      });
    });

    el.integrations.innerHTML = gateway + rows.join('');
  }

  /**
   * One row of the integrations list, as four independent cells. Below 560px
   * the stylesheet moves the buttons onto their own line; written as a single
   * flex line, the name and the status had nothing left to shrink into.
   */
  function integrationRow(row) {
    return (
      '<div class="integration-row" title="' + escapeAttribute(row.title || '') + '">' +
      '<span class="dot ' + row.dot + '"></span>' +
      '<div class="integration-copy">' +
      '<span class="integration-name">' + escapeHtml(row.name) + '</span>' +
      (row.note ? '<span class="integration-note">' + escapeHtml(row.note) + '</span>' : '') +
      '</div>' +
      '<span class="integration-status ' + row.tone + '">' + escapeHtml(row.status) + '</span>' +
      '<div class="integration-actions">' + row.actions + '</div>' +
      '</div>'
    );
  }

  function renderAccounts() {
    el.empty.classList.toggle('hidden', state.accounts.length > 0);
    // The cards rise in and the bars grow from zero on the first paint only.
    // Replaying either on every expand, collapse or drop made the whole panel
    // look like it was reloading itself each time a card was touched.
    el.accounts.classList.toggle('first-paint', !barsAnimated);
    el.accounts.innerHTML = state.accounts.map(renderAccount).join('');
    document.getElementById('collapse-all').textContent =
      openAccounts.size > 0 ? 'Collapse all' : 'Expand all';
    paintBars(el.accounts, !barsAnimated);
    barsAnimated = true;
  }

  function renderAccount(account) {
    const badges = [
      account.isActive ? '<span class="badge active">Active</span>' : '',
      account.tier ? `<span class="badge">${escapeHtml(account.tier)}</span>` : '',
      account.needsReauth ? '<span class="badge warn">Sign in again</span>' : '',
    ].join('');

    const updated = account.quotaFetchedAt
      ? `Updated ${formatTime(account.quotaFetchedAt)}`
      : 'Quota not loaded yet';

    const lowestQuota =
      account.lowestQuota !== undefined
        ? `<span class="badge quota-${quotaTone(account.lowestQuota)}">${account.lowestQuota}% min</span>`
        : '';

    const actions = [
      account.isActive
        ? ''
        : `<button class="btn" data-action="setActive" data-account-id="${account.id}">Use</button>`,
      account.needsReauth
        ? `<button class="btn primary" data-action="reauth" data-account-id="${account.id}">Re-auth</button>`
        : `<button class="btn" data-action="refreshAccount" data-account-id="${account.id}">Refresh</button>`,
      `<button class="btn danger" data-action="removeAccount" data-account-id="${account.id}">Remove</button>`,
    ].join('');

    const avatar = account.picture
      ? `<img class="avatar" src="${escapeAttribute(account.picture)}" alt="" />`
      : '<div class="avatar"></div>';

    const open = openAccounts.has(account.id);

    return `
      <article class="account ${account.isActive ? 'active' : ''} ${account.needsReauth ? 'stale' : ''}" draggable="true" data-account-id="${account.id}">
        <div class="account-header ${open ? 'open' : ''}" data-toggle="account" data-account-id="${account.id}" role="button" aria-expanded="${open}" title="${open ? 'Collapse' : 'Expand'} this account">
          <span class="grip" title="Drag to reorder. Rotation falls back down this list">⠿</span>
          <span class="chevron ${open ? 'open' : ''}" aria-hidden="true">›</span>
          ${avatar}
          <div class="identity">
            <div class="email">${escapeHtml(account.email)}</div>
            <div class="meta">${badges}${lowestQuota}<span>${escapeHtml(updated)}</span></div>
          </div>
          <div class="account-actions">${actions}</div>
        </div>
        ${account.lastError ? `<div class="error-note">${escapeHtml(account.lastError)}</div>` : ''}
        ${open ? renderAccountBody(account) : renderCollapsedSummary(account)}
      </article>`;
  }

  /** Collapsed cards keep the headline numbers — one chip per quota pool. */
  function renderCollapsedSummary(account) {
    const pools = account.pools || [];
    if (pools.length === 0) {
      return '';
    }
    const chips = pools.map(
      (pool) =>
        `<span class="group-bucket quota-${quotaTone(pool.model.percentage)}">${escapeHtml(
          pool.model.displayName || pool.model.modelId,
        )}: ${pool.model.percentage}%</span>`,
    );
    return `<div class="groups summary">${chips.join('')}</div>`;
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
        return extra > 0 ? `+${extra} more model${extra === 1 ? '' : 's'} on this quota` : model.modelId;
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
      `<div class="more"><button class="link" data-toggle="models" data-account-id="${account.id}">` +
      `${shown ? 'Hide' : 'Show'} all ${models.length} models</button></div>` +
      (shown ? renderModelGrid(models) : '')
    );
  }

  function renderModelGrid(models, noteFor) {
    if (!models || models.length === 0) {
      return '';
    }
    const cards = models.map((model, index) =>
      renderModel(model, noteFor ? noteFor(model, index) : model.modelId),
    );
    return `<div class="model-grid">${cards.join('')}</div>`;
  }

  function renderModel(model, note) {
    const tone = quotaTone(model.percentage);
    const name = model.displayName || model.modelId;
    return `
      <div class="model" title="${escapeAttribute(model.modelId)}">
        <div class="model-top">
          <span class="model-name">${escapeHtml(name)}</span>
          <span class="model-pct quota-${tone}">${model.percentage}%</span>
        </div>
        <div class="bar"><span class="bar-${tone}" data-width="${model.percentage}"></span></div>
        <div class="model-sub">
          <span>${escapeHtml(note)}</span>
          <span>${model.resetsIn ? 'resets in ' + escapeHtml(model.resetsIn) : ''}</span>
        </div>
      </div>`;
  }

  function renderGroups(groups) {
    if (!groups || groups.length === 0) {
      return '';
    }
    const rows = groups
      .filter((group) => group.buckets.length > 0)
      .map((group) => {
        const chips = group.buckets.map(
          (bucket) =>
            `<span class="group-bucket quota-${quotaTone(bucket.percentage)}">${escapeHtml(
              bucket.displayName,
            )}: ${bucket.percentage}%${bucket.resetsIn ? ' · ' + escapeHtml(bucket.resetsIn) : ''}</span>`,
        );
        const label = group.displayName
          ? `<span class="group-name" title="${escapeAttribute(group.description || '')}">${escapeHtml(group.displayName)}</span>`
          : '';
        return `<div class="group">${label}${chips.join('')}</div>`;
      });
    return `<div class="groups">${rows.join('')}</div>`;
  }

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
          '<span class="trend-name">' + escapeHtml(account.email) + '</span>' +
          sparkline(entry.points, families) +
          '<div class="trend-legend">' +
          families
            .map(
              (family) =>
                '<span class="legend"><i class="dot spark-' + family + '"></i>' +
                escapeHtml(familyLabel(family)) +
                ' <b class="quota-' + quotaTone(latest.byFamily[family]) + '">' +
                latest.byFamily[family] + '%</b></span>',
            )
            .join('') +
          '</div>' +
          '<div class="trend-foot">lowest quota per family · ' +
          escapeHtml(formatSpan(entry.points[0].at, latest.at)) +
          '</div></div>'
        );
      })
      .filter(Boolean);

    el.trends.innerHTML = cards.join('');
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

  /** Inline SVG polylines — no external libraries, and CSP-safe. */
  function sparkline(points, families) {
    const width = 240;
    const height = 38;
    const first = points[0].at;
    const span = Math.max(1, points[points.length - 1].at - first);
    const y = (percentage) => height - (Math.max(0, Math.min(100, percentage)) / 100) * height;

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
      '<svg class="spark" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' +
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

  function renderUsage() {
    renderTrends();
    const rows = state.usage || [];
    el.usageEmpty.classList.toggle('hidden', rows.length > 0);
    // An empty table is a header over nothing. The note below it already says
    // what to do, so the frame goes away until there is something to frame.
    el.usageTable.classList.toggle('hidden', rows.length === 0);
    el.usageBody.innerHTML = rows.map(renderUsageRow).join('');
  }

  /**
   * One usage record. Each cell names the column it belongs to and the heading
   * it sits under, because below 560px the stylesheet folds the table into
   * cards and every number then has to introduce itself.
   */
  function renderUsageRow(row) {
    const account = state.accounts.find((candidate) => candidate.id === row.accountId);

    const text = (column, value) =>
      '<td role="cell" data-col="' + column + '">' + escapeHtml(value) + '</td>';

    const count = (column, label, heading, value) =>
      '<td role="cell" class="num" data-col="' + column + '" data-label="' + label + '"' +
      ' title="' + escapeAttribute(formatNumber(value) + ' ' + heading.toLowerCase()) + '">' +
      escapeHtml(formatCompact(value)) +
      '</td>';

    return (
      '<tr role="row">' +
      text('account', account ? account.email : row.accountId) +
      text('model', row.modelId) +
      // Short labels, because these only appear in the folded card view where
      // four of them share the width of one sidebar. The table keeps the full
      // words in its header row.
      count('requests', 'Req', 'Requests', row.requests) +
      count('input', 'In', 'Input', row.inputTokens) +
      count('thinking', 'Think', 'Thinking', row.thoughtTokens || 0) +
      count('output', 'Out', 'Output', row.outputTokens) +
      '</tr>'
    );
  }

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

  function selectTab(name) {
    document.querySelectorAll('.tab').forEach((tab) => {
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
   * readable at a glance; the exact figure rides along in the cell's tooltip.
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
