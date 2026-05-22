// 镜框小狗 — 纯矩形像素精灵 (viewBox 14×10)
// 特征：白色身体 / 红眼圈 / 粉色衣服 / 两只短手 / 尖椭圆耳朵 / 大圆眼镜

const P = {
  body:      '#FEFAF5',   // 白色身体
  bodyShade: '#EDE8E0',   // 身体阴影
  earIn:     '#FFE8E0',   // 耳朵内侧（粉白）
  earEdge:   '#E8D8D0',   // 耳朵边缘
  glasses:   '#C04060',   // 镜框紫红
  eyeRingR:  '#E88080',   // 眼圈红色（左半）
  eyeRingBr: '#B87850',   // 眼圈棕色（右半）
  eye:       '#1a0a0a',   // 眼珠
  eyeHl:     '#ffffff',   // 眼睛高光
  nose:      '#3a3a3a',   // 鼻子
  noseHl:    '#6a6a6a',   // 鼻子反光
  mouth:     '#C8B0A0',   // 嘴线
  cloth:     '#F0A0B0',   // 粉色衣服
  clothD:    '#D08090',   // 衣服阴影
  clothL:    '#FFC0D0',   // 衣服高光
  arm:       '#FEFAF5',   // 手臂（同身体白）
  armShade:  '#EDE8E0',   // 手臂阴影
}

export const glassesDog = {
  name: '镜框小狗',
  icon: '🐶',
  palette: P,
}

export function drawGlassesDog(ctx, w, h, now, opts = {}) {
  const { isWalking = false, facingRight = true,
    isEating = false, eatPhase = 0,
    isRejecting = false, rejectPhase = 0,
    isDragOver = false, isWorking = false } = opts
  const VW = 14, VH = 10, CY = 5
  const unit = Math.min(w / VW, h / VH)

  // — 动画参数 — 工作时加速呼吸
  const breatheSpeed = isWorking ? 1.6 : 1
  const breatheAmp = isWorking ? 0.035 : 0.018
  const breathe = Math.sin(now * 2 * Math.PI / 3.2 * breatheSpeed)
  const sx = 1 + breathe * breatheAmp
  const sy = 1 - breathe * breatheAmp

  const wPhase = isWalking ? (now % 0.65) / 0.65 : 0
  const bobY = isWalking ? Math.sin(wPhase * 2 * Math.PI * 2) * 0.3 : 0

  const blinkPh = (now % 4.5) / 4.5
  const blinking = isEating ? true : blinkPh > 0.96  // 进食时闭眼

  // 耳朵弹跳 + 微动
  const earB = isWalking ? Math.abs(Math.sin(wPhase * 2 * Math.PI)) * 0.55 : 0
  const earI = isWalking ? 0 : Math.sin(now * 2.5) * 0.1

  // 短手摆动（走路时）
  const armSwing = isWalking ? Math.sin(wPhase * 2 * Math.PI) * 0.4 : 0

  // 进食动画
  const eatBob = isEating ? Math.sin(eatPhase * Math.PI * 3) * 0.4 : 0
  const mouthOpen = isEating
    ? Math.abs(Math.sin(eatPhase * Math.PI * 8)) * 0.5 + 0.15
    : 0

  // 拒绝动画（摇头）
  const shakeX = isRejecting
    ? Math.sin(rejectPhase * Math.PI * 6) * (1 - rejectPhase) * 0.6
    : 0

  // 拖放悬停（身体微微放大 + 发光）
  const hoverScale = isDragOver ? 1.06 : 1
  const glowAlpha = isDragOver ? 0.15 : 0

  // 画矩形
  function r(x, y, wd, ht, color) {
    const rx = facingRight ? x : VW - x - wd
    const screenX = (rx - VW/2 + shakeX) * sx * unit * hoverScale + VW/2 * unit
    const screenY = (y - CY + bobY + eatBob) * sy * unit * hoverScale + CY * unit
    ctx.fillStyle = color
    ctx.fillRect(screenX, screenY, wd * sx * unit * hoverScale, ht * sy * unit * hoverScale)
  }

  ctx.clearRect(0, 0, w, h)

  // 拖放悬停光晕
  if (glowAlpha > 0) {
    ctx.fillStyle = `rgba(255,240,200,${glowAlpha})`
    ctx.beginPath()
    ctx.ellipse(VW/2 * unit, CY * unit, 5.5 * unit, 4 * unit, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  // 阴影
  ctx.fillStyle = 'rgba(0,0,0,0.10)'
  ctx.beginPath()
  ctx.ellipse(VW/2 * unit, (9.3 + bobY - CY) * sy * unit + CY * unit, 3.2 * unit, 0.25 * unit, 0, 0, Math.PI * 2)
  ctx.fill()

  // === 腿（2 条，站立）===
  const legLY = isWalking ? Math.sin(wPhase * 2 * Math.PI) * 0.3 : 0
  const legRY = isWalking ? Math.sin(wPhase * 2 * Math.PI + Math.PI) * 0.3 : 0
  // 左腿
  r(4.8, 7.8 + legLY, 1.2, 1.5, P.body)
  r(4.8, 9.0 + legLY, 1.2, 0.3, P.bodyShade)
  // 右腿
  r(8.0, 7.8 + legRY, 1.2, 1.5, P.body)
  r(8.0, 9.0 + legRY, 1.2, 0.3, P.bodyShade)

  // === 身体（白色）===
  r(3.8, 4.3, 6.4, 3.5, P.body)
  // 身体两侧阴影
  r(3.8, 4.5, 0.35, 3.2, P.bodyShade)
  r(9.85, 4.5, 0.35, 3.2, P.bodyShade)
  // 身体底部
  r(4.2, 7.45, 5.6, 0.4, P.bodyShade)

  // === 粉色衣服 ===
  // 衣服主体（覆盖上半身）
  r(3.6, 5.0, 6.8, 2.0, P.cloth)
  // 衣服高光
  r(4.0, 5.0, 6.0, 0.4, P.clothL)
  // 衣服阴影底边
  r(3.8, 6.7, 6.4, 0.35, P.clothD)
  // 领口弧线（用两段表示）
  r(4.5, 4.6, 5.0, 0.5, P.body)  // 领口露出白色
  // 领口装饰
  r(5.0, 5.0, 4.0, 0.2, P.clothL)

  // === 短手（2 只）===
  // 左臂
  r(3.3 + armSwing * 0.3, 5.4 + armSwing * 0.5, 0.7, 1.8, P.arm)
  r(3.0 + armSwing * 0.3, 7.0 + armSwing * 0.6, 0.8, 0.6, P.armShade) // 手掌
  // 右臂
  r(10.0 - armSwing * 0.3, 5.4 - armSwing * 0.5, 0.7, 1.8, P.arm)
  r(10.2 - armSwing * 0.3, 7.0 - armSwing * 0.6, 0.8, 0.6, P.armShade)

  // === 头部（白色）===
  r(4.2, 1.4, 5.6, 3.4, P.body)
  // 头顶圆润高光
  r(4.6, 1.4, 4.8, 0.5, '#FFFFFF')
  // 脸侧阴影
  r(4.2, 1.8, 0.3, 2.5, P.bodyShade)
  r(9.5, 1.8, 0.3, 2.5, P.bodyShade)
  // 下巴
  r(5.0, 4.4, 4.0, 0.4, P.bodyShade)

  // === 耳朵（尖椭圆，两只大耳朵）===
  // 左耳 — 用堆叠矩形模拟尖椭圆
  r(4.5 + earI, 0.1 - earB * 0.5, 1.8, 0.9, P.body)       // 耳根宽
  r(5.0 + earI, -0.3 - earB * 0.7, 1.2, 0.7, P.body)       // 耳中
  r(5.4 + earI, -0.7 - earB * 0.9, 0.7, 0.6, P.body)       // 耳尖
  // 左耳内侧粉
  r(5.2 + earI, 0.0 - earB * 0.55, 0.8, 0.6, P.earIn)
  r(5.6 + earI, -0.4 - earB * 0.75, 0.4, 0.4, P.earIn)

  // 右耳
  r(8.5 + earI, 0.1 - earB * 0.5, 1.8, 0.9, P.body)
  r(9.0 + earI, -0.3 - earB * 0.7, 1.2, 0.7, P.body)
  r(9.3 + earI, -0.7 - earB * 0.9, 0.7, 0.6, P.body)
  r(9.2 + earI, 0.0 - earB * 0.55, 0.8, 0.6, P.earIn)
  r(9.4 + earI, -0.4 - earB * 0.75, 0.4, 0.4, P.earIn)

  // === 眼圈（仅右眼有，红+棕，不超出镜框）===
  // 右眼红色部分（内侧）
  r(7.9, 2.55, 1.0, 1.55, P.eyeRingR)
  // 右眼棕色部分（外侧）
  r(8.9, 2.55, 0.7, 1.55, P.eyeRingBr)

  // === 眼镜（紫红镜框，无镜片）===
  // 左镜框
  r(4.95, 2.35, 2.4, 0.17, P.glasses)
  r(4.95, 4.13, 2.4, 0.17, P.glasses)
  r(4.95, 2.35, 0.18, 1.95, P.glasses)
  r(7.17, 2.35, 0.18, 1.95, P.glasses)
  // 鼻梁
  r(7.17, 3.0, 0.45, 0.17, P.glasses)

  // 右镜框
  r(7.72, 2.35, 2.4, 0.17, P.glasses)
  r(7.72, 4.13, 2.4, 0.17, P.glasses)
  r(7.72, 2.35, 0.18, 1.95, P.glasses)
  r(9.94, 2.35, 0.18, 1.95, P.glasses)

  // 镜腿
  r(4.6, 2.8, 0.4, 0.16, P.glasses)
  r(9.8, 2.8, 0.4, 0.16, P.glasses)

  // === 眼睛 ===
  if (!blinking) {
    r(5.5, 2.9, 0.85, 0.85, P.eye)
    r(5.6, 2.95, 0.3, 0.3, P.eyeHl)
    r(8.1, 2.9, 0.85, 0.85, P.eye)
    r(8.2, 2.95, 0.3, 0.3, P.eyeHl)
  } else {
    r(5.5, 3.28, 0.85, 0.14, P.eye)
    r(8.1, 3.28, 0.85, 0.14, P.eye)
  }

  // === 鼻子 ===
  r(6.5, 3.5, 0.8, 0.65, P.nose)
  r(6.55, 3.5, 0.3, 0.22, P.noseHl)

  // === 嘴巴 ===
  if (mouthOpen > 0.02) {
    // 咀嚼时嘴巴张大
    const mw = 0.22 + mouthOpen * 0.3
    const mh = 0.13 + mouthOpen * 0.8
    r(6.3, 4.15 - mouthOpen * 0.3, mw, mh, P.mouth)
    r(7.1, 4.15 - mouthOpen * 0.3, mw, mh, P.mouth)
    // 张开时中间加一条深色
    if (mouthOpen > 0.25) {
      r(6.6, 4.15 - mouthOpen * 0.3, 0.6, mouthOpen * 0.5, '#8a7060')
    }
  } else {
    r(6.3, 4.15, 0.22, 0.13, P.mouth)
    r(7.1, 4.15, 0.22, 0.13, P.mouth)
  }
}
