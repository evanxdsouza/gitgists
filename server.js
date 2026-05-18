import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static('public'));

// ── GitHub helpers ────────────────────────────────────────────────────────────

function githubHeaders() {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'GitGists/1.0',
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function searchGitHub(query) {
  const encoded = encodeURIComponent(query + ' in:file');
  const url = `https://api.github.com/search/code?q=${encoded}&sort=indexed&per_page=5`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub rate limit exceeded. Add a GITHUB_TOKEN to .env to increase limits, or wait a minute.');
  }
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

async function fetchRawContent(item) {
  // https://github.com/owner/repo/blob/branch/path → https://raw.githubusercontent.com/owner/repo/branch/path
  const rawUrl = item.html_url
    .replace('https://github.com/', 'https://raw.githubusercontent.com/')
    .replace('/blob/', '/');

  const res = await fetch(rawUrl, { headers: githubHeaders() });
  if (!res.ok) return null;

  const text = await res.text();
  return text
    .split('\n')
    .slice(0, 100)
    .map(line => (line.length > 200 ? line.slice(0, 200) + '…' : line))
    .join('\n');
}

// ── Claude helpers ────────────────────────────────────────────────────────────

const SEARCH_SYSTEM_PROMPT = `You are a code assistant helping developers find real-world examples on GitHub and integrate them into their projects.
You will receive a user's query and raw GitHub code files. From these:
1. Extract the most relevant code snippet (well-commented, idiomatic)
2. Explain what it does in 2-3 sentences
3. Provide step-by-step integration instructions
4. List required dependencies/packages
5. Note any gotchas or common mistakes

Format your response in Markdown with fenced code blocks. Always include the language identifier on code fences.`;

function buildGitHubContext(query, results) {
  const fileBlocks = results
    .map((r, i) => `### File ${i + 1}: ${r.filename} (${r.repoName})\nURL: ${r.htmlUrl}\n\`\`\`\n${r.content}\n\`\`\``)
    .join('\n\n');
  return `User query: "${query}"\n\nHere are ${results.length} real GitHub files found for this query:\n\n${fileBlocks}`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: 'Query is required' });

  try {
    const items = await searchGitHub(query.trim());

    const results = await Promise.all(
      items.map(async item => ({
        filename: item.name,
        repoName: item.repository.full_name,
        htmlUrl: item.html_url,
        content: await fetchRawContent(item),
      }))
    );

    const validResults = results.filter(r => r.content !== null);

    if (validResults.length === 0) {
      return res.json({
        answer: 'No readable code examples found on GitHub for this query. Try a more specific search term.',
        sources: [],
        searchContext: null,
      });
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: SEARCH_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        { role: 'user', content: buildGitHubContext(query.trim(), validResults) },
      ],
    });

    const answer = response.content.find(b => b.type === 'text')?.text ?? '';

    res.json({
      answer,
      sources: validResults.map(r => ({ filename: r.filename, repoName: r.repoName, url: r.htmlUrl })),
      searchContext: {
        query: query.trim(),
        answer,
        githubSummary: validResults.map(r => `${r.filename} (${r.repoName})`).join(', '),
      },
    });
  } catch (err) {
    console.error('/api/search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message, history, searchContext } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

  const systemPrompt = searchContext
    ? `You are a code assistant. The user previously searched for: "${searchContext.query}"
You found and analyzed these GitHub files: ${searchContext.githubSummary}
Your previous analysis was:
${searchContext.answer}

Continue helping the user with follow-up questions about this code. Be concise and specific.`
    : 'You are a helpful code assistant. Answer questions about code and programming.';

  try {
    const messages = [
      ...(history || []),
      { role: 'user', content: message.trim() },
    ];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages,
    });

    const reply = response.content.find(b => b.type === 'text')?.text ?? '';
    res.json({ reply });
  } catch (err) {
    console.error('/api/chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`GitGists running on http://localhost:${PORT}`));
