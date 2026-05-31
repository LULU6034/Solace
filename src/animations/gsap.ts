import gsap from 'gsap'

// Spring configs — tuned for 静屿 design system
export const Spring = {
  gentle: { duration: 0.45, ease: 'back.out(1.4)' },
  snappy: { duration: 0.3, ease: 'back.out(1.8)' },
  bouncy: { duration: 0.55, ease: 'elastic.out(1, 0.5)' },
  smooth: { duration: 0.35, ease: 'power2.out' },
  micro: { duration: 0.15, ease: 'power2.out' },
}

// Get current animation speed multiplier (respects quiet-mode / reduced-motion)
export function animSpeed(): number {
  const root = document.documentElement
  const v = getComputedStyle(root).getPropertyValue('--anim-speed').trim()
  return v ? parseFloat(v) : 1
}

// Animate element entrance from below
export function enterFromBelow(el: Element | Element[] | string, opts?: { stagger?: number; y?: number; duration?: number }) {
  const s = animSpeed()
  const stagger = opts?.stagger ?? 0.06
  const targets = typeof el === 'string' ? el : el
  return gsap.from(targets, {
    y: opts?.y ?? 20,
    opacity: 0,
    duration: (opts?.duration ?? Spring.snappy.duration) / s,
    ease: Spring.snappy.ease,
    stagger: stagger === 0 ? 0 : stagger / s,
  })
}

// Animate scale+fade entrance (dialogs, modals)
export function enterScaleIn(el: Element | string, opts?: { duration?: number; from?: number }) {
  const s = animSpeed()
  return gsap.from(el, {
    scale: opts?.from ?? 0.94,
    opacity: 0,
    duration: (opts?.duration ?? 0.4) / s,
    ease: 'back.out(1.3)',
  })
}

// Fade + slide from right (settings panels)
export function slideInRight(el: Element | string, opts?: { duration?: number }) {
  const s = animSpeed()
  return gsap.from(el, {
    x: '100%',
    duration: (opts?.duration ?? 0.35) / s,
    ease: Spring.snappy.ease,
  })
}

// Hover lift — imperatively called
export function hoverLift(el: Element, entering: boolean) {
  const s = animSpeed()
  gsap.to(el, {
    y: entering ? -2 : 0,
    boxShadow: entering
      ? '0 4px 16px rgba(62, 50, 42, 0.08)'
      : '0 1px 3px rgba(62, 50, 42, 0.04)',
    duration: Spring.micro.duration / s,
    ease: Spring.smooth.ease,
  })
}

// Press shrink
export function pressShrink(el: Element, pressing: boolean) {
  const s = animSpeed()
  gsap.to(el, {
    scale: pressing ? 0.97 : 1,
    duration: 0.1 / s,
    ease: 'power1.out',
  })
}

// Staggered list entrance
export function staggerList(selector: string, opts?: { from?: 'bottom' | 'left'; stagger?: number }) {
  const s = animSpeed()
  const from = opts?.from ?? 'bottom'
  const props: gsap.TweenVars = {
    opacity: 0,
    duration: 0.35 / s,
    ease: Spring.snappy.ease,
    stagger: (opts?.stagger ?? 0.05) / s,
  }
  if (from === 'bottom') props.y = 16
  if (from === 'left') props.x = -12
  return gsap.from(selector, props)
}

// Smooth scroll with spring physics
export function smoothScrollTo(el: Element | null, opts?: { duration?: number }) {
  if (!el) return
  const s = animSpeed()
  gsap.to(el, {
    scrollTop: el.scrollHeight,
    duration: (opts?.duration ?? 0.5) / s,
    ease: 'power2.out',
  })
}

// Fade in backdrop
export function fadeIn(el: Element | string, opts?: { duration?: number }) {
  const s = animSpeed()
  return gsap.from(el, {
    opacity: 0,
    duration: (opts?.duration ?? 0.2) / s,
    ease: 'power2.out',
  })
}

// Fade out and dispose
export async function fadeOut(el: Element, opts?: { duration?: number }): Promise<void> {
  const s = animSpeed()
  return new Promise(resolve => {
    gsap.to(el, {
      opacity: 0,
      duration: (opts?.duration ?? 0.15) / s,
      ease: 'power2.in',
      onComplete: resolve,
    })
  })
}

// Typing dots bounce — returns a timeline that loops
export function typingDots(el: string | Element): gsap.core.Timeline {
  const s = animSpeed()
  const tl = gsap.timeline({ repeat: -1 })
  tl.fromTo(el, { y: 0, opacity: 0.2 }, {
    y: -5, opacity: 0.5,
    duration: 0.42 / s,
    ease: 'power2.out',
    stagger: { each: 0.18 / s },
  })
  tl.to(el, {
    y: 0, opacity: 0.2,
    duration: 0.42 / s,
    ease: 'power2.in',
    stagger: { each: 0.18 / s },
  }, `-=${0.15 / s}`)
  return tl
}

// Pulse animation — subtle breathing
export function pulseInfinite(el: string | Element): gsap.core.Timeline {
  const s = animSpeed()
  const tl = gsap.timeline({ repeat: -1, yoyo: true })
  tl.to(el, {
    scale: 1.03,
    duration: 1.4 / s,
    ease: 'sine.inOut',
  })
  return tl
}

// Kill all animations on element (cleanup)
export function kill(el: Element | string) {
  gsap.killTweensOf(el)
}
