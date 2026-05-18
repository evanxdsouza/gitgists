// ── State ────────────────────────────────────────────────────────────────────
let conversationHistory = [];
let searchContext = null;

// ── Markdown / highlight setup ────────────────────────────────────────────────
marked.setOptions({
  breaks: true,
  gfm: true,
});

function renderMarkdown(text) {
  const html = marked.parse(text);
  return DOMPurify.sanitize(html);
}

function highlightAll(container) {
  container.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showLoading() {
  document.getElementById('loading-section').classList.remove('hidden');
  document.getElementById('results-section').classList.add('hidden');
  document.getElementById('chat-section').classList.add('hidden');
  document.getElementById('search-btn').disabled = true;
}

function hideLoading() {
  document.getElementById('loading-section').classList.add('hidden');
  document.getElementById('search-btn').disabled = false;
}

function showResults() {
  document.getElementById('results-section').classList.remove('hidden');
  document.getElementById('chat-section').classList.remove('hidden');
}

function renderSources(sources) {
  const container = document.getElementById('source-chips');
  if (!sources.length) {
    container.innerHTML = '<span style="color:var(--text-muted);font-size:0.85rem">No sources</span>';
    return;
  }
  container.innerHTML = sources
    .map(s => `<a class="source-chip" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.filename)} · ${escapeHtml(s.repoName)}</a>`)
    .join('');
}

// ── Search ────────────────────────────────────────────────────────────────────
async function doSearch() {
  const input = document.getElementById('query-input');
  const query = input.value.trim();
  if (!query) return;

  showLoading();
  conversationHistory = [];
  document.getElementById('chat-messages').innerHTML = '';

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Search failed');

    renderSources(data.sources || []);

    const answerEl = document.getElementById('answer-content');
    answerEl.innerHTML = renderMarkdown(data.answer);
    highlightAll(answerEl);

    searchContext = data.searchContext || null;

    // Seed history with the first exchange so chat has context
    if (searchContext) {
      conversationHistory.push({ role: 'user', content: `Search query: ${query}` });
      conversationHistory.push({ role: 'assistant', content: data.answer });
    }

    hideLoading();
    showResults();
  } catch (err) {
    document.getElementById('source-chips').innerHTML = '';
    document.getElementById('answer-content').innerHTML =
      `<p class="error-msg">${escapeHtml(err.message)}</p>`;
    hideLoading();
    showResults();
  }
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function appendChatMessage(role, content) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  if (role === 'assistant') {
    div.innerHTML = renderMarkdown(content);
    highlightAll(div);
  } else {
    div.textContent = content;
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  input.disabled = true;
  document.getElementById('chat-send-btn').disabled = true;

  appendChatMessage('user', message);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: conversationHistory, searchContext }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Chat failed');

    appendChatMessage('assistant', data.reply);

    conversationHistory.push({ role: 'user', content: message });
    conversationHistory.push({ role: 'assistant', content: data.reply });
  } catch (err) {
    appendChatMessage('assistant', `Error: ${err.message}`);
  } finally {
    input.disabled = false;
    document.getElementById('chat-send-btn').disabled = false;
    input.focus();
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.getElementById('search-btn').addEventListener('click', doSearch);
document.getElementById('query-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
});

document.getElementById('chat-send-btn').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
});
