import { evaluateAntigravityHook } from "./antigravity.mjs";
import { evaluateCodexHook } from "./codex.mjs";

export const adapters = {
  antigravity: evaluateAntigravityHook,
  codex: evaluateCodexHook,
};
