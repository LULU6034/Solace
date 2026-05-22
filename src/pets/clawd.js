// 原版 Clawd 龙虾（从 PetApp.vue 抽出，保留原始 Canvas 2D 风格）

const CHAR = {
  name: 'Clawd',
  icon: '🦞',
  main: '#ff9f0a',
  light: '#ffcc66',
  dark: '#e89030',
  skin: '#f0c0a0',
  skinDark: '#d4a080',
  blush: 'rgba(255,150,150,0.3)',
}

export const clawd = {
  name: CHAR.name,
  icon: CHAR.icon,
  palette: CHAR,
}

export function drawClawd(ctx, w, h, time, opts = {}) {
  const { isWalking = false,
    isEating = false, eatPhase = 0,
    isRejecting = false, rejectPhase = 0,
    isDragOver = false } = opts
  const cx = w / 2
  const cy = h / 2 + 10
  const bob = Math.sin(time * 2) * 3
  const walkBob = isWalking ? Math.sin(time * 5) * 2 : 0
  const eatBob = isEating ? Math.sin(eatPhase * Math.PI * 3) * 4 : 0
  const effectiveBob = bob + walkBob + eatBob
  const blink = isEating ? true : Math.sin(time * 4) > 0.92
  const shakeX = isRejecting
    ? Math.sin(rejectPhase * Math.PI * 6) * (1 - rejectPhase) * 0.5
    : 0

  ctx.clearRect(0, 0, w, h)

  // 拖放悬停光晕
  if (isDragOver) {
    ctx.fillStyle = 'rgba(255,240,200,0.15)'
    ctx.beginPath()
    ctx.ellipse(cx, cy, 50, 48, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.save()
  if (shakeX) ctx.translate(shakeX * 5, 0)
  if (isDragOver) ctx.scale(1.06, 1.06)

  // 阴影
  ctx.fillStyle = `rgba(0,0,0,${Math.max(0.08, 0.15 - Math.abs(effectiveBob) * 0.015)})`
  ctx.beginPath()
  ctx.ellipse(cx, cy + 48 + effectiveBob, 28 - effectiveBob * 0.3, 7 - effectiveBob * 0.1, 0, 0, Math.PI * 2)
  ctx.fill()

  // 身体渐变
  const bg = ctx.createRadialGradient(cx - 8, cy - 3 + effectiveBob, 5, cx, cy + effectiveBob, 40)
  bg.addColorStop(0, CHAR.light)
  bg.addColorStop(0.6, CHAR.main)
  bg.addColorStop(1, CHAR.dark)
  ctx.fillStyle = bg
  ctx.beginPath()
  ctx.ellipse(cx, cy + effectiveBob, 38, 42, 0, 0, Math.PI * 2)
  ctx.fill()

  // 头部
  const hg = ctx.createRadialGradient(cx - 6, cy - 48 + effectiveBob, 5, cx, cy - 45 + effectiveBob, 32)
  hg.addColorStop(0, '#ffe0d0')
  hg.addColorStop(0.6, CHAR.skin)
  hg.addColorStop(1, CHAR.skinDark)
  ctx.fillStyle = hg
  ctx.beginPath()
  ctx.ellipse(cx, cy - 45 + effectiveBob, 33, 28, 0, 0, Math.PI * 2)
  ctx.fill()

  // 耳朵
  ctx.fillStyle = CHAR.skinDark
  ctx.beginPath(); ctx.ellipse(cx - 24, cy - 70 + effectiveBob, 9, 14, -0.2, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.ellipse(cx + 24, cy - 70 + effectiveBob, 9, 14, 0.2, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#ffb0a0'
  ctx.beginPath(); ctx.ellipse(cx - 24, cy - 70 + effectiveBob, 4, 8, -0.2, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.ellipse(cx + 24, cy - 70 + effectiveBob, 4, 8, 0.2, 0, Math.PI * 2); ctx.fill()

  // 眼睛
  if (!blink) {
    ctx.fillStyle = '#fff'
    ctx.beginPath(); ctx.ellipse(cx - 12, cy - 50 + effectiveBob, 6, 7, 0, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.ellipse(cx + 12, cy - 50 + effectiveBob, 6, 7, 0, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#444'
    ctx.beginPath(); ctx.ellipse(cx - 12, cy - 50 + effectiveBob, 4, 5, 0, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.ellipse(cx + 12, cy - 50 + effectiveBob, 4, 5, 0, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.beginPath(); ctx.arc(cx - 10, cy - 52 + effectiveBob, 2, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(cx + 14, cy - 52 + effectiveBob, 2, 0, Math.PI * 2); ctx.fill()
  } else {
    ctx.strokeStyle = '#555'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(cx - 16, cy - 50 + effectiveBob, 5, Math.PI, 0); ctx.stroke()
    ctx.beginPath(); ctx.arc(cx + 6, cy - 50 + effectiveBob, 5, Math.PI, 0); ctx.stroke()
  }

  // 腮红
  ctx.fillStyle = CHAR.blush
  ctx.beginPath(); ctx.ellipse(cx - 24, cy - 42 + effectiveBob, 8, 5, 0, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.ellipse(cx + 24, cy - 42 + effectiveBob, 8, 5, 0, 0, Math.PI * 2); ctx.fill()

  // 嘴巴
  ctx.strokeStyle = '#c07060'; ctx.lineWidth = 2
  ctx.beginPath(); ctx.arc(cx, cy - 36 + effectiveBob, 6, 0.1, Math.PI - 0.1); ctx.stroke()

  // 走路时的小腿
  if (isWalking) {
    ctx.fillStyle = CHAR.main
    const legPhase = Math.sin(time * 5)
    // 左腿
    ctx.beginPath(); ctx.ellipse(cx - 15, cy + 38 + effectiveBob + legPhase * 3, 6, 10, 0, 0, Math.PI * 2); ctx.fill()
    // 右腿
    ctx.beginPath(); ctx.ellipse(cx + 15, cy + 38 + effectiveBob - legPhase * 3, 6, 10, 0, 0, Math.PI * 2); ctx.fill()
  }

  ctx.restore()
}
