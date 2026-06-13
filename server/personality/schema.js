// server/personality/schema.js — OCEAN + 风格数据结构
// 参考: my_agent_project/config/personality/ocean_baseline.yaml

export const OCEAN_DEFAULTS = {
  openness: 0.7,          // 开放性 — 好奇心/创造力
  conscientiousness: 0.5, // 尽责性 — 自律/条理
  extraversion: 0.6,      // 外向性 — 社交/活力
  agreeableness: 0.8,     // 宜人性 — 共情/合作
  neuroticism: 0.3,       // 神经质性 — 情绪稳定性
};

export const STYLE_DEFAULTS = {
  humor: 0.4,
  formality: 0.9,
  empathy: 0.7,
  verbosity: 0.5,
  optimism: 0.7,
};

export const OCEAN_BOUNDS = {
  openness: [0, 1],
  conscientiousness: [0, 1],
  extraversion: [0, 1],
  agreeableness: [0, 1],
  neuroticism: [0.1, 0.8], // 不低于 0.1，不高于 0.8
};

export function normalizeOcean(ocean) {
  const result = { ...OCEAN_DEFAULTS, ...ocean };
  for (const [key, [min, max]] of Object.entries(OCEAN_BOUNDS)) {
    result[key] = Math.max(min, Math.min(max, result[key]));
  }
  return result;
}

export function oceanHash(ocean) {
  return Object.values(ocean).map(v => v.toFixed(2)).join(':');
}
