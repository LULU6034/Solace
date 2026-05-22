// 小狐狸 — 纯矩形像素精灵 (viewBox 14×10)
// 特征：橙色身体 / 白色胸腹 / 大尾巴 / 尖耳朵

const P = {
  body:      '#F0843C',
  bodyLight: '#FFA060',
  bodyDark:  '#D06020',
  belly:     '#FFF8F0',
  bellyDark: '#F0E8E0',
  earIn:     '#FFE8E0',
  earTip:    '#3a2010',
  eye:       '#2a1808',
  eyeHl:     '#ffffff',
  nose:      '#3a2010',
  tail:      '#F0843C',
  tailTip:   '#FFF8F0',
  paw:       '#3a2010',
  mouth:     '#8a6050',
}

export const fox = {
  name: '小狐狸',
  icon: '🦊',
  palette: P,
}

export function drawFox(ctx, w, h, now, opts = {}) {
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

  const eatBob = isEating ? Math.sin(eatPhase * Math.PI * 3) * 0.35 : 0
  const mouthOpen = isEating
    ? Math.abs(Math.sin(eatPhase * Math.PI * 8)) * 0.3 + 0.1
    : 0

  // 大尾巴摇摆
  const tailWag = Math.sin(now * 2.8) * 0.5

  // 耳朵弹跳
  const earB = isWalking ? Math.abs(Math.sin(wPhase * Math.PI)) * 0.5 : 0
  const earI = Math.sin(now * 2.5) * 0.08

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
  ctx.fillStyle = 'rgba(0,0,0,0.10)'
  ctx.beginPath()
  ctx.ellipse(VW/2 * unit, (9.2 + bobY - CY) * sy * unit + CY * unit, 3.2 * unit, 0.25 * unit, 0, 0, Math.PI * 2)
  ctx.fill()

  // === 大尾巴 ===
  r(9.0 + tailWag, 5.8 + tailWag * 1.8, 0.8, 0.6, P.tail)
  r(9.5 + tailWag * 0.8, 4.8 + tailWag * 2.0, 0.7, 0.7, P.tail)
  r(9.9 + tailWag * 0.6, 4.0 + tailWag * 2.2, 0.7, 0.7, P.tail)
  r(10.2 + tailWag * 0.3, 3.2 + tailWag * 2.0, 0.8, 0.6, P.tail)
  r(10.4 + tailWag * 0.1, 2.4 + tailWag * 1.5, 0.9, 0.6, P.tailTip)
  r(10.5, 1.8 + tailWag * 1.0, 0.8, 0.6, P.tailTip)

  // === 腿 ===
  const legLY = isWalking ? Math.sin(wPhase * 2 * Math.PI) * 0.25 : 0
  const legRY = isWalking ? Math.sin(wPhase * 2 * Math.PI + Math.PI) * 0.25 : 0
  // 后腿
  r(4.5, 7.6 + legLY, 1.2, 1.5, P.bodyDark)
  r(4.5, 8.8 + legLY, 1.2, 0.3, P.paw)
  r(8.3, 7.6 + legRY, 1.2, 1.5, P.bodyDark)
  r(8.3, 8.8 + legRY, 1.2, 0.3, P.paw)
  // 前腿
  r(5.8, 7.5 + legRY, 1.1, 1.5, P.body)
  r(5.8, 8.7 + legRY, 1.1, 0.3, P.paw)
  r(7.1, 7.5 + legLY, 1.1, 1.5, P.body)
  r(7.1, 8.7 + legLY, 1.1, 0.3, P.paw)

  // === 身体 ===
  r(4.2, 4.5, 5.6, 3.0, P.body)
  r(4.6, 4.5, 4.5, 1.0, P.bodyLight)
  r(4.5, 7.0, 5.0, 0.5, P.bodyDark)

  // === 白胸腹 ===
  r(5.0, 5.0, 3.5, 2.5, P.belly)
  r(5.5, 5.0, 2.5, 0.3, P.bellyDark)

  // === 头部 ===
  r(4.2, 1.4, 5.6, 3.4, P.body)
  r(4.6, 1.4, 4.8, 1.0, P.bodyLight)
  r(4.2, 2.0, 0.3, 2.5, P.bodyDark)
  r(9.5, 2.0, 0.3, 2.5, P.bodyDark)
  // 下巴白色
  r(5.0, 4.2, 4.0, 0.6, P.belly)

  // === 耳朵（大三角尖耳）===
  // 左耳
  r(4.7 + earI, -0.4 - earB * 0.7, 1.6, 0.9, P.bodyDark)
  r(5.1 + earI, -1.0 - earB * 0.9, 1.2, 0.8, P.bodyDark)
  r(5.4 + earI, -1.5 - earB * 1.1, 0.8, 0.7, P.earTip)
  // 左耳内侧
  r(5.3 + earI, -0.4 - earB * 0.7, 0.5, 0.5, P.earIn)
  // 右耳
  r(8.3 + earI, -0.4 - earB * 0.7, 1.6, 0.9, P.bodyDark)
  r(8.5 + earI, -1.0 - earB * 0.9, 1.2, 0.8, P.bodyDark)
  r(8.7 + earI, -1.5 - earB * 1.1, 0.8, 0.7, P.earTip)
  r(8.6 + earI, -0.4 - earB * 0.7, 0.5, 0.5, P.earIn)

  // === 眼睛 ===
  if (!blinking) {
    r(5.3, 2.6, 0.9, 0.85, P.eye)
    r(5.4, 2.65, 0.3, 0.3, P.eyeHl)
    r(7.8, 2.6, 0.9, 0.85, P.eye)
    r(7.9, 2.65, 0.3, 0.3, P.eyeHl)
  } else {
    r(5.3, 3.0, 0.9, 0.12, P.eye)
    r(7.8, 3.0, 0.9, 0.12, P.eye)
  }

  // === 鼻子 ===
  r(6.5, 3.3, 0.8, 0.55, P.nose)
  r(6.7, 3.3, 0.22, 0.2, '#5a4030')

  // === 嘴巴 ===
  if (mouthOpen > 0.02) {
    r(6.4, 3.9, 0.2, 0.12 + mouthOpen * 0.5, P.mouth)
    r(7.3, 3.9, 0.2, 0.12 + mouthOpen * 0.5, P.mouth)
  } else {
    r(6.4, 3.9, 0.15, 0.1, P.mouth)
    r(7.3, 3.9, 0.15, 0.1, P.mouth)
  }
}
