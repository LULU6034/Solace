/**
 * anim-orchestrator.js — GSAP Timeline 统一动画编排
 *
 * 遵循 gsap-timeline:
 *   - 主 Timeline + 嵌套子 Timeline
 *   - 标签 (label) 精确定位
 *   - 位置参数 ("<", "+=0.3") 控制编排
 *   - 支持 reverse() / timeScale() 调试
 */
import gsap from 'gsap';

let _master = null;
let _reducedMotion = false;

// 检查 reduced-motion
try {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  _reducedMotion = mq.matches;
  mq.addEventListener('change', e => { _reducedMotion = e.matches; });
} catch {}

function dur(s) { return _reducedMotion ? 0 : s; }

// ═══════════════════════════════════
//  创建主时间线 (单例)
// ═══════════════════════════════════

export function getMasterTimeline() {
  if (!_master) {
    _master = gsap.timeline({
      paused: true,
      defaults: {
        duration: 0.35,
        ease: 'power2.out',
      },
      onUpdate() {
        // 供调试: _master.progress() 0~1
      },
    });
  }
  return _master;
}

// ═══════════════════════════════════
//  页面切换 (哲学: 能量聚焦/弥散)
// ═══════════════════════════════════

export function animatePageSwitch(particles, fromPage, toPage, onMidPoint) {
  const tl = gsap.timeline({ defaults: { ease: 'power2.inOut' } });
  const cam = particles?.camera;

  // 1. 相机后退 + 粒子暗去 (0.4s, 并行)
  tl.addLabel('start');
  if (cam) {
    tl.to(cam.position, { z: 8, duration: dur(0.4) }, 'start');
  }
  if (particles?._shaderMat) {
    tl.to(particles._shaderMat.uniforms.uVolume, { value: 0, duration: dur(0.3) }, 'start');
    // 暗去: 通过 volume=0 间接降低 alpha
  }

  // 2. 中点: 切换页面配置 (0s, call)
  tl.call(() => {
    particles?.switchPage(toPage);
    onMidPoint?.();
  }, undefined, '>');

  // 3. 相机恢复 + 粒子亮回 (0.5s, 并行)
  tl.addLabel('reveal', '+=0');
  if (cam) {
    tl.to(cam.position, { z: 6.5, duration: dur(0.5), ease: 'power3.out' }, 'reveal');
  }
  if (particles?._shaderMat) {
    tl.to(particles._shaderMat.uniforms.uVolume, {
      value: 0.15, duration: dur(0.5), ease: 'power3.out',
    }, 'reveal');
  }

  return tl;
}

// ═══════════════════════════════════
//  侧边栏 (哲学: 玻璃呼吸)
// ═══════════════════════════════════

export function animateSidebarToggle(panelEl, indicatorEl, particles, opening) {
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
  const d = dur(0.35);

  if (opening) {
    tl.addLabel('start');
    // 1. 指示条流光 (0.2s)
    if (indicatorEl) {
      tl.fromTo(indicatorEl, { '--glow-opacity': 0 }, { '--glow-opacity': 1, duration: dur(0.2) }, 'start');
    }
    // 2. 面板滑入 + 粒子增亮 (0.35s)
    if (panelEl) {
      tl.fromTo(panelEl, { autoAlpha: 0, x: -24 }, { autoAlpha: 1, x: 0, duration: d, ease: 'back.out(1.3)' }, 'start+=0.15');
    }
    if (particles?._shaderMat) {
      tl.to(particles._shaderMat.uniforms.uVolume, { value: 0.25, duration: 0.3 }, '<');
      tl.to(particles._shaderMat.uniforms.uVolume, { value: 0.1, duration: 0.3 }, '>');
    }
  } else {
    tl.addLabel('start');
    if (panelEl) {
      tl.to(panelEl, { autoAlpha: 0, x: -24, duration: dur(0.2) }, 'start');
    }
    if (indicatorEl) {
      tl.to(indicatorEl, { '--glow-opacity': 0, duration: dur(0.3) }, 'start');
    }
    if (particles?._shaderMat) {
      tl.to(particles._shaderMat.uniforms.uVolume, { value: 0.25, duration: 0.15 }, 'start');
      tl.to(particles._shaderMat.uniforms.uVolume, { value: 0.0, duration: 0.3 }, '>');
    }
  }

  return tl;
}

// ═══════════════════════════════════
//  情绪切换 (哲学: 气候漂移)
// ═══════════════════════════════════

export function animateEmotionSwitch(particles, toEmotion, dotEl, labelEl) {
  const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });
  const d = dur(1.2);

  tl.addLabel('start');

  // 1. 粒子核心色过渡 (1.2s) — 已由 unified-particles 内部处理
  tl.call(() => particles?.updateEmotion(toEmotion), undefined, 'start');

  // 2. 情绪指示点脉冲 (0.2s)
  if (dotEl) {
    tl.fromTo(dotEl, { scale: 0.8 }, { scale: 1.4, duration: dur(0.1) }, 'start');
    tl.to(dotEl, { scale: 1, duration: dur(0.15), ease: 'elastic.out(1, 0.3)' }, '>');
  }

  // 3. 标签淡换
  if (labelEl) {
    tl.fromTo(labelEl, { autoAlpha: 0 }, { autoAlpha: 1, duration: dur(0.3) }, 'start+=0.1');
  }

  return tl;
}

// ═══════════════════════════════════
//  弹窗/模态 (哲学: 能量注入)
// ═══════════════════════════════════

export function animateModal(el, opening, particles) {
  const tl = gsap.timeline({ defaults: { ease: 'back.out(1.3)' } });

  if (opening) {
    tl.addLabel('start');
    tl.fromTo(el, { autoAlpha: 0, scale: 0.93, y: 10 }, {
      autoAlpha: 1, scale: 1, y: 0, duration: dur(0.3),
    }, 'start');
    // 粒子短暂增亮
    if (particles?._shaderMat) {
      tl.to(particles._shaderMat.uniforms.uVolume, { value: 0.3, duration: 0.1 }, 'start');
      tl.to(particles._shaderMat.uniforms.uVolume, { value: 0.05, duration: 0.4 }, '>');
    }
  } else {
    tl.to(el, { autoAlpha: 0, scale: 0.95, y: 4, duration: dur(0.15), ease: 'power2.in' });
  }

  return tl;
}

// ═══════════════════════════════════
//  消息浮现 (哲学: 粒子凝聚)
// ═══════════════════════════════════

export function animateMessageIn(el, index = 0) {
  return gsap.timeline()
    .fromTo(el, { autoAlpha: 0, y: 16, scale: 0.92, filter: 'blur(6px)' }, {
      autoAlpha: 1, y: 0, scale: 1, filter: 'blur(0px)',
      duration: dur(0.35), delay: index * 0.05,
      ease: 'back.out(1.2)',
    }, 0);
}

export function animateMessageOut(el) {
  return gsap.to(el, {
    autoAlpha: 0, y: -8, scale: 0.94, duration: dur(0.2), ease: 'power2.in',
  });
}

// ═══════════════════════════════════
//  Utility
// ═══════════════════════════════════

export function isReducedMotion() { return _reducedMotion; }
