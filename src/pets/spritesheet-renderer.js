/**
 * spritesheet-renderer.js — Canvas 渲染 spritesheet 宠物
 *
 * 内部 3×3 (576×624): 每状态 1 帧，帧映射明确
 * Codex 8×9 (1536×1872): AI 生成的布局不规则，只有 Row 0 确认是 idle 序列
 *
 * Codex 策略:
 * - Row 0 用于 idle（像素分析确认帧间连续，可以做慢速动画）
 * - 其他状态使用对应行的 col 0 静态帧
 * - 可按 ↑↓←→ 调试键切换行列
 */

const INTERNAL_FRAME_MAP = {
  idle:     { col: 0, row: 0 },
  walk1:    { col: 1, row: 0 },
  working:  { col: 2, row: 0 },
  blink:    { col: 0, row: 1 },
  walk2:    { col: 1, row: 1 },
  jumping:  { col: 2, row: 1 },
  wave:     { col: 0, row: 2 },
  failed:   { col: 1, row: 2 },
  review:   { col: 2, row: 2 },
};

// Codex 行映射（默认假设，可以用调试键验证后调整）
const CODEC_FRAME_MAP = {
  idle:     { row: 0, animate: true },
  walk:     { row: 1 },
  working:  { row: 2 },
  waiting:  { row: 3 },
  running:  { row: 4 },
  jumping:  { row: 5 },
  wave:     { row: 6 },
  failed:   { row: 7 },
  review:   { row: 8 },
};

export class SpritesheetRenderer {
  constructor() {
    this._img = null;
    this._loaded = false;
    this._currentFrame = 'idle';
    this._currentCol = 0;
    this._timer = 0;
    this._frameTimer = 0;
    this._isCodex = false;
    this._cols = 3;
    this._rows = 3;

    // 调试模式: 设置非 null 直接指定行列
    this._debugRow = null;
    this._debugCol = null;
  }

  async load(src, petMeta) {
    return new Promise((resolve, reject) => {
      this._img = new Image();
      this._img.onload = () => {
        this._loaded = true;
        if (petMeta) {
          this._cols = petMeta.cols || 3;
          this._rows = petMeta.rows || 3;
          this._isCodex = (this._cols === 8 && this._rows === 9);
        } else {
          const w = this._img.naturalWidth;
          const h = this._img.naturalHeight;
          if (Math.abs(w - 1536) < 10 && Math.abs(h - 1872) < 10) {
            this._cols = 8; this._rows = 9; this._isCodex = true;
          } else {
            this._cols = 3; this._rows = 3; this._isCodex = false;
          }
        }
        resolve();
      };
      this._img.onerror = reject;
      this._img.src = src;
    });
  }

  get ready() { return this._loaded; }
  get frame() { return this._currentFrame; }
  get isCodex() { return this._isCodex; }

  /** Debug: directly set row/col */
  setDebugRow(r) { this._debugRow = r; }
  setDebugCol(c) { this._debugCol = c; }

  update(status, dt) {
    this._timer += dt;
    if (this._isCodex) {
      this._updateCodex(status, dt);
    } else {
      this._updateInternal(status, dt);
    }
  }

  _updateInternal(status, dt) {
    if (status.isFailed) {
      this._currentFrame = 'failed';
    } else if (status.isReviewing) {
      this._currentFrame = 'review';
    } else if (status.isJumping) {
      this._currentFrame = 'jumping';
    } else if (status.isWorking) {
      const phase = Math.floor(this._timer / 0.4) % 2;
      this._currentFrame = phase === 0 ? 'idle' : 'working';
    } else if (status.isWalking) {
      const phase = Math.floor(this._timer / 0.3) % 2;
      this._currentFrame = phase === 0 ? 'walk1' : 'walk2';
    } else {
      if (this._timer > 3.0 && this._timer < 3.2) {
        this._currentFrame = 'blink';
      } else if (this._timer >= 3.2) {
        this._timer = 0;
        this._currentFrame = 'idle';
      } else {
        this._currentFrame = 'idle';
      }
    }
  }

  _updateCodex(status, dt) {
    // 调试模式: 直接使用指定行列
    if (this._debugRow != null) {
      this._currentCol = this._debugCol ?? 0;
      return;
    }

    this._frameTimer += dt;
    const prev = this._currentFrame;

    if (status.isFailed) {
      this._currentFrame = 'failed';
    } else if (status.isReviewing) {
      this._currentFrame = 'review';
    } else if (status.isJumping) {
      this._currentFrame = 'jumping';
    } else if (status.isWorking) {
      this._currentFrame = 'working';
    } else if (status.isWalking) {
      this._currentFrame = 'running';
    } else {
      this._currentFrame = 'idle';
    }

    if (this._currentFrame !== prev) this._frameTimer = 0;

    // Codex spritesheet 帧间过渡不平滑，全部静态显示
    this._currentCol = 0;

    if (this._frameTimer > 60) this._frameTimer -= 60;
  }

  render(ctx, x, y, w, h, pet) {
    if (!this._loaded || !this._img) return;

    const fw = pet?.frameW || 192;
    const fh = pet?.frameH || 208;

    let sx, sy;

    if (this._debugRow != null) {
      sy = this._debugRow * fh;
      sx = (this._debugCol ?? 0) * fw;
    } else if (this._isCodex) {
      const map = CODEC_FRAME_MAP[this._currentFrame] || CODEC_FRAME_MAP.idle;
      sy = map.row * fh;
      sx = this._currentCol * fw;
    } else {
      const map = INTERNAL_FRAME_MAP[this._currentFrame] || INTERNAL_FRAME_MAP.idle;
      sx = map.col * fw;
      sy = map.row * fh;
    }

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.drawImage(this._img, sx, sy, fw, fh, x, y, w, h);
    ctx.restore();
  }

  reset() {
    this._timer = 0;
    this._frameTimer = 0;
    this._currentCol = 0;
    this._currentFrame = 'idle';
  }
}
