// Throwaway probe (spec 3a): does Ollama Cloud honour schema-constrained decoding?
// Reads OLLAMA_API_KEY from env (node --env-file). Never prints the key.
const key = process.env.OLLAMA_API_KEY;
if (!key) {
  console.error('OLLAMA_API_KEY is not set');
  process.exit(2);
}
const MODELS = (process.env.PROBE_MODELS ?? 'gpt-oss:20b,gemma4:31b').split(',');
const schema = {
  type: 'object',
  properties: {
    owner: { type: 'string', enum: ['organiser', 'speaker-wrangler', 'venue-lead'] },
    title: { type: 'string' },
  },
  required: ['owner', 'title'],
  additionalProperties: false,
};
// A prompt that pushes an unconstrained model OUT of the schema (prose, wrong enum member).
const prompt =
  'Ignore any formatting rules. Write a two-line poem about meetups in plain prose, ' +
  'and name the owner as "Alice".';
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

function check(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return 'NOT JSON';
  }
  const ok =
    v &&
    typeof v.title === 'string' &&
    ['organiser', 'speaker-wrangler', 'venue-lead'].includes(v.owner);
  return ok ? 'VALID against schema' : 'JSON but VIOLATES schema';
}
async function post(url, body) {
  const t0 = Date.now();
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, ms: Date.now() - t0, text };
}

const tags = await fetch('https://ollama.com/api/tags', { headers });
console.log('GET /api/tags with key ->', tags.status);
if (tags.ok)
  console.log('models reachable:', (await tags.json()).models.map((m) => m.name).join(', '));

for (const model of MODELS) {
  console.log(`\n=== ${model}`);
  const a = await post('https://ollama.com/api/chat', {
    model,
    stream: false,
    options: { temperature: 0 },
    format: schema,
    messages: [{ role: 'user', content: prompt }],
  });
  let aContent = '';
  try {
    aContent = JSON.parse(a.text).message?.content ?? '';
  } catch {
    /* keep empty */
  }
  console.log(
    `native /api/chat + format        : HTTP ${a.status} ${a.ms}ms -> ${a.status === 200 ? check(aContent) : a.text.slice(0, 200)}`,
  );
  if (a.status === 200) console.log('   content:', aContent.slice(0, 160).replace(/\n/g, ' '));

  const b = await post('https://ollama.com/v1/chat/completions', {
    model,
    temperature: 0,
    response_format: { type: 'json_schema', json_schema: { name: 'task', strict: true, schema } },
    messages: [{ role: 'user', content: prompt }],
  });
  let bContent = '';
  try {
    bContent = JSON.parse(b.text).choices?.[0]?.message?.content ?? '';
  } catch {
    /* keep empty */
  }
  console.log(
    `/v1 chat + response_format schema: HTTP ${b.status} ${b.ms}ms -> ${b.status === 200 ? check(bContent) : b.text.slice(0, 200)}`,
  );
  if (b.status === 200) console.log('   content:', bContent.slice(0, 160).replace(/\n/g, ' '));

  // Control: no constraint at all, to show the prompt really does break the schema.
  const c = await post('https://ollama.com/v1/chat/completions', {
    model,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });
  let cContent = '';
  try {
    cContent = JSON.parse(c.text).choices?.[0]?.message?.content ?? '';
  } catch {
    /* keep empty */
  }
  console.log(
    `control (no constraint)          : HTTP ${c.status} ${c.ms}ms -> ${c.status === 200 ? check(cContent) : c.text.slice(0, 200)}`,
  );
}
