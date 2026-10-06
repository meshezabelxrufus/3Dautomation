/**
 * Image generation logic (Nano Banana / Gemini, or the free Pollinations API for testing) shared by the n8n workflows
 * "[3D Studio] M1 · Concept image — generate" and "[3D Studio] M1 · Concept — refine"
 * (inlined into Code nodes by scripts/n8n-deploy.mjs) and the app's unit tests.
 *
 * Plain JavaScript, no imports. The provider returns image bytes (base64), never an
 * expiring URL; the workflow uploads them to the app's own asset storage.
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";
const IMAGE_MAX_ATTEMPTS = 3;
const IMAGE_RETRYABLE_STATUS = [408, 425, 429, 500, 502, 503, 504];

/**
 * Pollinations (https://pollinations.ai): an alternative image provider for testing the flow without a
 * paid Gemini key. Uses its authenticated OpenAI-compatible API (key from enter.pollinations.ai, sent by
 * the n8n credential "3D Studio — Pollinations"): generations for concepts, edits (with the current image)
 * for refinements. Default model: FLUX.2 klein, which supports both.
 */
const POLLINATIONS_API = "https://gen.pollinations.ai/v1/images";
const DEFAULT_POLLINATIONS_MODEL = "black-forest-labs/flux.2-klein-4b";
const POLLINATIONS_PROMPT_MAX = 8000;
const BLOCK_REASONS = ["SAFETY", "PROHIBITED_CONTENT", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "OTHER_BLOCK"];

/** Fixed framing appended to every concept prompt so all renders read as one consistent set. */
const RENDER_SUFFIX =
  " Square 1:1 product concept render. Single object only, centred, entire object visible, plain neutral seamless studio background, soft even studio lighting. No text, letters, logos, watermarks, people or hands.";

function buildImageRequest({ model, prompt, aspectRatio, imageSize, referenceImage }) {
  const parts = [{ text: String(prompt || "") }];
  if (referenceImage && referenceImage.data) {
    parts.push({ inline_data: { mime_type: referenceImage.mimeType || "image/png", data: referenceImage.data } });
  }
  return {
    url: `${GEMINI_BASE}/models/${encodeURIComponent(model || DEFAULT_IMAGE_MODEL)}:generateContent`,
    body: {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: aspectRatio || "1:1", ...(imageSize ? { imageSize } : {}) },
      },
    },
  };
}

function buildPollinationsRequest({ model, prompt, referenceImage }) {
  const body = {
    prompt: String(prompt || "").trim().slice(0, POLLINATIONS_PROMPT_MAX),
    model: model || DEFAULT_POLLINATIONS_MODEL,
    size: "1024x1024",
    response_format: "b64_json",
  };
  if (referenceImage && referenceImage.data) {
    body.image = `data:${referenceImage.mimeType || "image/png"};base64,${referenceImage.data}`;
    return { url: `${POLLINATIONS_API}/edits`, body };
  }
  return { url: `${POLLINATIONS_API}/generations`, body };
}

/** The request for the state's provider. With a reference image, both providers edit that image. */
function buildProviderRequest(state, referenceImage) {
  if (state.provider === "pollinations") return buildPollinationsRequest({ model: state.model, prompt: state.prompt, referenceImage });
  return buildImageRequest({ model: state.model, prompt: state.prompt, aspectRatio: "1:1", referenceImage });
}

const sniffMime = (b64) =>
  /^\/9j\//.test(b64) ? "image/jpeg" : /^iVBOR/.test(b64) ? "image/png" : /^UklGR/.test(b64) ? "image/webp" : "image/jpeg";

/**
 * Maps a Pollinations (OpenAI images) response onto the generateContent shape so one evaluator
 * handles both providers. Errors keep their status; a 402 (balance used up) is its own failure.
 */
function pollinationsToResult(result, state) {
  if (!result || result.transportError || !result.statusCode) return result;
  const body = result.body || {};
  const status = Number(result.statusCode);
  if (status !== 200) {
    const err = body.error || {};
    return { statusCode: status, body: { error: { message: err.message || body.message || "", code: err.code } } };
  }
  const item = Array.isArray(body.data) ? body.data[0] : null;
  if (!item || !item.b64_json) return { statusCode: 200, body: { candidates: [] } };
  return {
    statusCode: 200,
    body: {
      responseId: `pollinations-${body.created || Date.now()}-${state ? state.concept_number : 0}`,
      modelVersion: state ? state.model : DEFAULT_POLLINATIONS_MODEL,
      candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: sniffMime(item.b64_json), data: item.b64_json } }] } }],
    },
  };
}

function buildImageState(input) {
  const config = input.config || {};
  const provider = config.image_provider === "pollinations" ? "pollinations" : "gemini";
  return {
    concept_id: input.conceptId || null,
    revision_id: input.revisionId || null,
    view_id: input.viewId || null,
    project_id: input.projectId,
    concept_number: input.conceptNumber || 0,
    attempt: 1,
    max_attempts: IMAGE_MAX_ATTEMPTS,
    provider_mode: config.provider_mode === "mock" ? "mock" : "live",
    provider,
    mock_scenario: config.mock_scenario || "ok",
    model: provider === "pollinations" ? config.pollinations_model || DEFAULT_POLLINATIONS_MODEL : config.image_model || DEFAULT_IMAGE_MODEL,
    prompt: String(input.prompt || "").trim() + (input.skipSuffix ? "" : RENDER_SUFFIX),
    has_reference: Boolean(input.referenceImage),
    is_retry: Boolean(input.isRetry),
    history: [],
    started_at: Date.now(),
  };
}

/** Finds the generated image in a generateContent response (or an Interactions response). */
function extractImage(body) {
  const b = body || {};
  for (const cand of Array.isArray(b.candidates) ? b.candidates : []) {
    for (const part of (cand.content && cand.content.parts) || []) {
      const inline = part.inlineData || part.inline_data;
      if (inline && inline.data && /^image\//.test(inline.mimeType || inline.mime_type || "")) {
        return { mimeType: inline.mimeType || inline.mime_type, data: inline.data };
      }
    }
  }
  for (const step of Array.isArray(b.steps) ? b.steps : []) {
    for (const item of Array.isArray(step.content) ? step.content : []) {
      if (item && item.type === "image" && item.data) return { mimeType: item.mime_type || "image/png", data: item.data };
    }
  }
  return null;
}

function blockReason(body) {
  const b = body || {};
  if (b.promptFeedback && b.promptFeedback.blockReason) return b.promptFeedback.blockReason;
  for (const cand of Array.isArray(b.candidates) ? b.candidates : []) {
    if (cand.finishReason && BLOCK_REASONS.includes(cand.finishReason)) return cand.finishReason;
  }
  return null;
}

const IMAGE_FAILURES = {
  image_unavailable: "The image service is temporarily unavailable. You can retry this image.",
  image_auth: "The image service rejected the studio's credentials. An administrator needs to check the image API key.",
  image_quota: "The image service's balance is used up. An administrator needs to top it up, then you can retry this image.",
  image_model_unavailable: "The configured image model is not available. An administrator needs to check the image model setting.",
  image_request_rejected: "The image service rejected the request. You can retry this image.",
  image_blocked: "The image service declined to draw this concept. Try refining the concept, then retry.",
  image_empty: "The image service didn't return an image. You can retry this image.",
  image_storage: "The generated image could not be stored. You can retry this image.",
};

function imageFail(state, code, detail) {
  return {
    action: "fail",
    concept_id: state.concept_id,
    revision_id: state.revision_id,
    view_id: state.view_id || null,
    project_id: state.project_id,
    failure: { code, reason: IMAGE_FAILURES[code] || IMAGE_FAILURES.image_empty, detail: String(detail || "").slice(0, 500) },
    meta: { attempts: state.attempt, model: state.model, provider: providerLabel(state), providerMode: state.provider_mode, durationMs: Date.now() - state.started_at, history: state.history },
  };
}

const providerLabel = (st) => (st.provider_mode === "mock" ? "mock" : st.provider === "pollinations" ? "pollinations" : "google-gemini");

function backoffSeconds(st) {
  if (st.provider_mode === "mock") return 1;
  return Math.min(30, 2 ** st.attempt * 2);
}

/** result: { statusCode, body } | { transportError } (raw provider response; Pollinations is normalised here) */
function evaluateImageAttempt(state, rawResult) {
  const st = { ...state, history: [...(state.history || [])] };
  const result = st.provider === "pollinations" && st.provider_mode !== "mock" ? pollinationsToResult(rawResult, st) : rawResult;
  const canRetry = st.attempt < st.max_attempts;
  const backoff = backoffSeconds(st);
  const retry = (reason) => ({ action: "retry", reason, delay_seconds: backoff, state: { ...st, attempt: st.attempt + 1 } });

  if (result.transportError || !result.statusCode) {
    st.history.push({ attempt: st.attempt, outcome: "transport_error", detail: String(result.transportError || "").slice(0, 200) });
    return canRetry ? retry("transport") : imageFail(st, "image_unavailable", result.transportError);
  }
  const status = Number(result.statusCode);
  if (status !== 200) {
    const msg = result.body && result.body.error ? result.body.error.message : "";
    st.history.push({ attempt: st.attempt, outcome: "http_error", status });
    if (IMAGE_RETRYABLE_STATUS.includes(status)) return canRetry ? retry("http") : imageFail(st, "image_unavailable", `HTTP ${status}: ${msg}`);
    if (status === 401 || status === 403) return imageFail(st, "image_auth", `HTTP ${status}: ${msg}`);
    if (status === 402) return imageFail(st, "image_quota", `HTTP 402: ${msg}`);
    if (status === 404) return imageFail(st, "image_model_unavailable", `HTTP 404: ${msg}`);
    return imageFail(st, "image_request_rejected", `HTTP ${status}: ${msg}`);
  }
  const blocked = blockReason(result.body);
  if (blocked) {
    st.history.push({ attempt: st.attempt, outcome: "blocked", reason: blocked });
    return imageFail(st, "image_blocked", `blocked: ${blocked}`);
  }
  const image = extractImage(result.body);
  if (!image || String(image.data).length < 200) {
    st.history.push({ attempt: st.attempt, outcome: "no_image" });
    return canRetry ? retry("no_image") : imageFail(st, "image_empty", "response contained no image");
  }
  st.history.push({ attempt: st.attempt, outcome: "image" });
  const body = result.body || {};
  return {
    action: "save",
    concept_id: st.concept_id,
    revision_id: st.revision_id,
    view_id: st.view_id || null,
    project_id: st.project_id,
    image: { mime_type: image.mimeType, data_base64: image.data },
    provider_request_id: body.responseId || body.id || null,
    model: body.modelVersion || st.model,
    prompt: st.prompt,
    meta: {
      attempts: st.attempt,
      model: body.modelVersion || st.model,
      provider: providerLabel(st),
      providerMode: st.provider_mode,
      durationMs: Date.now() - st.started_at,
      usage: body.usageMetadata || null,
    },
  };
}

// ---------------------------------------------------------------- mock provider

const MOCK_PNGS = ["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"];

function mockImageBody(state) {
  const png = MOCK_PNGS[(Math.max(1, state.concept_number) - 1) % MOCK_PNGS.length];
  return {
    statusCode: 200,
    body: {
      responseId: `mock-${state.concept_id || state.revision_id || state.view_id}-${state.attempt}`,
      modelVersion: "mock-nano-banana",
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Here is the render." }, { inlineData: { mimeType: "image/png", data: png } }] } }],
      usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 1290 },
    },
  };
}

/**
 * Scenarios: ok | slow | fail:<n> (concept n fails; a manual retry succeeds) | fail_always:<n> |
 * blocked | timeout | api_error_then_ok |
 * no_image_then_ok | api_down | auth_error | model_not_found
 */
function mockImage(state) {
  const sc = String(state.mock_scenario || "ok");
  const failMatch = sc.match(/^fail(_always)?:(\d+)$/);
  if (failMatch && Number(failMatch[2]) === state.concept_number && (failMatch[1] || !state.is_retry)) {
    return { statusCode: 503, body: { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } } };
  }
  switch (sc) {
    case "blocked":
      return { statusCode: 200, body: { promptFeedback: { blockReason: "SAFETY" }, candidates: [] } };
    case "api_error_then_ok":
      return state.attempt === 1 ? { statusCode: 429, body: { error: { code: 429, message: "Resource exhausted" } } } : mockImageBody(state);
    case "no_image_then_ok":
      return state.attempt === 1
        ? { statusCode: 200, body: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "I can describe it instead." }] } }] } }
        : mockImageBody(state);
    case "api_down":
      return { statusCode: 503, body: { error: { code: 503, message: "Service unavailable" } } };
    case "timeout": // the HTTP node gave up waiting (same shape as its error output)
      return { transportError: "timeout of 120000ms exceeded" };
    case "auth_error":
      return { statusCode: 403, body: { error: { code: 403, message: "API key not valid" } } };
    case "model_not_found":
      return { statusCode: 404, body: { error: { code: 404, message: "models/x is not found" } } };
    default:
      return mockImageBody(state);
  }
}

/** Delay the mock should apply (seconds) to simulate slow generation. */
function mockDelaySeconds(state) {
  return String(state.mock_scenario) === "slow" ? 12 : 0;
}

const imageGeneration = {
  GEMINI_BASE,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_POLLINATIONS_MODEL,
  IMAGE_MAX_ATTEMPTS,
  RENDER_SUFFIX,
  IMAGE_FAILURES,
  buildImageRequest,
  buildPollinationsRequest,
  buildProviderRequest,
  pollinationsToResult,
  buildImageState,
  extractImage,
  blockReason,
  evaluateImageAttempt,
  mockImage,
  mockDelaySeconds,
};
if (typeof module !== "undefined" && module.exports) module.exports = imageGeneration;
