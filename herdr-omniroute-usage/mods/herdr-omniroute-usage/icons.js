const SVG_PROVIDERS = new Set([
  "360ai", "alibaba", "anthropic", "arcee-ai", "arcee", "assemblyai", "auggie", "aws", "azure", "azureai",
  "baichuan", "baidu", "bailian", "baseten", "bluesminds", "bytez", "cerebras", "charm-hyper", "chutes",
  "claude-web", "claude", "cline", "cloudflare", "codex", "cohere", "comfyui", "continue", "copilot", "coze",
  "crof", "cursor", "deepgram", "deepinfra", "deepseek", "dgrid", "dify", "dit", "doubao", "elevenlabs", "exa",
  "factory", "fal", "fireworks", "freeaiapikey", "freemodel-dev", "friendli", "galadriel", "gemini", "gisoo",
  "gitlawb-gmi", "gitlawb", "google", "grok", "groq", "hcnsec", "heroku", "huggingchat", "huggingface",
  "hyperbolic", "ibm", "iflytek", "inclusionai", "inference", "kenari", "kimi", "kiro", "krutrim", "lambda",
  "liquid", "llm7", "longcat", "meta", "metaai", "minimax", "mistral", "monsterapi", "moonshot", "morph",
  "nebius", "nomic", "notrack-web", "novita", "nube", "nvidia", "ollama", "openadapter", "openai", "openclaw",
  "openrouter", "opper", "orcarouter", "ovhcloud", "perplexity", "phind", "picoclaw", "pioneer", "poe",
  "pollinations", "poolside", "publicai", "qwen", "recraft", "replicate", "requesty", "roocode", "runcrate",
  "runway", "sambanova", "searchapi", "sensenova", "snowflake", "sparkdesk", "stepfun", "sumopod", "suno",
  "t3-web", "tavily", "tencent", "tokenrouter", "topazlabs", "trae", "udio", "uncloseai", "upstage", "v0",
  "veoaifree-web", "vercel", "vllm", "volcengine", "voyage", "wafer", "windsurf", "x5lab", "xai", "xinference",
  "yi", "yuanbao-web", "zed-hosted", "zenmux-free", "zenmux", "zhipu",
]);

const ALIASES = { bigmodel: "zhipu", "grok-cli": "grok", "deepseek-web": "deepseek" };

// Provider logos from OmniRoute v3.8.54 public/providers.
export function providerIconPath(providerId) {
  if (typeof providerId !== "string") return null;
  const id = providerId.toLowerCase();
  const asset = Object.hasOwn(ALIASES, id) ? ALIASES[id] : id;
  return SVG_PROVIDERS.has(asset) ? `mods/herdr-omniroute-usage/assets/providers/${asset}.svg` : null;
}
