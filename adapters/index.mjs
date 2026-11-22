import { evaluateAntigravityHook } from "./antigravity.mjs";
import { evaluateClaudeHook } from "./claude.mjs";
import { evaluateCodexHook } from "./codex.mjs";

export const adapters = {
  antigravity: evaluateAntigravityHook,
  claude: evaluateClaudeHook,
  codex: evaluateCodexHook,
};
