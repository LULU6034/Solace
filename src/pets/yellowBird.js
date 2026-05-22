// 小黄鸟 — 纯矩形像素精灵 (viewBox 14×10)
// 特征：圆滚黄色身体 / 橙色冠羽 / 小喙 / 翅膀拍动

const P = {
  body:      '#FFD740',
  bodyLight: '#FFE082',
  bodyDark:  '#E6B800',
  belly:     '#FFECB3',
  crest:     '#FF9800',
  crestDark: '#E65100',
  beak:      '#FF6D00',
  beakLight: '#FF9100',
  eye:       '#1a1a1a',
  eyeHl:     '#ffffff',
  wing:      '#FFC400',
  wingDark:  '#FFAB00',
  foot:      '#FF8F00',
  cheek:     'rgba(255,150,100,0.3)',
}

export const yellowBird = {
  name: '小黄鸟',
  icon: '🐤',
  palette: P,
}

export function drawYellowBird(ctx, w, h, now, opts = {}) {
  const { isWalking = false, facingRight = true,
    isEating = false, eatPhase = 0,
    isRejecting = false, rejectPhase = 0,
    isDragOver = false, isWorking = false } = opts
  const VW = 14, VH = 10, CY = 5
  const unit = Math.min(w / VW, h / VH)

  const breatheSpeed = isWorking ? 1.6 : 1
  const breatheAmp = isWorking ? 0.03 : 0.014
  const breathe = Math.sin(now * 2 * Math.PI / 3.2 * breatheSpeed)
  const sx = 1 + breathe * breatheAmp
  const sy = 1 - breathe * breatheAmp

  const wPhase = isWalking ? (now % 0.5) / 0.5 : 0
  const hopY = isWalking ? Math.abs(Math.sin(wPhase * Math.PI)) * 0.5 : 0

  const blinkPh = (now % 3.8) / 3.8
  const blinking = isEating ? true : blinkPh > 0.96

  // 翅膀拍动
  const wingFlap = isWalking ? Math.sin(wPhase * Math.PI * 2) * 0.3 : Math.sin(now * 4) * 0.08

  // 冠羽摇摆
  const crestSway = Math.sin(now * 3) * 0.1

  const eatBob = isEating ? Math.sin(eatPhase * Math.PI * 4) * 0.3 : 0
  const beakOpen = isEating
    ? Math.abs(Math.sin(eatPhase * Math.PI * 10)) * 0.25
    : Math.abs(Math.sin(now * 2.5)) * 0.04

  const shakeX = isRejecting
    ? Math.sin(rejectPhase * Math.PI * 8) * (1 - rejectPhase) * 0.4
    : 0

  const hoverScale = isDragOver ? 1.06 : 1
  const glowAlpha = isDragOver ? 0.15 : 0

  function r(x, y, wd, ht, color) {
    const rx = facingRight ? x : VW - x - wd
    const screenX = (rx - VW/2 + shakeX) * sx * unit * hoverScale + VW/2 * unit
    const screenY = (y - CY + hopY + eatBob) * sy * unit * hoverScale + CY * unit
    ctx.fillStyle = color
    ctx.fillRect(screenX, screenY, wd * sx * unit * hoverScale, ht * sy * unit * hoverScale)
  }

  ctx.clearRect(0, 0, w, h)

  if (glowAlpha > 0) {
    ctx.fillStyle = `rgba(255,240,200,${glowAlpha})`
    ctx.beginPath()
    ctx.ellipse(VW/2 * unit, CY * unit, 5.5 * unit, 4 * unit, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  // 阴影
  ctx.fillStyle = 'rgba(0,0,0,0.10)'
  ctx.beginPath()
  ctx.ellipse(VW/2 * unit, (9.2 + hopY - CY) * sy * unit + CY * unit, 2.8 * unit, 0.22 * unit, 0, 0, Math.PI * 2)
  ctx.fill()

  // === 脚（小爪子）===
  r(5.2, 8.5 + Math.sin(now * 4) * 0.1, 0.7, 0.8, P.foot)
  r(5.2, 9.0 + Math.sin(now * 4) * 0.1, 1.0, 0.2, P.foot)
  r(8.2, 8.5 + Math.sin(now * 4 + 1) * 0.1, 0.7, 0.8, P.foot)
  r(8.2, 9.0 + Math.sin(now * 4 + 1) * 0.1, 1.0, 0.2, P.foot)

  // === 身体（椭圆效果用多层矩形堆叠）===
  // 主体
  r(4.2, 4.5, 5.6, 3.8, P.body)
  r(4.5, 4.5, 5.0, 1.0, P.bodyLight)
  r(5.0, 7.5, 4.0, 0.8, P.bodyDark)
  // 肚皮
  r(5.5, 4.8, 3.0, 3.0, P.belly)
  // 身体两侧圆角效果
  r(4.0, 5.0, 0.3, 2.5, P.bodyDark)
  r(9.7, 5.0, 0.3, 2.5, P.bodyDark)

  // === 翅膀 ===
  // 翅膀拍动时向上偏移
  r(3.2 + wingFlap * 0.3, 4.5 - wingFlap * 1.2, 1.8, 2.5, P.wing)
  r(3.2 + wingFlap * 0.3, 4.5 - wingFlap * 1.2, 1.8, 0.4, P.wingDark)

  // === 头部 ===
  r(4.5, 1.8, 5.0, 3.0, P.body)
  r(5.0, 1.8, 3.5, 1.2, P.bodyLight)
  // 脸颊圆润
  r(4.2, 2.0, 0.3, 2.3, P.bodyDark)
  r(9.5, 2.0, 0.3, 2.3, P.bodyDark)
  // 腮红
  r(4.6, 3.5, 1.0, 0.7, P.cheek)
  r(8.4, 3.5, 1.0, 0.7, P.cheek)

  // === 冠羽 ===
  r(6.5 + crestSway, 0.2, 0.7, 0.5, P.crestDark)
  r(6.6 + crestSway * 1.2, -0.3, 0.6, 0.6, P.crest)
  r(6.8 + crestSway * 1.5, -0.7, 0.5, 0.5, P.crest)
  // 侧羽
  r(5.8 + crestSway * 0.5, 0.5, 0.5, 0.4, P.crestDark)
  r(8.0 - crestSway * 0.5, 0.5, 0.5, 0.4, P.crestDark)

  // === 眼睛 ===
  if (!blinking) {
    r(5.2, 2.8, 0.9, 0.9, P.eye)
    r(5.35, 2.85, 0.32, 0.32, P.eyeHl)
    r(7.9, 2.8, 0.9, 0.9, P.eye)
    r(8.05, 2.85, 0.32, 0.32, P.eyeHl)
  } else {
    r(5.2, 3.2, 0.9, 0.13, P.eye)
    r(7.9, 3.2, 0.9, 0.13, P.eye)
  }

  // === 喙 ===
  r(6.5, 3.55, 1.2, 0.22 + beakOpen, P.beak)
  r(6.7, 3.55 + beakOpen, 0.8, 0.25, P.beakLight)
  // 上喙突起
  r(6.8, 3.3, 0.3, 0.3, P.beak)
}
