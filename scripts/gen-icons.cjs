// 从 favicon.svg 生成各尺寸图标
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function main() {
  const svgPath = path.join(__dirname, '../public/favicon.svg');
  if (!fs.existsSync(svgPath)) {
    console.log('⚠ favicon.svg 不存在，跳过图标生成');
    return;
  }
  const svg = fs.readFileSync(svgPath, 'utf8');

  const sizes = [
    { name: 'tray-icon.png', size: 32 },
    { name: 'icon.png', size: 256 },
  ];

  for (const { name, size } of sizes) {
    const outPath = path.join(__dirname, '../public', name);
    await sharp(Buffer.from(svg)).resize(size, size).png().toFile(outPath);
    console.log(`✅ ${name} (${size}x${size})`);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
