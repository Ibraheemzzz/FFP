// Global application state
const state = {
  apiKey: '',
  accountId: '',
  currentUserId: '',
  lastConsumptionPayload: null, // Full original payload { userId, units, requestId }
  lastRequestData: null,
  lastResponseData: null,
  history: {
    offset: 0,
    hasMore: false,
  },
};

// Safe DOM utility helpers to strictly prevent XSS / innerHTML injection
function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function createTextEl(tag, text, className = '') {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

// Retrieve configured API base URL (defaults to /api)
function getBaseUrl() {
  const input = document.getElementById('api-base-url');
  let url = input ? input.value.trim() : '/api';
  return url.replace(/\/+$/, '');
}

// Automatically probe service health on page load
window.addEventListener('DOMContentLoaded', () => {
  checkHealth();
  generateNewRequestId();
});

// Toggle password visibility for the API key input
function toggleApiKeyVisibility() {
  const input = document.getElementById('api-key');
  if (input) {
    input.type = input.type === 'password' ? 'text' : 'password';
  }
}

// Generate a random unique Request ID
function generateNewRequestId() {
  const id = 'req_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);
  const input = document.getElementById('consume-request-id');
  if (input) {
    input.value = id;
  }
  return id;
}

// Mask sensitive security tokens for safe presentation
function maskToken(str) {
  if (!str) return '';
  if (str.length <= 12) return '********';
  return str.substring(0, 9) + '...****************';
}

// Health check probe
async function checkHealth() {
  const badge = document.getElementById('health-badge');
  if (!badge) return;

  try {
    const res = await fetch(getBaseUrl() + '/health/ready');
    const data = await res.json();
    if (data.ready) {
      badge.textContent = '● Connected (Database Ready)';
      badge.className = 'badge ready';
    } else {
      badge.textContent = '○ Database Disconnected';
      badge.className = 'badge disconnected';
    }
  } catch {
    badge.textContent = '✕ Service Unreachable';
    badge.className = 'badge disconnected';
  }
}

// Inspector state recorder
function updateInspector(method, url, headers, body, status, durationMs, responseHeaders, responseBody) {
  state.lastRequestData = { method, url, headers, body };
  state.lastResponseData = { status, durationMs, responseHeaders, responseBody };
  rerenderInspector();
}

// Re-render HTTP protocol inspector views safely
function rerenderInspector() {
  if (!state.lastRequestData || !state.lastResponseData) return;

  const maskCheckbox = document.getElementById('mask-key-toggle');
  const mask = maskCheckbox ? maskCheckbox.checked : true;

  const { method, url, headers, body } = state.lastRequestData;
  const { status, durationMs, responseHeaders, responseBody } = state.lastResponseData;

  // Render request method badge
  const mBadge = document.getElementById('req-method-badge');
  if (mBadge) {
    mBadge.textContent = `${method} ${url}`;
  }

  // Format request headers
  const displayHeaders = { ...headers };
  if (mask && displayHeaders['Authorization']) {
    const parts = displayHeaders['Authorization'].split(' ');
    if (parts.length === 2) {
      displayHeaders['Authorization'] = `${parts[0]} ${maskToken(parts[1])}`;
    }
  }

  let reqText = `${method} ${url} HTTP/1.1\n`;
  for (const [k, v] of Object.entries(displayHeaders)) {
    reqText += `${k}: ${v}\n`;
  }
  if (body) {
    reqText += `\n${JSON.stringify(body, null, 2)}`;
  }
  const reqBlock = document.getElementById('inspector-request');
  if (reqBlock) {
    reqBlock.textContent = reqText;
  }

  // Render response status badge
  const sBadge = document.getElementById('res-status-badge');
  if (sBadge) {
    sBadge.textContent = `HTTP ${status}`;
    sBadge.className = 'status-badge ' + (status < 300 ? 'status-2xx' : (status < 500 ? 'status-4xx' : 'status-5xx'));
  }

  const durationSpan = document.getElementById('res-duration');
  if (durationSpan) {
    durationSpan.textContent = `${durationMs}ms`;
  }

  // Format response body
  let respDisplayBody = responseBody;
  if (mask && respDisplayBody && typeof respDisplayBody === 'object' && respDisplayBody.apiKey) {
    respDisplayBody = { ...respDisplayBody, apiKey: maskToken(respDisplayBody.apiKey) };
  }

  let resText = `HTTP/1.1 ${status}\n`;
  if (responseHeaders) {
    for (const [k, v] of Object.entries(responseHeaders)) {
      resText += `${k}: ${v}\n`;
    }
  }
  resText += `\n${JSON.stringify(respDisplayBody, null, 2)}`;

  const resBlock = document.getElementById('inspector-response');
  if (resBlock) {
    resBlock.textContent = resText;
  }
}

// Generic API fetch wrapper with inspector capture
async function apiFetch(method, path, body = null, requireAuth = true) {
  const apiKeyInput = document.getElementById('api-key');
  const apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';

  const headers = {
    'Content-Type': 'application/json',
  };
  if (requireAuth && apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const tStart = performance.now();
  let res;
  let resData;
  const resHeaders = {};
  const fullUrl = getBaseUrl() + path;

  try {
    res = await fetch(fullUrl, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const duration = Math.round(performance.now() - tStart);
    res.headers.forEach((v, k) => { resHeaders[k] = v; });

    const text = await res.text();
    try {
      resData = text ? JSON.parse(text) : {};
    } catch {
      resData = { rawText: text };
    }

    updateInspector(method, path, headers, body, res.status, duration, resHeaders, resData);
    return { ok: res.ok, status: res.status, data: resData };
  } catch (err) {
    const duration = Math.round(performance.now() - tStart);
    updateInspector(method, path, headers, body, 0, duration, {}, { error: err.message });
    throw err;
  }
}

// 1. Account Operations (Safe DOM updates)
async function createNewAccount() {
  const accName = 'Demo Account ' + Math.random().toString(36).substring(2, 6);
  const res = await apiFetch('POST', '/accounts', { name: accName }, false);
  if (res.ok) {
    state.apiKey = res.data.apiKey;
    state.accountId = res.data.id;
    const keyInput = document.getElementById('api-key');
    if (keyInput) keyInput.value = res.data.apiKey;

    const info = document.getElementById('account-info');
    if (info) {
      clearNode(info);
      info.appendChild(document.createTextNode('✅ Account created: '));
      const boldId = createTextEl('strong', res.data.id);
      info.appendChild(boldId);
      info.appendChild(document.createTextNode(` (Default Plan: ${res.data.planId})`));
    }
  } else {
    alert('Failed to create account: ' + JSON.stringify(res.data));
  }
}

async function getAccountProfile() {
  const res = await apiFetch('GET', '/account/me');
  if (res.ok) {
    const info = document.getElementById('account-info');
    if (info) {
      clearNode(info);
      info.appendChild(document.createTextNode('👤 Account: '));
      info.appendChild(createTextEl('strong', res.data.name));
      info.appendChild(document.createTextNode(` (${res.data.id}) | Plan: `));
      info.appendChild(createTextEl('strong', res.data.planId));
    }
  } else {
    alert('Failed to retrieve profile: ' + JSON.stringify(res.data));
  }
}

// 2. Plan Operations (Safe DOM table & details generation)
async function listPlans() {
  const res = await apiFetch('GET', '/plans');
  if (res.ok) {
    const summary = document.getElementById('usage-summary');
    if (!summary) return;
    clearNode(summary);

    const container = createTextEl('div', '', 'table-container');
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['ID', 'Name', 'Type', 'Monthly Limit', 'Per-Request Cap'].forEach((h) => {
      headRow.appendChild(createTextEl('th', h));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const p of res.data) {
      const row = document.createElement('tr');

      const tdId = document.createElement('td');
      tdId.appendChild(createTextEl('code', p.id));
      row.appendChild(tdId);

      row.appendChild(createTextEl('td', p.name));

      const tdType = document.createElement('td');
      tdType.appendChild(createTextEl('span', p.type, 'badge'));
      row.appendChild(tdType);

      row.appendChild(createTextEl('td', p.monthlyLimit.toLocaleString()));
      row.appendChild(createTextEl('td', p.perRequestLimit.toLocaleString()));

      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    container.appendChild(table);
    summary.appendChild(container);
  }
}

async function getPlanDetails() {
  const planId = document.getElementById('target-plan-id').value.trim();
  if (!planId) return alert('Please enter target Plan ID');

  const res = await apiFetch('GET', `/plans/${encodeURIComponent(planId)}`);
  const resultEl = document.getElementById('plan-inspect-result');
  if (!resultEl) return;
  clearNode(resultEl);

  if (res.ok) {
    const p = res.data;
    const box = createTextEl('div', '', 'result-box accepted');
    box.style.display = 'block';
    box.appendChild(createTextEl('strong', `📋 Plan Details: ${p.name}`));
    box.appendChild(document.createElement('br'));
    box.appendChild(document.createTextNode(`• ID: ${p.id} | Scope: ${p.type}`));
    box.appendChild(document.createElement('br'));
    box.appendChild(document.createTextNode(`• Monthly Limit: ${p.monthlyLimit.toLocaleString()} units`));
    box.appendChild(document.createElement('br'));
    box.appendChild(document.createTextNode(`• Per-Request Cap: ${p.perRequestLimit.toLocaleString()} units`));
    box.appendChild(document.createElement('br'));
    box.appendChild(document.createTextNode(`• Owner Account: ${p.ownerAccountId || 'None (Public System Plan)'}`));
    resultEl.appendChild(box);
  } else {
    const box = createTextEl('div', '', 'result-box rejected');
    box.style.display = 'block';
    box.appendChild(createTextEl('strong', 'Plan Lookup Failed: '));
    box.appendChild(document.createTextNode(res.data.error || JSON.stringify(res.data)));
    resultEl.appendChild(box);
  }
}

async function createCustomPlan() {
  const name = document.getElementById('new-plan-name').value.trim();
  const type = document.getElementById('new-plan-type').value;
  const monthlyLimit = parseInt(document.getElementById('new-plan-monthly').value, 10);
  const perRequestLimit = parseInt(document.getElementById('new-plan-per-req').value, 10);

  const res = await apiFetch('POST', '/plans', { name, type, monthlyLimit, perRequestLimit });
  if (res.ok) {
    const targetInput = document.getElementById('target-plan-id');
    if (targetInput) targetInput.value = res.data.id;

    if (type === 'USER') {
      const userPlanInput = document.getElementById('user-plan-id');
      if (userPlanInput) userPlanInput.value = res.data.id;
    }
    alert(`✅ Custom plan created: ${res.data.id}`);
  } else {
    alert('Failed to create plan: ' + JSON.stringify(res.data));
  }
}

async function updatePlan() {
  const planId = document.getElementById('target-plan-id').value.trim();
  if (!planId) return alert('Please enter target Plan ID');

  const monthly = document.getElementById('edit-plan-monthly').value;
  const body = {};
  if (monthly) body.monthlyLimit = parseInt(monthly, 10);

  const res = await apiFetch('PATCH', `/plans/${encodeURIComponent(planId)}`, body);
  if (res.ok) {
    alert(`✅ Plan ${planId} updated successfully`);
  } else {
    alert('Failed to update plan: ' + JSON.stringify(res.data));
  }
}

async function assignAccountPlan() {
  const planId = document.getElementById('target-plan-id').value.trim();
  if (!planId) return alert('Please enter target Plan ID');

  const res = await apiFetch('PATCH', '/account/plan', { planId });
  if (res.ok) {
    alert(`✅ Plan ${planId} assigned to account`);
  } else {
    alert('Failed to assign account plan: ' + JSON.stringify(res.data));
  }
}

// 3. User Operations
async function createUser() {
  const planIdInput = document.getElementById('user-plan-id');
  const externalIdInput = document.getElementById('user-external-id');

  const planId = planIdInput && planIdInput.value.trim() ? planIdInput.value.trim() : undefined;
  const externalId = externalIdInput && externalIdInput.value.trim() ? externalIdInput.value.trim() : undefined;

  const res = await apiFetch('POST', '/users', { planId, externalId });
  if (res.ok) {
    const generatedUserId = res.data.id;
    state.currentUserId = generatedUserId;

    const consumeUserInput = document.getElementById('consume-user-id');
    if (consumeUserInput) consumeUserInput.value = generatedUserId;

    const reassignUserInput = document.getElementById('reassign-user-id');
    if (reassignUserInput) reassignUserInput.value = generatedUserId;

    const inspectUserInput = document.getElementById('inspect-user-id');
    if (inspectUserInput) inspectUserInput.value = generatedUserId;

    alert(`✅ User created! Generated ID: ${generatedUserId}`);
  } else {
    alert('Failed to create user: ' + JSON.stringify(res.data));
  }
}

async function getUserProfile() {
  const userId = document.getElementById('inspect-user-id').value.trim();
  if (!userId) return alert('Please enter target User ID to inspect');

  const res = await apiFetch('GET', `/users/${encodeURIComponent(userId)}`);
  const resultEl = document.getElementById('user-inspect-result');
  if (!resultEl) return;
  clearNode(resultEl);

  if (res.ok) {
    const u = res.data;
    const box = createTextEl('div', '', 'result-box accepted');
    box.style.display = 'block';
    box.appendChild(createTextEl('strong', `👤 User Profile: ${u.id}`));
    box.appendChild(document.createElement('br'));
    box.appendChild(document.createTextNode(`• Account ID: ${u.accountId}`));
    box.appendChild(document.createElement('br'));
    box.appendChild(document.createTextNode(`• Plan ID: ${u.planId}`));
    box.appendChild(document.createElement('br'));
    box.appendChild(document.createTextNode(`• External Reference ID: ${u.externalId || 'None'}`));
    box.appendChild(document.createElement('br'));
    box.appendChild(document.createTextNode(`• Registered At: ${new Date(u.createdAt).toISOString()}`));
    resultEl.appendChild(box);
  } else {
    const box = createTextEl('div', '', 'result-box rejected');
    box.style.display = 'block';
    box.appendChild(createTextEl('strong', 'User Lookup Failed: '));
    box.appendChild(document.createTextNode(res.data.error || JSON.stringify(res.data)));
    resultEl.appendChild(box);
  }
}

async function updateUserPlan() {
  const userId = document.getElementById('reassign-user-id').value.trim();
  const planId = document.getElementById('reassign-plan-id').value.trim();
  if (!userId || !planId) return alert('Please specify both User ID and new Plan ID');

  const res = await apiFetch('PATCH', `/users/${encodeURIComponent(userId)}/plan`, { planId });
  if (res.ok) {
    alert(`✅ User ${userId} reassigned to plan ${planId}`);
  } else {
    alert('Failed to reassign user plan: ' + JSON.stringify(res.data));
  }
}

// 4. Consumption Operations (Safe DOM rendering of outcomes)
async function sendConsumption() {
  const userId = document.getElementById('consume-user-id').value.trim();
  const units = parseInt(document.getElementById('consume-units').value, 10);
  const requestId = document.getElementById('consume-request-id').value.trim();

  if (!userId) return alert('Please specify User ID (create a user first)');
  if (!requestId) return alert('Please enter Request ID');

  // Save the complete original request parameters for exact replay
  state.lastConsumptionPayload = { userId, units, requestId };

  const res = await apiFetch('POST', '/consumptions', { userId, units, requestId });
  const resultBox = document.getElementById('consumption-result');
  if (resultBox) {
    resultBox.style.display = 'block';
    clearNode(resultBox);

    if (res.ok) {
      const d = res.data;
      if (d.accepted) {
        resultBox.className = 'result-box accepted';
        resultBox.appendChild(createTextEl('strong', '✅ Consumption Accepted:'));
        resultBox.appendChild(document.createElement('br'));
        resultBox.appendChild(document.createTextNode('• Request ID: '));
        resultBox.appendChild(createTextEl('code', d.requestId));
        resultBox.appendChild(document.createElement('br'));
        resultBox.appendChild(document.createTextNode(`• Account Quota: Consumed ${d.account.consumed} / Remaining ${d.account.remaining}`));
        resultBox.appendChild(document.createElement('br'));
        resultBox.appendChild(document.createTextNode(`• User Quota: Consumed ${d.user.consumed} / Remaining ${d.user.remaining}`));
      } else {
        resultBox.className = 'result-box rejected';
        resultBox.appendChild(createTextEl('strong', '❌ Consumption Rejected:'));
        resultBox.appendChild(document.createElement('br'));
        resultBox.appendChild(document.createTextNode('• Request ID: '));
        resultBox.appendChild(createTextEl('code', d.requestId));
        resultBox.appendChild(document.createElement('br'));
        resultBox.appendChild(document.createTextNode('• Scope: '));
        resultBox.appendChild(createTextEl('strong', d.reason.scope));
        resultBox.appendChild(document.createTextNode(' | Rule: '));
        resultBox.appendChild(createTextEl('strong', d.reason.rule));
        resultBox.appendChild(document.createElement('br'));
        resultBox.appendChild(document.createTextNode(`• Account Quota: Consumed ${d.account.consumed} / Remaining ${d.account.remaining}`));
        resultBox.appendChild(document.createElement('br'));
        resultBox.appendChild(document.createTextNode(`• User Quota: Consumed ${d.user.consumed} / Remaining ${d.user.remaining}`));
      }
    } else {
      resultBox.className = 'result-box rejected';
      resultBox.appendChild(createTextEl('strong', 'Request Error: '));
      resultBox.appendChild(document.createTextNode(res.data.error || JSON.stringify(res.data)));
    }
  }
}

// Quick Educational Scenarios
async function runScenario(type) {
  if (!state.currentUserId) {
    alert('Please create a user first (Section 3) or enter an existing User ID.');
    return;
  }

  if (type === 'accept') {
    // 1. Normal Accept: 10 units within allowances
    document.getElementById('consume-units').value = 10;
    generateNewRequestId();
    await sendConsumption();
  } else if (type === 'user_cap') {
    // 2. Reject: User Per-Request Cap Exceeded (Rule 2)
    // Default user perRequestLimit is 500, account is 1000. Requesting 600 passes Rule 1 but fails Rule 2.
    document.getElementById('consume-units').value = 600;
    generateNewRequestId();
    await sendConsumption();
  } else if (type === 'user_allowance') {
    // 3. Reject: User Monthly Allowance Exceeded (Rule 4)
    // Assigns user a plan with 20 monthly limit, requests 25 units.
    const planRes = await apiFetch('POST', '/plans', {
      name: 'Restricted User Plan',
      type: 'USER',
      monthlyLimit: 20,
      perRequestLimit: 500,
    });
    if (planRes.ok) {
      await apiFetch('PATCH', `/users/${encodeURIComponent(state.currentUserId)}/plan`, { planId: planRes.data.id });
      document.getElementById('consume-units').value = 25;
      generateNewRequestId();
      await sendConsumption();
    } else {
      alert('Failed to configure test user plan: ' + JSON.stringify(planRes.data));
    }
  } else if (type === 'account_allowance') {
    // 4. Reject: Account Monthly Allowance Exceeded (Rule 3)
    // Sets up account plan with tight monthly limit (50 units) and generous per-request (500 units).
    // Then requesting 60 units passes per-request limits but exceeds monthly allowance (0 + 60 > 50).
    const planRes = await apiFetch('POST', '/plans', {
      name: 'Restricted Account Plan',
      type: 'ACCOUNT',
      monthlyLimit: 50,
      perRequestLimit: 500,
    });
    if (planRes.ok) {
      await apiFetch('PATCH', '/account/plan', { planId: planRes.data.id });
      document.getElementById('consume-units').value = 60;
      generateNewRequestId();
      await sendConsumption();
    } else {
      alert('Failed to configure test account plan: ' + JSON.stringify(planRes.data));
    }
  } else if (type === 'idempotency') {
    // 5. Idempotency Replay: Restores exact original payload (userId, units, requestId)
    if (!state.lastConsumptionPayload) {
      alert('Send an initial consumption request first before testing replay.');
      return;
    }
    // Restore original parameters explicitly
    document.getElementById('consume-user-id').value = state.lastConsumptionPayload.userId;
    document.getElementById('consume-units').value = state.lastConsumptionPayload.units;
    document.getElementById('consume-request-id').value = state.lastConsumptionPayload.requestId;
    await sendConsumption();
  }
}

// 5. Usage & History Queries (Current & Historical months support)
async function getAccountUsage() {
  const monthInput = document.getElementById('usage-query-month');
  const month = monthInput ? monthInput.value.trim() : '';
  const queryPath = month ? `/account/usage?month=${encodeURIComponent(month)}` : '/account/usage';

  const res = await apiFetch('GET', queryPath);
  if (res.ok) {
    const d = res.data;
    const summary = document.getElementById('usage-summary');
    if (summary) {
      clearNode(summary);
      const box = createTextEl('div', '', 'result-box accepted');
      box.style.display = 'block';

      if (d.isCurrentMonth === false) {
        // Historical closed month: no remaining quota, plan may be null
        box.appendChild(createTextEl('strong', `🏢 Historical Account Usage (${d.yearMonth}) [Closed Month]:`));
        box.appendChild(document.createElement('br'));
        box.appendChild(document.createTextNode(`• Total Consumed: ${d.consumed.toLocaleString()} units`));
        box.appendChild(document.createElement('br'));
        const planText = d.planAtLastRequest
          ? `${d.planAtLastRequest.id} (Monthly Limit: ${d.planAtLastRequest.monthlyLimit.toLocaleString()})`
          : 'None / Null (No plan recorded at last request)';
        box.appendChild(document.createTextNode(`• Plan at Last Request: ${planText}`));
        box.appendChild(document.createElement('br'));
        box.appendChild(document.createTextNode(`• Last Request At: ${d.lastRequestAt ? new Date(d.lastRequestAt).toISOString() : 'No requests logged in month'}`));
        box.appendChild(document.createElement('br'));
        const note = createTextEl('small', 'ℹ️ Note: Remaining quota is not applicable to historical closed months.');
        note.style.color = 'var(--muted)';
        box.appendChild(note);
      } else {
        // Current month: full plan and remaining balance
        box.appendChild(createTextEl('strong', `🏢 Account Usage (${d.yearMonth}) [Current Month]:`));
        box.appendChild(document.createElement('br'));
        box.appendChild(document.createTextNode(`• Total Consumed: ${d.usage.consumed.toLocaleString()}`));
        box.appendChild(document.createElement('br'));
        box.appendChild(document.createTextNode(`• Monthly Plan Limit: ${d.plan.monthlyLimit.toLocaleString()}`));
        box.appendChild(document.createElement('br'));
        box.appendChild(document.createTextNode(`• Remaining Balance: ${d.usage.remaining.toLocaleString()}`));
      }
      summary.appendChild(box);
    }
  } else {
    alert('Failed to retrieve account usage: ' + JSON.stringify(res.data));
  }
}

async function getUserUsage() {
  const userId = document.getElementById('consume-user-id').value.trim();
  if (!userId) return alert('Please enter target User ID');

  const monthInput = document.getElementById('usage-query-month');
  const month = monthInput ? monthInput.value.trim() : '';
  const queryPath = month
    ? `/users/${encodeURIComponent(userId)}/usage?month=${encodeURIComponent(month)}`
    : `/users/${encodeURIComponent(userId)}/usage`;

  const res = await apiFetch('GET', queryPath);
  if (res.ok) {
    const d = res.data;
    const summary = document.getElementById('usage-summary');
    if (summary) {
      clearNode(summary);
      const box = createTextEl('div', '', 'result-box accepted');
      box.style.display = 'block';

      if (d.isCurrentMonth === false) {
        // Historical user usage: userConsumed, accountConsumed, plans might be null, no remaining
        box.appendChild(createTextEl('strong', `👤 Historical User Usage for ${d.userId} (${d.yearMonth}) [Closed Month]:`));
        box.appendChild(document.createElement('br'));
        box.appendChild(document.createTextNode(`• User Consumed: ${d.userConsumed.toLocaleString()} units`));
        box.appendChild(document.createElement('br'));
        const uPlan = d.userPlanAtLastRequest
          ? `${d.userPlanAtLastRequest.id} (Limit: ${d.userPlanAtLastRequest.monthlyLimit.toLocaleString()})`
          : 'None / Null';
        box.appendChild(document.createTextNode(`• User Plan at Last Request: ${uPlan}`));
        box.appendChild(document.createElement('br'));
        box.appendChild(document.createTextNode(`• Shared Account Consumed: ${d.accountConsumed.toLocaleString()} units`));
        box.appendChild(document.createElement('br'));
        const aPlan = d.accountPlanAtLastRequest
          ? `${d.accountPlanAtLastRequest.id} (Limit: ${d.accountPlanAtLastRequest.monthlyLimit.toLocaleString()})`
          : 'None / Null';
        box.appendChild(document.createTextNode(`• Account Plan at Last Request: ${aPlan}`));
        box.appendChild(document.createElement('br'));
        box.appendChild(document.createTextNode(`• Last Request At: ${d.lastRequestAt ? new Date(d.lastRequestAt).toISOString() : 'No requests logged in month'}`));
        box.appendChild(document.createElement('br'));
        const note = createTextEl('small', 'ℹ️ Note: Remaining quota is not applicable to historical closed months.');
        note.style.color = 'var(--muted)';
        box.appendChild(note);
      } else {
        // Current month: user & account usage with remaining balances
        box.appendChild(createTextEl('strong', `👤 User Usage for ${d.userId} (${d.yearMonth}) [Current Month]:`));
        box.appendChild(document.createElement('br'));
        box.appendChild(document.createTextNode(`• User Consumed: ${d.userUsage.consumed.toLocaleString()} / Remaining: ${d.userUsage.remaining.toLocaleString()}`));
        box.appendChild(document.createElement('br'));
        box.appendChild(document.createTextNode(`• User Monthly Plan Limit: ${d.userPlan.monthlyLimit.toLocaleString()}`));
        box.appendChild(document.createElement('br'));
        box.appendChild(document.createTextNode(`• Account Consumed: ${d.accountUsage.consumed.toLocaleString()} / Remaining: ${d.accountUsage.remaining.toLocaleString()}`));
      }
      summary.appendChild(box);
    }
  } else {
    alert('Failed to retrieve user usage: ' + JSON.stringify(res.data));
  }
}

// 6. Request History Filters & Pagination
function resetHistoryOffset() {
  state.history.offset = 0;
}

function getHistoryLimit() {
  const limitEl = document.getElementById('filter-limit');
  return limitEl ? parseInt(limitEl.value, 10) || 10 : 10;
}

async function navigateHistoryPrev() {
  const limit = getHistoryLimit();
  state.history.offset = Math.max(0, state.history.offset - limit);
  await getRequestHistory();
}

async function navigateHistoryNext() {
  if (state.history.hasMore) {
    const limit = getHistoryLimit();
    state.history.offset += limit;
    await getRequestHistory();
  }
}

async function getRequestHistory() {
  const limit = getHistoryLimit();
  const offset = state.history.offset || 0;
  const userId = (document.getElementById('filter-user-id')?.value || '').trim();
  const status = (document.getElementById('filter-status')?.value || '').trim();
  const month = (document.getElementById('filter-month')?.value || '').trim();

  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (userId) params.set('userId', userId);
  if (status) params.set('status', status);
  if (month) params.set('month', month);

  const res = await apiFetch('GET', `/requests?${params.toString()}`);
  if (res.ok) {
    const items = res.data.items || [];
    const pagination = res.data.pagination || { limit, offset, hasMore: false };
    state.history.hasMore = pagination.hasMore;

    // Update pagination button states
    const prevBtn = document.getElementById('history-prev-btn');
    if (prevBtn) prevBtn.disabled = offset === 0;

    const nextBtn = document.getElementById('history-next-btn');
    if (nextBtn) nextBtn.disabled = !pagination.hasMore;

    const pageInfo = document.getElementById('history-page-info');
    if (pageInfo) {
      pageInfo.textContent = `Offset: ${offset} | Showing ${items.length} items (hasMore: ${pagination.hasMore})`;
    }

    // Render table
    const container = document.getElementById('history-table-container');
    if (container) {
      clearNode(container);
      if (items.length === 0) {
        const emptyBox = createTextEl('div', 'No requests found matching the specified filters.', 'result-box');
        emptyBox.style.display = 'block';
        emptyBox.style.color = 'var(--muted)';
        container.appendChild(emptyBox);
        return;
      }

      const tableWrap = createTextEl('div', '', 'table-container');
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      ['Request ID', 'User ID', 'Units', 'Status', 'Rejection Rule', 'Processed At'].forEach((h) => {
        headRow.appendChild(createTextEl('th', h));
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const r of items) {
        const row = document.createElement('tr');
        const isAcc = r.status === 'ACCEPTED';

        const tdReq = document.createElement('td');
        tdReq.appendChild(createTextEl('code', r.requestId));
        row.appendChild(tdReq);

        const tdUser = document.createElement('td');
        tdUser.appendChild(createTextEl('code', r.userId));
        row.appendChild(tdUser);

        row.appendChild(createTextEl('td', String(r.requestedUnits)));

        const tdStatus = document.createElement('td');
        tdStatus.appendChild(createTextEl('span', r.status, `status-badge ${isAcc ? 'status-2xx' : 'status-5xx'}`));
        row.appendChild(tdStatus);

        const rejText = r.rejectionReason ? `${r.rejectionReason.scope} / ${r.rejectionReason.rule}` : '-';
        row.appendChild(createTextEl('td', rejText));

        const tdDate = createTextEl('td', new Date(r.processedAt).toISOString());
        tdDate.style.fontSize = '0.75rem';
        tdDate.style.color = 'var(--muted)';
        row.appendChild(tdDate);

        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      container.appendChild(tableWrap);
    }
  } else {
    alert('Failed to retrieve request history: ' + JSON.stringify(res.data));
  }
}
