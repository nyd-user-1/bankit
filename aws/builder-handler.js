// Lambda entry for the builder (bankit-builder): invoked asynchronously by api/requests.js with { id }.
// Long timeout (15 min): one build is one model call of several minutes, plus one retry.
const { build } = require('./api/_builder.js');

exports.handler = async (event) => {
  const id = Number(event && (event.id || (event.body && JSON.parse(event.body).id)));
  if (!id) return { ok: false, error: 'no id' };
  const out = await build(id);
  return { ok: true, id, ...out };
};
