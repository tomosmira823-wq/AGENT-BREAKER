// When a model name is rejected, fetch the provider's model list so the error
// says what would have worked instead of just "404".
export function isModelNotFound(e) {
  return /HTTP 404|not_found|NOT_FOUND|does not exist|is not found|model_not_found/i.test(String(e?.message || e));
}

export async function withModelHint(e, listModels, model) {
  if (!isModelNotFound(e)) throw e;
  let names = [];
  try { names = (await listModels()).slice(0, 25); } catch {}
  const hint = names.length
    ? `Model "${model}" was not found. This key can use: ${names.join(', ')}. Change the model in models.json.`
    : `Model "${model}" was not found (it may be retired). Change the model in models.json.`;
  const err = new Error(`${hint} Original: ${String(e.message).slice(0, 200)}`);
  err.cause = e;
  throw err;
}
