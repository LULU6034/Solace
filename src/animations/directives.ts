import type { Directive, ObjectDirective } from 'vue'
import gsap from 'gsap'
import { Spring, animSpeed } from './gsap'

// ── v-gsap-enter: spring entrance from below ──
export const vGsapEnter: ObjectDirective<HTMLElement, number | undefined> = {
  mounted(el, binding) {
    const s = animSpeed()
    const delay = binding.value ?? 0
    gsap.from(el, {
      y: 16,
      opacity: 0,
      duration: Spring.snappy.duration / s,
      delay: delay / s,
      ease: Spring.snappy.ease,
    })
  },
}

// ── v-gsap-hover: spring hover lift + press shrink ──
export const vGsapHover: ObjectDirective<HTMLElement> = {
  mounted(el) {
    const s = animSpeed()
    el.addEventListener('mouseenter', () => {
      gsap.to(el, {
        y: -2,
        boxShadow: '0 4px 16px rgba(62,50,42,0.08)',
        duration: Spring.micro.duration / s,
        ease: Spring.smooth.ease,
      })
    })
    el.addEventListener('mouseleave', () => {
      gsap.to(el, {
        y: 0,
        boxShadow: '0 1px 3px rgba(62,50,42,0.04)',
        duration: Spring.micro.duration / s,
        ease: Spring.smooth.ease,
      })
    })
    el.addEventListener('mousedown', () => {
      gsap.to(el, {
        scale: 0.97,
        duration: 0.08 / s,
        ease: 'power1.out',
      })
    })
    el.addEventListener('mouseup', () => {
      gsap.to(el, {
        scale: 1,
        duration: 0.12 / s,
        ease: 'back.out(1.7)',
      })
    })
    el.addEventListener('mouseleave', () => {
      gsap.to(el, { scale: 1, duration: 0.12 / s, ease: 'power2.out' })
    })
  },
}

// ── v-gsap-spring: spring-based hoverscale without lift ──
export const vGsapSpring: ObjectDirective<HTMLElement> = {
  mounted(el) {
    const s = animSpeed()
    el.addEventListener('mouseenter', () => {
      gsap.to(el, {
        scale: 1.06,
        duration: Spring.micro.duration / s,
        ease: 'back.out(1.7)',
      })
    })
    el.addEventListener('mouseleave', () => {
      gsap.to(el, {
        scale: 1,
        duration: Spring.micro.duration / s,
        ease: 'power2.out',
      })
    })
  },
}

// ── v-gsap-ripple: press feedback without scale (subtle) ──
export const vGsapPress: ObjectDirective<HTMLElement> = {
  mounted(el) {
    const s = animSpeed()
    el.addEventListener('mousedown', () => {
      gsap.to(el, {
        scale: 0.96,
        duration: 0.08 / s,
        ease: 'power1.in',
      })
    })
    el.addEventListener('mouseup', () => {
      gsap.to(el, {
        scale: 1,
        duration: 0.18 / s,
        ease: Spring.snappy.ease,
      })
    })
    el.addEventListener('mouseleave', () => {
      gsap.to(el, { scale: 1, duration: 0.1 / s, ease: 'power2.out' })
    })
  },
}
