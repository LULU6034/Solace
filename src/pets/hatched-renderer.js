/**
 * hatched-renderer.js — Canvas 渲染 LLM 生成的像素精灵
 *
 * 支持 20×16（或其他）像素网格，4 帧动画，自动适配画布尺寸。
 */

/**
 * Render a single frame onto a canvas context
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} pet - hatched pet data
 * @param {string} frameId - 'idle0'|'idle1'|'walk1'|'walk2'
 * @param {number} [x=0]
 * @param {number} [y=0]
 * @param {number} [w] - target width (defaults to canvas width)
 * @param {number} [h] - target height (defaults to canvas height)
 */
export function renderHatchedPet(ctx, pet, frameId = 'idle0', x = 0, y = 0, w, h) {
  const frame = pet.sprite?.[frameId] || pet.sprite?.idle0;
  if (!frame) return;

  const gw = pet.gridW || 20;
  const gh = pet.gridH || 16;
  const tw = w || ctx.canvas.width;
  const th = h || ctx.canvas.height;
  const cellW = tw / gw;
  const cellH = th / gh;

  ctx.clearRect(x, y, tw, th);

  for (let row = 0; row < frame.length; row++) {
    for (let col = 0; col < frame[row].length; col++) {
      const color = frame[row][col];
      if (!color || color === 'transparent') continue;
      ctx.fillStyle = color;
      // +0.5px to prevent anti-aliasing gaps between cells
      ctx.fillRect(
        x + col * cellW,
        y + row * cellH,
        Math.ceil(cellW),
        Math.ceil(cellH)
      );
    }
  }
}

/**
 * Animation state manager for hatched pets
 */
export class HatchedPetAnimator {
  constructor() {
    this._current = 'idle0';
    this._timer = 0;
    this._idleCycle = 0;
  }

  /** Get current frame ID */
  get frame() { return this._current; }

  /**
   * Update animation state. Call once per frame (~60fps).
   * @param {object} pet
   * @param {object} status - { isWorking, isWalking, walkDir }
   * @param {number} dt - delta time in seconds
   */
  update(pet, status, dt) {
    this._timer += dt;

    if (status.isWalking) {
      // Walk cycle: alternate walk1/walk2 every 300ms
      const phase = Math.floor(this._timer / 0.3) % 2;
      this._current = phase === 0 ? 'walk1' : 'walk2';
    } else if (status.isWorking) {
      // Working: rapid idle cycle
      const phase = Math.floor(this._timer / 0.15) % 2;
      this._current = phase === 0 ? 'idle0' : 'idle1';
    } else {
      // Idle: slow blink cycle (2s idle, 0.15s blink)
      if (this._timer > 2.0 && this._timer < 2.15) {
        this._current = 'idle1';
      } else if (this._timer >= 2.15) {
        this._timer = 0;
        this._current = 'idle0';
      } else {
        this._current = 'idle0';
      }
    }
  }

  reset() {
    this._timer = 0;
    this._current = 'idle0';
  }
}

/**
 * Full-canvas convenience render with animation state
 */
export function renderHatchedFrame(ctx, pet, animator, status, dt) {
  animator.update(pet, status, dt);
  renderHatchedPet(ctx, pet, animator.frame);
}
