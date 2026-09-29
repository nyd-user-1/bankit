// Claude on Bedrock, shared by the routes that talk to a model (the interview, the builder).
// Credentials come from the default chain: the Lambda's IAM role in prod, ~/.aws or .env.local locally.
const { AnthropicBedrock } = require('@anthropic-ai/bedrock-sdk');

const MODELS = {
  fast:  'us.anthropic.claude-haiku-4-5-20251001-v1:0',                       // the interview
  build: process.env.BANKIT_BUILDER_MODEL || 'us.anthropic.claude-opus-4-5-20251101-v1:0',  // writing a game
};
let client;
const ai = () => (client ||= new AnthropicBedrock({ awsRegion: process.env.AWS_REGION || 'us-east-1' }));

// one call → { text, usage:{ input, output } }
async function ask({ model, system, messages, max_tokens = 2000, timeout = 60000 }) {
  const r = await ai().messages.create({ model, max_tokens, system, messages }, { timeout });
  const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return { text, usage: { input: (r.usage && r.usage.input_tokens) || 0, output: (r.usage && r.usage.output_tokens) || 0 }, stop: r.stop_reason };
}

// Bedrock has no structured-output mode: strip fences, take the outermost object, parse leniently
function json(text) {
  const t = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  try { return JSON.parse(s >= 0 && e > s ? t.slice(s, e + 1) : t); } catch (err) { return null; }
}

module.exports = { ai, MODELS, ask, json };
