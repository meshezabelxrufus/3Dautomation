import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectImage } from "@/server/assets/images";

const require = createRequire(import.meta.url);
const ig = require(path.resolve(import.meta.dirname, "../../../../n8n/lib/image-generation.cjs"));

const state = (over: Record<string, unknown> = {}, config: Record<string, unknown> = { provider_mode: "mock" }) =>
  ig.buildImageState({ conceptId: "c1", projectId: "p1", conceptNumber: 2, prompt: "Render of a faceted owl lamp.", config, ...over });

function run(scenario: string, conceptNumber = 2, isRetry = false) {
  let st = state({ conceptNumber, isRetry }, { provider_mode: "mock", mock_scenario: scenario });
  for (;;) {
    const out = ig.evaluateImageAttempt(st, ig.mockImage(st));
    if (out.action !== "retry") return out;
    st = out.state;
  }
}

describe("Nano Banana request", () => {
  it("uses generateContent with image output, 1:1 framing and the consistent render suffix", () => {
    const st = state({}, { provider_mode: "live", image_model: "gemini-3.1-flash-image" });
    const req = ig.buildImageRequest({ model: st.model, prompt: st.prompt, aspectRatio: "1:1" });
    expect(req.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent");
    expect(req.body.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1" } });
    expect(req.body.contents[0].parts[0].text).toContain("Render of a faceted owl lamp.");
    expect(req.body.contents[0].parts[0].text).toContain("No text, letters, logos");
  });

  it("adds the reference image for edits", () => {
    const req = ig.buildImageRequest({ prompt: "Make the ring thinner", referenceImage: { mimeType: "image/png", data: "AAAA" } });
    expect(req.body.contents[0].parts[1]).toEqual({ inline_data: { mime_type: "image/png", data: "AAAA" } });
  });
});

describe("response handling", () => {
  it("extracts the image from generateContent and Interactions responses", () => {
    expect(ig.extractImage({ candidates: [{ content: { parts: [{ text: "x" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }] } }] })).toEqual({ mimeType: "image/png", data: "QUJD" });
    expect(ig.extractImage({ steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: "QUJD" }] }] })).toEqual({ mimeType: "image/jpeg", data: "QUJD" });
    expect(ig.extractImage({ candidates: [{ content: { parts: [{ text: "only text" }] } }] })).toBeNull();
  });

  it("mock images are real PNGs", () => {
    const out = run("ok");
    expect(out.action).toBe("save");
    const info = inspectImage(Buffer.from(out.image.data_base64, "base64"));
    expect(info).toMatchObject({ mimeType: "image/png", width: 256, height: 256 });
    expect(out.provider_request_id).toMatch(/^mock-c1-1$/);
  });
});

describe("decision engine", () => {
  it.each([
    ["api_error_then_ok", 2, "http_error"],
    ["no_image_then_ok", 2, "no_image"],
  ])("%s recovers on attempt %i", (scenario, attempts, first) => {
    const out = run(scenario);
    expect(out.action).toBe("save");
    expect(out.meta.attempts).toBe(attempts);
    expect(out.meta.history?.[0]?.outcome ?? first).toBeTruthy();
  });

  it.each([
    ["api_down", "image_unavailable", 3],
    ["timeout", "image_unavailable", 3],
    ["blocked", "image_blocked", 1],
    ["auth_error", "image_auth", 1],
    ["model_not_found", "image_model_unavailable", 1],
  ])("%s fails with %s after %i attempt(s)", (scenario, code, attempts) => {
    const out = run(scenario);
    expect(out.action).toBe("fail");
    expect(out.failure.code).toBe(code);
    expect(out.failure.reason).toBe(ig.IMAGE_FAILURES[code]);
    expect(out.meta.attempts).toBe(attempts);
  });

  it("fail:<n> only fails that concept (partial failure)", () => {
    expect(run("fail:3", 3).action).toBe("fail");
    expect(run("fail:3", 1).action).toBe("save");
    expect(run("fail:3", 4).action).toBe("save");
  });

  it("fail:<n> succeeds on a manual retry; fail_always:<n> does not", () => {
    expect(run("fail:3", 3, true).action).toBe("save");
    expect(run("fail_always:3", 3, true).action).toBe("fail");
  });

  it("slow scenario asks the workflow to wait", () => {
    expect(ig.mockDelaySeconds(state({}, { provider_mode: "mock", mock_scenario: "slow" }))).toBeGreaterThan(5);
    expect(ig.mockDelaySeconds(state())).toBe(0);
  });
});

const png = () => {
  const r = ig.mockImage({ mock_scenario: "ok", concept_number: 1, attempt: 1, concept_id: "x" });
  return Buffer.from(r.body.candidates[0].content.parts[1].inlineData.data, "base64");
};

describe("Pollinations (provider for testing without Gemini)", () => {
  const live = (over: Record<string, unknown> = {}, cfg: Record<string, unknown> = {}) =>
    state(over, { provider_mode: "live", image_provider: "pollinations", ...cfg });
  const ok = (b64: string) => ({ statusCode: 200, body: { created: 1, data: [{ b64_json: b64 }], usage: {} } });

  it("generates through the authenticated JSON API with FLUX.2 klein by default", () => {
    const st = live();
    const req = ig.buildProviderRequest(st);
    expect(req.url).toBe("https://gen.pollinations.ai/v1/images/generations");
    expect(req.body).toMatchObject({ model: "black-forest-labs/flux.2-klein-4b", size: "1024x1024", response_format: "b64_json" });
    expect(req.body.prompt).toContain("faceted owl lamp");
    expect(req.body.image).toBeUndefined();
    expect(live({}, { pollinations_model: "tongyi-mai/z-image-turbo" }).model).toBe("tongyi-mai/z-image-turbo");
  });

  it("refinements are real edits: the current image goes along as a data URI", () => {
    const req = ig.buildProviderRequest(live(), { mimeType: "image/jpeg", data: "QUJD" });
    expect(req.url).toBe("https://gen.pollinations.ai/v1/images/edits");
    expect(req.body.image).toBe("data:image/jpeg;base64,QUJD");
  });

  it("normalises the response, detecting the image type, recorded as provider pollinations", () => {
    const data = png().toString("base64");
    const out = ig.evaluateImageAttempt(live(), ok(data));
    expect(out).toMatchObject({ action: "save", model: "black-forest-labs/flux.2-klein-4b" });
    expect(out.image).toEqual({ mime_type: "image/png", data_base64: data });
    expect(out.meta.provider).toBe("pollinations");
    expect(ig.evaluateImageAttempt(live(), ok("/9j/" + data)).image.mime_type).toBe("image/jpeg");
  });

  it.each([
    [401, "image_auth", "fail"],
    [402, "image_quota", "fail"],
    [400, "image_request_rejected", "fail"],
    [429, null, "retry"],
    [503, null, "retry"],
  ])("HTTP %i -> %s", (status, code, action) => {
    const out = ig.evaluateImageAttempt(live(), { statusCode: status, body: { success: false, error: { message: "x", code: "E" } } });
    expect(out.action).toBe(action);
    if (code) expect(out.failure.code).toBe(code);
  });

  it("a 200 without an image is retried", () => {
    expect(ig.evaluateImageAttempt(live(), { statusCode: 200, body: { data: [] } }).action).toBe("retry");
  });

  it("Gemini stays the default provider", () => {
    expect(state({}, { provider_mode: "live" }).provider).toBe("gemini");
    expect(new URL(ig.buildProviderRequest(state({}, { provider_mode: "live" })).url).host).toBe("generativelanguage.googleapis.com");
  });
});
