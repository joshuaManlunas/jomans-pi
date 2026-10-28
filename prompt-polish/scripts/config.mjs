// Configuration behavior adapted from the canonical extension.
import { readFile } from "node:fs/promises";
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];
export const DEFAULT_POLISH_CONFIG = Object.freeze({
  model: "gpt-5.6-sol",
  thinkingLevel: "high",
  fastMode: true
});
export const POLISH_CONFIG_URL = new URL("../assets/polish.config.json", import.meta.url);
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isThinkingLevel(value) {
  return typeof value === "string" && THINKING_LEVELS.includes(value);
}
function defaults() {
  return { ...DEFAULT_POLISH_CONFIG };
}
function normalizeConfig(value) {
  if (!isRecord(value))
    return defaults();
  return {
    model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : DEFAULT_POLISH_CONFIG.model,
    thinkingLevel: isThinkingLevel(value.thinkingLevel) ? value.thinkingLevel : DEFAULT_POLISH_CONFIG.thinkingLevel,
    fastMode: typeof value.fastMode === "boolean" ? value.fastMode : DEFAULT_POLISH_CONFIG.fastMode
  };
}
export function parsePolishConfig(raw) {
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return defaults();
  }
}
export async function loadPolishConfig(configUrl = POLISH_CONFIG_URL) {
  try {
    return parsePolishConfig(await readFile(configUrl, "utf8"));
  } catch {
    return defaults();
  }
}
