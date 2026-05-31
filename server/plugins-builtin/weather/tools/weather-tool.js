/**
 * weather-tool.js — 天气查询工具（示例插件）
 *
 * 演示 Plugin 工具贡献模式。
 * 使用 wttr.in 免费 API 查询天气。
 */
export default {
  name: 'get_weather',
  description: '查询城市天气。参数 city: 城市名称（中文或英文）',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名称，如"北京"、"Shanghai"' },
    },
    required: ['city'],
  },

  async invoke({ city }) {
    if (!city?.trim()) return '请提供城市名称';

    try {
      const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!resp.ok) return `天气查询失败: HTTP ${resp.status}`;

      const data = await resp.json();
      const current = data.current_condition?.[0];
      const forecast = data.weather?.[0];

      if (!current) return `未找到城市"${city}"的天气信息`;

      const lines = [
        `**${city}** 当前天气:`,
        `- 温度: ${current.temp_C}°C (体感 ${current.FeelsLikeC}°C)`,
        `- 天气: ${current.weatherDesc?.[0]?.value || '未知'}`,
        `- 湿度: ${current.humidity}%`,
        `- 风速: ${current.windSpeedKmph} km/h`,
        `- 能见度: ${current.visibility} km`,
      ];

      if (forecast) {
        lines.push(`\n今日: ${forecast.mintempC}°C ~ ${forecast.maxtempC}°C`);
      }

      return lines.join('\n');
    } catch (err) {
      return `天气查询失败: ${err.message}`;
    }
  },
};
