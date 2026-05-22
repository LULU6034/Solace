// 黑猫 — 纯矩形像素精灵 (viewBox 14×10)
// 特征：黑色身体 / 黄色眼睛 / 尖三角耳 / 长尾巴

const P = {
  body:      '#2a2a2a',
  bodyLight: '#3d3d3d',
  bodyDark:  '#1a1a1a',
  earIn:     '#5a4a5a',
  eye:       '#ffdd44',
  eyePupil:  '#1a0a00',
  eyeHl:     '#ffffff',
  nose:      '#ff8888',
  whisker:   '#666666',
  chest:     '#3a3a3a',
  chestDark: '#2d2d2d',
  paw:       '#222222',
}

export const blackCat = {
  name: '小黑猫',
  icon: '🐱',
  palette: P,
}

export function drawBlackCat(ctx, w, h, now, opts = {}) {
  const { isWalking = false, facingRight = true,
    isEating = false, eatPhase = 0,
    isRejecting = false, rejectPhase = 0,
    isDragOver = false, isWorking = false } = opts
  const VW = 14, VH = 10, CY = 5
  const unit = Math.min(w / VW, h / VH)

  const breatheSpeed = isWorking ? 1.6 : 1
  const breatheAmp = isWorking ? 0.035 : 0.018
  const breathe = Math.sin(now * 2 * Math.PI / 3.2 * breatheSpeed)
  const sx = 1 + breathe * breatheAmp
  const sy = 1 - breathe * breatheAmp

  const wPhase = isWalking ? (now % 0.65) / 0.65 : 0
  const bobY = isWalking ? Math.sin(wPhase * 2 * Math.PI * 2) * 0.25 : 0

  const blinkPh = (now % 4.5) / 4.5
  const blinking = isEating ? true : blinkPh > 0.96

  // 尾巴摆动
  const tailSwing = Math.sin(now * 3.5) * 0.35

  // 耳朵弹跳
  const earB = isWalking ? Math.abs(Math.sin(wPhase * 2 * Math.PI)) * 0.4 : 0
  const earI = Math.sin(now * 2.5) * 0.08

  const eatBob = isEating ? Math.sin(eatPhase * Math.PI * 3) * 0.35 : 0
  const mouthOpen = isEating
    ? Math.abs(Math.sin(eatPhase * Math.PI * 8)) * 0.35 + 0.1
    : 0

  const shakeX = isRejecting
    ? Math.sin(rejectPhase * Math.PI * 6) * (1 - rejectPhase) * 0.5
    : 0

  const hoverScale = isDragOver ? 1.06 : 1
  const glowAlpha = isDragOver ? 0.15 : 0

  function r(x, y, wd, ht, color) {
    const rx = facingRight ? x : VW - x - wd
    const screenX = (rx - VW/2 + shakeX) * sx * unit * hoverScale + VW/2 * unit
    const screenY = (y - CY + bobY + eatBob) * sy * unit * hoverScale + CY * unit
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
  ctx.fillStyle = 'rgba(0,0,0,0.12)'
  ctx.beginPath()
  ctx.ellipse(VW/2 * unit, (9.2 + bobY - CY) * sy * unit + CY * unit, 3.0 * unit, 0.25 * unit, 0, 0, Math.PI * 2)
  ctx.fill()

  // === 尾巴 ===
  r(9.5 + tailSwing * 0.5, 3.5 + tailSwing, 0.5, 0.4, P.bodyDark)
  r(10.2 + tailSwing * 0.7, 3.0 + tailSwing * 1.3, 0.45, 0.5, P.bodyDark)
  r(10.8 + tailSwing * 0.9, 2.5 + tailSwing * 1.8, 0.4, 0.5, P.bodyDark)
  r(11.2 + tailSwing, 2.2 + tailSwing * 2.2, 0.35, 0.4, P.body)

  // === 腿（4 条小黑腿）===
  const legLY = isWalking ? Math.sin(wPhase * 2 * Math.PI) * 0.25 : 0
  const legRY = isWalking ? Math.sin(wPhase * 2 * Math.PI + Math.PI) * 0.25 : 0
  // 后腿
  r(4.2, 7.8 + legLY, 1.1, 1.3, P.bodyDark)
  r(4.2, 8.7 + legLY, 1.1, 0.3, P.paw)
  r(8.7, 7.8 + legRY, 1.1, 1.3, P.bodyDark)
  r(8.7, 8.7 + legRY, 1.1, 0.3, P.paw)
  // 前腿
  r(5.8, 7.6 + legRY, 1.1, 1.4, P.body)
  r(5.8, 8.6 + legRY, 1.1, 0.35, P.paw)
  r(7.2, 7.6 + legLY, 1.1, 1.4, P.body)
  r(7.2, 8.6 + legLY, 1.1, 0.35, P.paw)

  // === 身体 ===
  r(4.5, 4.2, 5.0, 3.4, P.body)
  // 身体高光
  r(5.0, 4.2, 3.5, 2.0, P.bodyLight)
  // 腹部阴影
  r(5.0, 6.8, 4.0, 0.8, P.bodyDark)
  // 胸口
  r(4.5, 4.8, 4.0, 2.5, P.chest)
  r(5.0, 5.0, 3.0, 1.8, P.chestDark)

  // === 头部 ===
  r(4.5, 1.5, 5.0, 3.0, P.body)
  r(5.0, 1.5, 3.5, 1.0, P.bodyLight)
  // 脸颊
  r(4.5, 2.0, 0.3, 2.0, P.bodyDark)
  r(9.2, 2.0, 0.3, 2.0, P.bodyDark)

  // === 耳朵（尖三角，用渐变矩形堆叠）===
  // 左耳
  r(4.8 + earI, -0.2 - earB * 0.6, 1.5, 0.8, P.bodyDark)
  r(5.2 + earI, -0.7 - earB * 0.8, 1.0, 0.7, P.bodyDark)
  r(5.5 + earI, -1.1 - earB * 1.0, 0.6, 0.6, P.bodyDark)
  r(5.4 + earI, -0.3 - earB * 0.6, 0.6, 0.4, P.earIn)
  // 右耳
  r(8.5 + earI, -0.2 - earB * 0.6, 1.5, 0.8, P.bodyDark)
  r(8.8 + earI, -0.7 - earB * 0.8, 1.0, 0.7, P.bodyDark)
  r(9.0 + earI, -1.1 - earB * 1.0, 0.6, 0.6, P.bodyDark)
  r(8.9 + earI, -0.3 - earB * 0.6, 0.6, 0.4, P.earIn)

  // === 眼睛（大黄眼）===
  if (!blinking) {
    r(5.3, 2.7, 1.0, 0.95, P.eye)
    r(5.5, 2.75, 0.35, 0.35, P.eyeHl)
    r(7.7, 2.7, 1.0, 0.95, P.eye)
    r(7.9, 2.75, 0.35, 0.35, P.eyeHl)
    // 竖瞳
    r(5.65, 2.85, 0.25, 0.55, P.eyePupil)
    r(8.05, 2.85, 0.25, 0.55, P.eyePupil)
  } else {
    r(5.3, 3.15, 1.0, 0.12, P.eye)
    r(7.7, 3.15, 1.0, 0.12, P.eye)
  }

  // === 鼻子 ===
  r(6.7, 3.65, 0.55, 0.45, P.nose)

  // === 嘴巴 ===
  if (mouthOpen > 0.02) {
    r(6.4, 4.1, 0.2, 0.12 + mouthOpen * 0.6, P.nose)
    r(7.3, 4.1, 0.2, 0.12 + mouthOpen * 0.6, P.nose)
  } else {
    r(6.4, 4.1, 0.18, 0.1, P.whisker)
    r(7.3, 4.1, 0.18, 0.1, P.whisker)
  }

  // === 胡须 ===
  r(4.0, 3.55, 1.2, 0.12, P.whisker)
  r(4.0, 3.85, 1.2, 0.12, P.whisker)
  r(8.8, 3.55, 1.2, 0.12, P.whisker)
  r(8.8, 3.85, 1.2, 0.12, P.whisker)
}
