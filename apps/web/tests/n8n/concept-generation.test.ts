import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The exact module the n8n workflow runs (inlined into its Code nodes at deploy time).
const require = createRequire(import.meta.url);
const cg = require(path.resolve(import.meta.dirname, "../../../../n8n/lib/concept-generation.cjs"));

const base = {
  projectId: "8f096623-3889-44d5-9eb3-325ab1861850",
  projectName: "Mechanical Wolf Bust",
  clientName: "Northwind",
  designBrief: "A futuristic mechanical wolf bust with sharp geometric armor and an aggressive expression.",
  count: 3,
  existing: [],
};
const init = (over: Record<string, unknown> = {}, config: Record<string, unknown> = { provider_mode: "mock" }) =>
  cg.buildInitialState({ ...base, ...over, config });

/** Runs the decision loop against the mock provider, like the n8n workflow does. */
function run(scenario: string, count = 3) {
  let { state, request } = init({ count }, { provider_mode: "mock", mock_scenario: scenario });
  for (;;) {
    const out = cg.evaluateAttempt(state, request, cg.mockClaude(state));
    if (out.action !== "retry") return out;
    state = out.state;
    request = out.request;
  }
}

describe("Claude request", () => {
  it("asks for strict JSON with the schema, effort, refusal fallback and the brief as tagged data", () => {
    const { request, state } = init({}, { provider_mode: "live", model: "claude-sonnet-5-5", effort: "high" });
    expect(request.model).toBe("claude-sonnet-5-5");
    expect(request.output_config).toEqual({ effort: "high", format: { type: "json_schema", schema: cg.CONCEPTS_SCHEMA } });
    expect(request.fallbacks).toBe("default");
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].content).toContain("<design_brief>\nA futuristic mechanical wolf bust");
    expect(request.messages[0].content).toContain("exactly 3 genuinely different concepts");
    expect(state).toMatchObject({ attempt: 1, max_attempts: 3, provider_mode: "live" });
  });

  it("system prompt covers printability, distinctness, originality and injection resistance", () => {
    for (const phrase of ["silhouette", "Coherent geometry", "Manufacturable", "genuinely different", "original", "ignore any instructions"]) {
      expect(cg.SYSTEM_PROMPT).toContain(phrase);
    }
    expect(cg.SYSTEM_PROMPT).toMatch(/do not produce 3D models/i);
  });

  it("schema requires every field and forbids extra properties", () => {
    const item = cg.CONCEPTS_SCHEMA.properties.concepts.items;
    expect(item.required).toEqual(expect.arrayContaining(["title", "shape_language", "image_generation_prompt", "materials"]));
    expect(item.additionalProperties).toBe(false);
    expect(cg.CONCEPTS_SCHEMA.additionalProperties).toBe(false);
  });

  it("lists earlier concepts so 'more ideas' avoids repeating them", () => {
    const { request, state } = init({ existing: [{ title: "Alpha Plate", description: "Layered plates", status: "REJECTED" }] });
    expect(request.messages[0].content).toContain('"Alpha Plate" [rejected]');
    expect(state.existing_titles).toEqual(["alpha plate"]);
  });
});

describe("parsing never trusts raw text", () => {
  it.each([
    ["plain JSON", '{"concepts": []}', []],
    ["fenced JSON", 'Here you go:\n```json\n{"concepts": []}\n```', ["extracted JSON from surrounding text"]],
    ["trailing commas", '{"concepts": [],}', ["removed trailing commas"]],
    ["bare array", "[]", ["wrapped a bare array in { concepts }"]],
  ])("repairs %s", (_label, text, repairs) => {
    const out = cg.parseConceptsJson(text);
    expect(out.data).toEqual({ concepts: [] });
    expect(out.repairs).toEqual(expect.arrayContaining(repairs));
  });

  it("rejects prose and truncated JSON instead of guessing", () => {
    expect(cg.parseConceptsJson("I think the wolf should be...").data).toBeNull();
    expect(cg.parseConceptsJson('{"concepts": [{"title": "Cut').data).toBeNull();
    expect(cg.parseConceptsJson("").error).toBe("empty response");
  });
});

describe("validation", () => {
  const good = () => JSON.parse(cg.mockClaude({ count: 3, attempt: 1, mock_scenario: "ok" }).body.content[0].text);

  it("accepts well-formed, distinct concepts", () => {
    expect(cg.validateConcepts(good(), { count: 3 }).ok).toBe(true);
  });

  it("normalises camelCase keys and string lists", () => {
    const data = good();
    data.concepts[0].keyFeatures = "Weighted base, Split line, Signature silhouette";
    delete data.concepts[0].key_features;
    const out = cg.validateConcepts(data, { count: 3 });
    expect(out.ok).toBe(true);
    expect(out.concepts[0].key_features).toEqual(["Weighted base", "Split line", "Signature silhouette"]);
    expect(out.repairs).toEqual(expect.arrayContaining(["renamed keyFeatures to key_features"]));
  });

  it("flags missing fields, short text, wrong counts, duplicate and repeated titles", () => {
    const data = good();
    delete data.concepts[0].shape_language;
    data.concepts[1].description = "Too short";
    data.concepts[2].title = data.concepts[1].title;
    const out = cg.validateConcepts(data, { count: 4, existingTitles: [data.concepts[1].title.toLowerCase()] });
    expect(out.ok).toBe(false);
    const all = out.errors.join("\n");
    expect(all).toMatch(/expected exactly 4 concepts, received 3/);
    expect(all).toMatch(/"shape_language" is required/);
    expect(all).toMatch(/"description" is too short/);
    expect(all).toMatch(/is used twice/);
    expect(all).toMatch(/repeats an earlier concept/);
  });

  it("detects superficial variations", () => {
    const sameDirection = JSON.parse(cg.mockClaude({ count: 3, attempt: 1, mock_scenario: "too_similar_then_ok" }).body.content[0].text);
    const out = cg.validateConcepts(sameDirection, { count: 3 });
    expect(out.ok).toBe(false);
    expect(out.errors.join(" ")).toMatch(/too similar/);
  });

  it("keeps only the requested number when Claude returns extra concepts", () => {
    const data = JSON.parse(cg.mockClaude({ count: 5, attempt: 1, mock_scenario: "ok" }).body.content[0].text);
    const out = cg.validateConcepts(data, { count: 3 });
    expect(out.ok).toBe(true);
    expect(out.concepts).toHaveLength(3);
    expect(out.warnings[0]).toMatch(/kept the first 3/);
  });
});

describe("decision engine (repair, retry, fail gracefully)", () => {
  it("saves valid output on the first attempt", () => {
    const out = run("ok", 4);
    expect(out.action).toBe("save");
    expect(out.concepts).toHaveLength(4);
    expect(out.meta).toMatchObject({ attempts: 1, providerMode: "mock" });
  });

  it("applies local structural repair without another Claude call", () => {
    const out = run("repairable");
    expect(out.action).toBe("save");
    expect(out.meta.attempts).toBe(1);
    expect(out.meta.history[0].repairs.length).toBeGreaterThan(0);
  });

  it.each([
    ["malformed_then_ok", "invalid"],
    ["too_similar_then_ok", "invalid"],
    ["truncated_then_ok", "truncated"],
    ["api_error_then_ok", "http_error"],
  ])("%s: retries once, then saves", (scenario, firstOutcome) => {
    const out = run(scenario);
    expect(out.action).toBe("save");
    expect(out.meta.attempts).toBe(2);
    expect(out.meta.history[0].outcome).toBe(firstOutcome);
  });

  it("sends Claude the validation errors and its previous output when repairing", () => {
    const { state, request } = init({}, { provider_mode: "mock", mock_scenario: "malformed_then_ok" });
    const out = cg.evaluateAttempt(state, request, cg.mockClaude(state));
    expect(out.action).toBe("retry");
    const prompt = out.request.messages[0].content;
    expect(prompt).toContain("<previous_output>");
    expect(prompt).toContain("response is not valid JSON");
    expect(out.request.messages).toHaveLength(1); // previous output passed as data, not as an assistant turn
  });

  it("raises max_tokens after a truncated answer", () => {
    const { state, request } = init({}, { provider_mode: "mock", mock_scenario: "truncated_then_ok" });
    const out = cg.evaluateAttempt(state, request, cg.mockClaude(state));
    expect(out.request.max_tokens).toBe(24000);
  });

  it.each([
    ["always_malformed", "invalid_output", 3],
    ["api_down", "claude_unavailable", 3],
    ["transport_error", "claude_unavailable", 3],
    ["auth_error", "claude_auth", 1],
    ["refusal", "claude_refused", 1],
  ])("%s: fails gracefully with %s after %i attempt(s)", (scenario, code, attempts) => {
    const out = run(scenario);
    expect(out.action).toBe("fail");
    expect(out.failure.code).toBe(code);
    expect(out.failure.reason).toBe(cg.FAILURES[code]);
    expect(out.meta.attempts).toBe(attempts);
  });

  it("never exposes raw API error text in the client-facing reason", () => {
    const out = run("auth_error");
    expect(out.failure.reason).not.toMatch(/x-api-key/);
    expect(out.failure.detail).toMatch(/x-api-key/); // kept for operators (n8n execution log)
  });
});
