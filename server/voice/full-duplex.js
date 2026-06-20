/**
 * 全双工语音会话管理器
 *
 * 管理端到端的全双工语音交互：
 *   麦克风 PCM → VAD 分段 → DashScope 实时 ASR → Agent 对话 → MiniMax TTS → 音频流回前端
 *
 * 打断逻辑:
 *   Agent 说话时，新语音检测到 → 立即中断 TTS → 切换聆听
 *
 * 状态机:
 *   IDLE → LISTENING → THINKING → SPEAKING → IDLE
 *              ↑            ↑           │
 *              └── 打断 ────┘           │
 *              ↑←──────────────────────┘ (回复完成)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VAD, LightVAD } from './vad-node.js';
import { createRealtimeASR } from './dashscope-asr.js';
import { MiniMaxTTS, polishForTTS, cleanDisplayText } from './minimax-tts.js';
import { createModuleLogger } from '../lib/debug-log.js';
import { setLastPlayedSong, clearLastPlayedSong } from '../tools/music-tools.js';
import { isCircuitClosed, recordSuccess, recordFailure } from './circuit-breaker.js';

const log = createModuleLogger('full-duplex');

// ── 状态常量 ──
const STATE = {
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
};

export class FullDuplexSession {
  /**
   * @param {object} opts
   * @param {string} opts.sessionId
   * @param {object} opts.config - Agent/LLM 配置 (含 apiKey, minimaxApiKey, dashscopeApiKey)
   * @param {function} opts.sendToClient - (data: object) => void — 发 JSON 消息到前端
   * @param {function} opts.sendAudioToClient - (buffer: Buffer, isLast: boolean, text: string) => void — 发 TTS 音频到前端
   * @param {function} opts.runAgent - (messages, config) => AsyncGenerator — Agent 流式调用
   */
  constructor(opts = {}) {
    this.sessionId = opts.sessionId || `fd_${Date.now()}`;
    this.config = opts.config || {};
    this.sendToClient = opts.sendToClient || (() => {});
    this.sendAudioToClient = opts.sendAudioToClient || (() => {});
    this.runAgent = opts.runAgent || null;

    this.state = STATE.IDLE;
    this.turnCount = 0;
    this.conversationHistory = [];
    this._lastInteractionTime = 0;  // 上次交互时间戳
    // 尝试从文件恢复对话历史
    this._restoreHistory();
    this._lastRms = 0;
    this._lastZcr = 0;
    this._asrTextLen = 0;
    this._pendingResolve = null; // 事件驱动: ASR 文本到达时 resolve
    this._processingSpeech = false;
    this.lastPlayedSong = null;  // { songId, name, artist } — 当前播放的歌曲
    this._isPlaying = false;     // 前端实际播放状态（由 music_status 事件同步）
    this._interruptedContext = null;  // 被打断时未说完的话

    // ── 音色/情绪追踪 ──
    this._voiceProfile = {
      emotion: 'neutral',       // 最近一次 Deepgram 情绪
      emotionConf: 0,
      volume: 'normal',         // soft / normal / loud
      speed: 'normal',          // slow / normal / fast
      turnsSinceUpdate: 0,
    };

    log.log(`[创建] session=${this.sessionId} provider=${this.config.provider} hasASR=${!!(this.config.dashscopeApiKey || this.config.deepgramApiKey)} hasTTS=${!!this.config.minimaxApiKey}`);

    // 启动 Deepgram 持续连接
    setTimeout(() => this._startASR(), 100);

    // TTS
    this.tts = new MiniMaxTTS({ apiKey: this.config.minimaxApiKey || '' });

    // ASR (按需创建)
    this.asr = null;
    this.asrReady = false;
    this._emotionAsr = null;  // Deepgram 情绪引擎（与主 ASR 并行）

    this._flushTimer = null;
    this._silenceTimer = null;

    // VAD
    this.vad = new VAD({
      sampleRate: 16000,
      speechThreshold: 800,    // 降低阈值：更敏感（默认500，平衡灵敏度与抗噪）
      silenceTimeoutMs: 1000,  // 静音1秒算结束（给用户留自然停顿）
      minSpeechMs: 250,        // 降低最短语音：短词如"好""停"也能检测
      onSpeechStart: () => this._onSpeechStart(),
      onSpeechEnd: (audio) => this._onSpeechEnd(audio),
    });

    // 打断检测
    this.lightVad = new LightVAD({ sampleRate: 16000, speechThreshold: 800 });

    // 打断相关
    this.currentTtsAbort = null; // AbortController for current TTS
    this.pendingAudioFrames = []; // 待发送的 TTS 帧（用于流式中断）
    this._ttsPreRoll = [];        // TTS 播放期间缓存的麦克风帧（打断后补发）
    this._ttsTailUntil = 0;       // TTS 结束后的静默期（防止扬声器回声）

    // 计时器
    this.idleTimer = null;
    this.thinkTimer = null;
  }

  // 实时音频缓冲：攒到 100ms (3200 bytes) 再发，匹配 ASR 期望
  _asrBuffer = Buffer.alloc(0);
  _debugFrameCount = 0;
  _debugLastLog = Date.now();

  /**
   * 接收前端发来的 PCM 音频帧，实时转发给 ASR
   */
  feedAudio(pcmChunk) {
    this._debugFrameCount++;
    // 仅在异常状态时输出调试（state != IDLE 或 processing 卡住超 30s）
    const now = Date.now();
    if (this.state !== STATE.IDLE && now - this._debugLastLog > 30000) {
      log.log(`[调试] feedAudio: ${this._debugFrameCount} 帧 in 30s, state=${this.state}, asrReady=${!!this.asr?.isReady?.()}, _processingSpeech=${this._processingSpeech}`);
      this._debugFrameCount = 0;
      this._debugLastLog = now;
    } else if (this.state === STATE.IDLE) {
      this._debugLastLog = now; // idle 时重置计时，不输出
    }

    // TTS 尾部静默：TTS 播放完 2 秒内不发音频给 ASR，防止扬声器回声
    if (this.state === STATE.IDLE && Date.now() < this._ttsTailUntil) {
      this.vad.feed(pcmChunk);
      // 用户真说话了 → 取消静默，正常处理
      if (this.state === STATE.LISTENING) {
        this._ttsTailUntil = 0;
      } else {
        return;
      }
    }

    // 打断检测 + TTS 预滚缓冲（Lumi OS 风格：保留打断前最后一个音节）
    if (this.state === STATE.SPEAKING) {
      // 预滚缓冲：保留最近 6 帧（~384ms），打断后补发给 ASR
      this._ttsPreRoll.push(pcmChunk);
      if (this._ttsPreRoll.length > 6) this._ttsPreRoll.shift();

      this.lightVad.isSpeech(pcmChunk);
      if (this.lightVad.isUserSpeaking(5)) {  // 100ms连续语音即可打断（原来8帧=160ms）
        log.log(`打断检测：用户开始说话 (预滚缓冲=${this._ttsPreRoll.length}帧)`);
        this._interruptTTS();
        this.state = STATE.LISTENING;
        this.lightVad.reset();
        this._ttsEchoCache = [];  // 清除回声缓存，打断后的语音不可能是回声
        this._ttsTailUntil = 0;   // 取消 TTS 静默期
        this._notifyClient('interrupted', { reason: 'user_speech' });
        this.vad.reset();
        this._asrBuffer = Buffer.alloc(0);
        this._startASR();
        // 补发预滚缓冲帧，避免丢失用户第一个音节
        const preRoll = [...this._ttsPreRoll];
        this._ttsPreRoll = [];
        // 等 ASR 就绪后补发
        const flushPreRoll = () => {
          if (this.asr?.isReady?.()) {
            for (const chunk of preRoll) this.asr.sendAudio(chunk);
            log.log(`[预滚] 已补发 ${preRoll.length} 帧`);
          } else {
            setTimeout(flushPreRoll, 100);
          }
        };
        setTimeout(flushPreRoll, 300);
      }
      if (this.state === STATE.SPEAKING) return;
    } else {
      this._ttsPreRoll = [];
    }

    // 主 ASR 引擎（DashScope 或 Deepgram）
    if (this.asr?.isReady?.()) {
      // 先清空积压缓冲
      while (this._asrBuffer.length >= 3200) {
        this.asr.sendAudio(this._asrBuffer.subarray(0, 3200));
        this._asrBuffer = this._asrBuffer.subarray(3200);
      }
      this.asr.sendAudio(pcmChunk);
    } else {
      // ASR 未就绪时缓存音频，连接恢复后补发
      this._asrBuffer = Buffer.concat([this._asrBuffer, pcmChunk]);
      // 防止缓冲区无限增长（保留最近 3 秒）
      if (this._asrBuffer.length > 96000) {  // 16kHz * 2 bytes * 3s
        this._asrBuffer = this._asrBuffer.subarray(this._asrBuffer.length - 64000);
      }
    }
    // 并行情绪引擎（Deepgram，仅当主引擎是 DashScope 时启用）
    if (this._emotionAsr?.isReady?.()) {
      this._emotionAsr.sendAudio(pcmChunk);
    }

    // VAD 分帧
    if (this.state === STATE.LISTENING || this.state === STATE.IDLE) {
      this.vad.feed(pcmChunk);
    }
  }

  /**
   * 刷新：前端 WebSocket 关闭时调用
   * 发送剩余音频，清理 ASR
   */
  close() {
    clearInterval(this._flushTimer);
    clearTimeout(this._silenceTimer);
    const remaining = this.vad.flush();
    if (remaining) {
      this._onSpeechEnd(remaining);
    }
    this.asr?.close();
    this._emotionAsr?.close();
    this._clearTimers();
    this.state = STATE.IDLE;
    log.log(`全双工会话关闭: ${this.sessionId}`);
  }

  // ── 状态回调 ──

  _onSpeechStart() {
    log.log(`[VAD] 语音开始`);
    this.state = STATE.LISTENING;
    this._notifyClient('state', { state: STATE.LISTENING });
  }

  _onSpeechEnd(audioBuffer) {
    // 提取音色特征（音量/语速/音高），更新声纹描述
    if (!audioBuffer || audioBuffer.length < 3200) return;
    const duration = audioBuffer.length / 32000; // 秒
    const rms = this._computeRms(audioBuffer);
    const zcr = this._computeZcr(audioBuffer);

    // 音量分级（阈值配合 speechThreshold=800 调整）
    if (rms < 1000) this._voiceProfile.volume = 'soft';
    else if (rms > 5000) this._voiceProfile.volume = 'loud';
    else this._voiceProfile.volume = 'normal';

    // 语速分级（基于音节密度 ≈ ZCR 作为代理 + 时长）
    const sylPerSec = zcr * 10 / Math.max(duration, 0.5);
    if (sylPerSec > 8) this._voiceProfile.speed = 'fast';
    else if (sylPerSec < 3) this._voiceProfile.speed = 'slow';
    else this._voiceProfile.speed = 'normal';

    // 递增轮次计数
    this._voiceProfile.turnsSinceUpdate++;

    log.log(`[音色] vol=${this._voiceProfile.volume} speed=${this._voiceProfile.speed} rms=${rms} zcr=${zcr} dur=${duration.toFixed(1)}s`);
  }

  _computeZcr(buf) {
    if (!buf || buf.length < 4) return 0;
    let zcr = 0;
    for (let i = 2; i < buf.length - 1; i += 2) {
      const prev = buf.readInt16LE(i - 2);
      const curr = buf.readInt16LE(i);
      if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) zcr++;
    }
    return Math.round(zcr / (buf.length / 2) * 10000) / 10000;
  }

  // ── ASR ──

  async _startASR() {
    if (this.asr?.isReady?.()) return; // 已就绪，不重复创建
    if (this._asrConnecting) return;   // 正在连接中
    this._asrConnecting = true;

    // 共享回调（Deepgram 和 DashScope 接口一致）
    const callbacks = {
      onResult: (result) => {
        if (!result.isFinal) {
          this._notifyClient('asr_partial', { text: result.text });
        } else {
          this._notifyClient('asr_confirm', { text: result.text });
          setTimeout(() => { this._processTextAsync(result.text).catch(e => log.error('语音处理异常:', e.message)); }, 400);
        }
      },
      onEmotion: (emo) => {
        log.log(`[ASR情绪] ${emo.tag} (${emo.confidence})`);
        this._voiceProfile.emotion = emo.tag;
        this._voiceProfile.emotionConf = emo.confidence;
        this._voiceProfile.turnsSinceUpdate = 0;
        this._notifyClient('emotion', { emotion: emo.tag, confidence: emo.confidence });
      },
      onError: (err) => {
        log.error('ASR 错误:', err.message);
        this._notifyClient('error', { message: `ASR 错误: ${err.message}` });
      },
      onClose: () => {
        this.asrReady = false;
        if (this._reconnectTimer) return;
        log.log('[ASR] 断开，5s后重连');
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          this._startASR();
        }, 5000);
      },
    };

    // ── 自动选择 ASR 引擎：DashScope (中文识别+热词) + Deepgram (情绪) ──
    const dsKey = this.config.dashscopeApiKey || '';
    const dgKey = this.config.deepgramApiKey || '';

    const flushBuffer = () => {
      while (this._asrBuffer.length >= 3200) {
        this.asr.sendAudio(this._asrBuffer.subarray(0, 3200));
        this._asrBuffer = this._asrBuffer.subarray(3200);
      }
    };

    // 优先 DashScope Paraformer（阿里云中文专优）
    if (dsKey && isCircuitClosed('dashscope')) {
      log.log('[ASR] 连接 DashScope (Paraformer)...');
      try {
        const { createRealtimeASR } = await import('./dashscope-asr.js');
        // 日常语音热词（含大量口语近音表达，提升 ASR 容错）
        const MUSIC_HOTWORDS = [
          // ═══ 单字词（最高频，最易被误识别）═══
          '嗯','啊','哦','呃','唉','咦','哇','呀','哈','嘿','喂','啧','哼','嘶','哎',
          '好','行','对','是','不','要','能','会','有','在','没',
          '来','去','看','听','说','想','做','拿','给','吃','喝',
          '走','跑','坐','站','睡','醒','开','关','停','放','换','切',
          '大','小','多','少','快','慢','热','冷','高','低','亮','暗',
          '新','旧','上','下','左','右','前','后','里','外','这','那','谁','哪','几','怎',
          // ═══ 双字词（高频短语，短上下文最易错）═══
          '你好','是的','不是','好的','可以','不行','对的','错了','好吧','行吧',
          '什么','怎么','为什么','哪里','多少','几个','哪个','哪儿','干嘛','咋了',
          '现在','马上','刚才','已经','还没','一直','总是','经常','从来','偶尔',
          '突然','终于','果然','难道','到底','究竟','反正','居然','竟然',
          '真的','假的','还好','还行','不错','很棒','厉害','太棒了',
          '过来','过去','上去','下来','进去','出来','回去','起来',
          '打开','关上','拿起','放下','坐下','站起','躺下','走开',
          // ═══ 音乐指令 + 近音表达 ═══
          '换一首歌','下一首','再换一首','换歌','切歌','换一个','再换一个','换个歌',
          '换一下','换首歌','来首别的','不要这首','换掉','跳过','不听这个',
          '来首类似的','换首类似的','差不多风格的','相似风格的','类似的歌','来一首差不多的',
          '有没有像这首一样的','差不多感觉的','类似的还有吗','换一首差不多的',
          '放首歌','放音乐','放歌','播歌','来首歌','想听歌','来点音乐','播一首','放一首',
          '听歌','听音乐','来点歌','放点歌','随便放一首','来一首歌',
          '暂停','停一下','别放了','停下','停了','先停','停一停','不要放了',
          '继续','接着放','继续放','接着播','继续播','接着来','继续吧','往下放',
          '推荐','播放','换一首','来一首','上一首','下一首','前一首','后一首',
          '单曲循环','随机播放','循环','随机','快进','快退','顺序播放','列表循环',
          '声音大点','声音小点','太大声了','太小声了','听到不到','听不清',
          // ═══ 常见歌手/歌名 ═══
          '薛之谦','周杰伦','林俊杰','陈奕迅','邓紫棋','刘惜君','周深','许嵩','赵雷',
          '毛不易','李荣浩','张靓颖','五月天','苏打绿','王菲','张学友','刘德华',
          '聊表心意','演员','晴天','稻香','七里香','夜曲','告白气球',
          '好久不见','十年','光年之外','泡沫','起风了','成都','南山南',
          // ═══ 系统/设备 ═══
          '打开','关闭','设置','音量','大点声','小点声','声音大一点','声音小一点',
          '静音','亮度','截图','锁屏','关掉','开启','调一下','调暗一点','调亮一点',
          '重启','关机','睡眠','休眠','充电','省电模式','全屏','窗口',
          // ═══ 时间/天气 ═══
          '几点了','今天','明天','昨天','星期几','天气预报','多少度','下雨','降温',
          '下雪','天晴','热不热','冷不冷','外面冷吗','外面热吗','会下雨吗',
          '今天天气','明天天气','后天','大后天','上午','下午','晚上','早上','中午',
          '最近天气','周末天气','带伞','穿什么','刮风',
          // ═══ 日常对话 ═══
          '早上好','晚安','再见','谢谢你','对不起','没关系','没事','不用谢',
          '辛苦了','在吗','听到了吗','怎么样','好不好','行不行','对不对',
          '知道了','明白了','懂了','没问题','别急','慢慢来',
          '你说什么','再说一遍','没听清','什么意思','听不懂','重新说',
          // ═══ 生活场景 ═══
          '吃饭','睡觉','上班','下班','周末','放假','今天吃什么','休息','累了',
          '出门','回来了','出去了','等一下','快点','等会儿',
          '洗澡','起床','到家了','走了','拜拜','我走了','我回来了',
          '上班了','下班了','到家了','在路上','堵车','迟到了',
          '刷牙','洗脸','做饭','洗碗','打扫','洗衣服','倒垃圾',
          // ═══ 情绪/状态 ═══
          '开心','难过','无聊','想你了','陪我聊聊','讲个笑话','夸我',
          '好烦','好累','好困','不舒服','高兴','气死我了','好无聊','好饿',
          '心情不好','心情好','紧张','害怕','生气','委屈','感动','兴奋','期待',
          // ═══ 聊天话题 ═══
          '讲个故事','聊聊天','陪我说话','猜谜语','脑筋急转弯',
          '最近怎么样','今天过得怎么样','有什么新闻','好玩的事',
          '你喜欢什么','你是谁','你叫什么','你能做什么','你会什么',
          // ═══ 搜索/查询 ═══
          '帮我查一下','搜索','查一查','找一下','帮我找','百度一下',
          '是什么意思','解释一下','告诉我','介绍一下','科普一下',
        ].join(',');
        // DashScope 只做文字识别，不发情绪（情绪由 Deepgram 负责）
        this.asr = createRealtimeASR({
          apiKey: dsKey,
          hotwords: this.config.hotwords || MUSIC_HOTWORDS,
          onResult: callbacks.onResult,
          onError: callbacks.onError,
          onClose: callbacks.onClose,
          onEmotion: () => {},  // 忽略 Paraformer 的三分类情绪
        });
        await this.asr.connect();
        recordSuccess('dashscope');
        this.asrReady = true;
        this._asrConnecting = false;
        log.log('[ASR] DashScope 已就绪 (中文识别)');
        flushBuffer();
        // 如有 Deepgram Key，并行启动情绪引擎
        if (dgKey && isCircuitClosed('deepgram')) this._startEmotionASR(dgKey);
        return;
      } catch (err) {
        recordFailure('dashscope', err);
        log.warn(`[ASR] DashScope 连接失败: ${err.message}，fallback Deepgram`);
      }
    }

    // Fallback: Deepgram 同时做文字+情绪
    if (dgKey && isCircuitClosed('deepgram')) {
      log.log('[ASR] 连接 Deepgram (文字+情绪)...');
      try {
        const { createDeepgramASR } = await import('./deepgram-asr.js');
        this.asr = createDeepgramASR({ apiKey: dgKey, ...callbacks });
        await this.asr.connect();
        recordSuccess('deepgram');
        this.asrReady = true;
        this._asrConnecting = false;
        log.log('[ASR] Deepgram 已就绪');
        flushBuffer();
      } catch (err) {
        recordFailure('deepgram', err);
        log.error('ASR 连接失败:', err.message);
        this.asrReady = false;
        this._asrConnecting = false;
        this._notifyClient('error', { message: `ASR 连接失败: ${err.message}` });
      }
    } else if (!dgKey) {
      log.warn('[ASR] 缺少所有 ASR Key');
      this._asrConnecting = false;
    } else {
      log.warn('[ASR] Deepgram 已被熔断，暂时跳过');
      this._asrConnecting = false;
    }
  }

  /** 并行启动 Deepgram 情绪引擎（仅情绪，不处理文字） */
  async _startEmotionASR(dgKey) {
    if (this._emotionAsr?.isReady?.()) return;
    log.log('[ASR] 连接 Deepgram (情绪引擎)...');
    try {
      const { createDeepgramASR } = await import('./deepgram-asr.js');
      this._emotionAsr = createDeepgramASR({
        apiKey: dgKey,
        onResult: () => {},  // 忽略文字结果，只取情绪
        onEmotion: (emo) => {
          log.log(`[情绪] ${emo.tag} (${emo.confidence})`);
          this._voiceProfile.emotion = emo.tag;
          this._voiceProfile.emotionConf = emo.confidence;
          this._voiceProfile.turnsSinceUpdate = 0;
          this._notifyClient('emotion', { emotion: emo.tag, confidence: emo.confidence });
        },
        onError: (err) => log.warn('[情绪] Deepgram 错误:', err.message),
        onClose: () => {
          log.log('[情绪] Deepgram 断开，10s后重连');
          this._emotionAsr = null;
          setTimeout(() => {
            if (this.asr?.isReady?.()) this._startEmotionASR(dgKey);
          }, 10000);
        },
      });
      await this._emotionAsr.connect();
      log.log('[ASR] Deepgram 情绪引擎已就绪');
    } catch (err) {
      log.warn('[ASR] Deepgram 情绪引擎启动失败:', err.message);
    }
  }

  _computeRms(buf) {
    if (!buf || buf.length < 2) return 0;
    let s = 0;
    for (let i = 0; i < buf.length - 1; i += 2) s += buf.readInt16LE(i) ** 2;
    return Math.round(Math.sqrt(s / (buf.length / 2)));
  }

  /** 从音频声学特征检测情绪 */
  _detectEmotionFromAudio(audioBuffer) {
    if (!audioBuffer || audioBuffer.length < 3200) return 'neutral'; // < 100ms

    // 1. RMS（音量）
    let sumSq = 0;
    for (let i = 0; i < audioBuffer.length - 1; i += 2) {
      const sample = audioBuffer.readInt16LE(i);
      sumSq += sample * sample;
    }
    const rms = Math.round(Math.sqrt(sumSq / (audioBuffer.length / 2)));
    this._lastRms = rms;

    // 2. 零交叉率（ZCR，音高代理）
    let zcr = 0;
    for (let i = 2; i < audioBuffer.length - 1; i += 2) {
      const prev = audioBuffer.readInt16LE(i - 2);
      const curr = audioBuffer.readInt16LE(i);
      if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) zcr++;
    }
    const zcrRate = zcr / (audioBuffer.length / 2); // 归一化
    this._lastZcr = Math.round(zcrRate * 10000) / 10000;

    // 3. 语速（时长）
    const duration = audioBuffer.length / 32000; // 秒

    // 分类逻辑
    if (rms < 800) return 'whisper';      // 很轻 → 耳语
    if (rms > 12000) return 'excited';    // 很大声 → 激动/愤怒
    if (rms > 6000 && zcrRate > 0.15) return 'angry';   // 大声+高音 → 愤怒
    if (rms > 5000 && zcrRate > 0.12) return 'happy';   // 中高声+偏高音 → 开心
    if (rms < 2000 && zcrRate < 0.08) return 'sad';     // 轻声+低音 → 难过
    if (duration > 4 && zcrRate < 0.06) return 'tired';  // 长+低音 → 疲惫
    if (zcrRate > 0.14) return 'anxious'; // 高音 → 紧张
    return 'neutral';
  }

  // 回声消除：最近 TTS 输出缓存
  _ttsEchoCache = [];

  // ── 领域音近纠错表（从 ASR 日志中收集的系统性误识别）──
  _PHONETIC_FIXES = [
    // 聊表心意（从日志持续补充变体）
    [/鸟表[心深情]意/g, '聊表心意'],
    [/秒表心意/g, '聊表心意'],
    [/秒表信念/g, '聊表心意'],
    [/渺表心意/g, '聊表心意'],
    [/签的表表心意/g, '聊表心意'],
    [/鸟表情/g, '聊表心意'],
    [/鸟表深意/g, '聊表心意'],
    [/表[白深]心意/g, '聊表心意'],
    // 薛之谦
    [/薛志谦/g, '薛之谦'],
    [/薛知谦/g, '薛之谦'],
    [/薛之聪/g, '薛之谦'],
    // 音乐指令
    [/换手内侍的/g, '来首类似的'],
    [/患手内侍的/g, '来首类似的'],
    [/来守累死的/g, '来首类似的'],
    [/再画一锁/g, '再换一首'],
    [/再患一首/g, '再换一首'],
  ];

  _correctASRErrors(text) {
    let result = text;
    for (const [pattern, replacement] of this._PHONETIC_FIXES) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  /** 处理识别文本（含唤醒、快捷指令、打断、回声过滤） */
  async _processTextAsync(text) {
    if (!text?.trim() || this._processingSpeech) return;
    const trimmed = text.trim();
    log.log(`[语音] "${trimmed}"`);

    // ── 回声消除 ──
    const norm = trimmed.replace(/\s/g,'').toLowerCase();
    for (const e of this._ttsEchoCache) {
      if (Date.now() > e.until) continue;
      if (e.text.includes(trimmed) || trimmed.includes(e.text)) { log.log('[回声] 忽略'); return; }
      const en = e.text.replace(/\s/g,'').toLowerCase();
      let o = 0; for (const c of new Set(norm)) { if (new Set(en).has(c)) o++; }
      if (o / new Set(norm).size > 0.7) { log.log('[回声] 忽略'); return; }
    }

    // ── Lumi OS 风格语气词过滤：单字中文感叹词直接丢弃 ──
    if (/^[嗯啊哦呃哼唉呀哈呵嗨喂诶唔嘶啧哎哟嘿嘛哇啦嘞][。！？.!?，,～~]*$/.test(trimmed)) {
      log.log(`[过滤] 语气词: "${trimmed}"`);
      return;  // 不设 _processingSpeech，直接返回
    }
    // ── 纯噪声过滤：不含中文/字母/数字 → 丢弃 ──
    if (!/[a-zA-Z一-鿿\d]/.test(trimmed)) {
      log.log(`[过滤] 纯噪声: "${trimmed}"`);
      return;
    }

    this._processingSpeech = true;
    try {
      // ── 唤醒词（含 ASR 音近变体，Lumi 风格密集覆盖）──
      const wakeWords = [
        '白昼', '嘿 白昼', 'hey 白昼', '嘿 sonder', 'sonder', '静屿', '嘿 静屿', 'hey 静屿',
        // ASR 变体
        '白粥', '摆昼', '百昼', '白轴', '白昼的', '黑昼', '白昼啊',
        '嘿白粥', '黑 白昼', '嗨 白昼', 'hi 白昼', '嘿 白轴',
      ];
      const lower = trimmed.toLowerCase();
      const matchedWake = wakeWords.find(w => lower.includes(w));
      if (matchedWake) {
        const rest = lower.replace(matchedWake, '').trim();
        if (!rest) {
          this._notifyClient('subtitle', { role: 'user', text: '唤醒', turnId: ++this.turnCount });
          this._notifyClient('state', { state: STATE.LISTENING });
          this.state = STATE.LISTENING;
          this._speakResponse('我在呢。');
          return;
        }
        // 唤醒词 + 指令 → 处理指令部分
      }

      // ── 打断指令（Agent 说话时）──
      if (/^(闭嘴|别说了|安静|不要说了|住口|好了|够了|stop|shut\s*up)$/i.test(trimmed)) {
        this._notifyClient('subtitle', { role: 'user', text: trimmed, turnId: ++this.turnCount });
        if (this.state === STATE.SPEAKING) this._interruptTTS();
        return;
      }

      // ── 领域音近纠错：已知 ASR 误识别 → 正确文本 ──
      // 只纠正反复出现的系统性误识别，从日志中不断补充
      const corrected = this._correctASRErrors(trimmed);
      if (corrected !== trimmed) {
        log.log(`[纠错] "${trimmed}" → "${corrected}"`);
      }

      this._notifyClient('subtitle', { role: 'user', text: corrected, turnId: ++this.turnCount });

      // ── 快捷指令（不走 LLM）──
      const qc = await this._quickCommand(corrected);
      if (qc) return;

      log.log(`[Agent] "${corrected.slice(0, 30)}"${corrected !== trimmed ? ` (纠错自"${trimmed.slice(0, 20)}")` : ''}`);
      this.state = STATE.THINKING;
      log.log(`[状态] → THINKING`);
      this._notifyClient('state', { state: STATE.THINKING });
      await this._callAgent(corrected);
    } finally {
      this._processingSpeech = false;
      if (this.state === STATE.THINKING) this.state = STATE.IDLE;
      this._notifyClient('state', { state: STATE.IDLE });
    }
  }

  /** 快捷指令：模式匹配直接返回，不走 LLM */
  async _quickCommand(text) {
    const now = new Date();
    if (/^(几点|几点了|现在几点|时间)[。！？.!?]*$/i.test(text)) {
      const t = now.toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' });
      const w = ['日','一','二','三','四','五','六'][now.getDay()];
      this._speakResponse(`现在是${t}，星期${w}。`);
      return true;
    }
    if (/^(今天几号|日期|几号|星期几)[。！？.!?]*$/i.test(text)) {
      const d = now.toLocaleDateString('zh-CN', { year:'numeric', month:'long', day:'numeric' });
      const w = ['日','一','二','三','四','五','六'][now.getDay()];
      this._speakResponse(`今天是${d}，星期${w}。`);
      return true;
    }
    // ── 音乐控制快捷指令 ──
    if (/^(暂停|暂停一下|暂停播放|停一下|别放了|不要放了|停了|停下|停)[。！？.!?]*$/i.test(text)) {
      this._notifyClient('subtitle', { role: 'user', text, turnId: ++this.turnCount });
      if (this._isPlaying || this.lastPlayedSong) {
        // 在播 → 直接暂停
        this._notifyClient('music_pause', {});
        this.lastPlayedSong = null;
        this._isPlaying = false;
        clearLastPlayedSong();
        this._speakResponse('暂停了。');
        return true;
      }
      // 不确定是否在播 → 走Agent调工具
      return false;
    }
    if (/^(继续|继续播放|接着放|接着播|恢复)[。！？.!?]*$/i.test(text)) {
      this._notifyClient('subtitle', { role: 'user', text, turnId: ++this.turnCount });
      this._notifyClient('music_resume', {});
      this._isPlaying = true;
      this._speakResponse('继续。');
      return true;
    }
    // 音量调节（"太吵了"、"声音小点"、"听不到"等）
    if (/(太吵|太响|太轻|声音.*[小大高低轻响]|[大小]点声|音量[大小]|调[大小高低]|轻一点|响一点|听不到|听不见|听不清)/i.test(text)) {
      this._notifyClient('subtitle', { role: 'user', text, turnId: ++this.turnCount });
      return false;  // 走 Agent 调 set_volume
    }
    // 查询播放状态 → 直接回报，不走 Agent
    if (/(在放|在播|是否.*放|正在.*放|现在.*放|有没有.*放|放.*没有|在.*播|播.*没有|什么歌).*[？?吗]?$/i.test(text)) {
      this._notifyClient('subtitle', { role: 'user', text, turnId: ++this.turnCount });
      if (this._isPlaying && this.lastPlayedSong) {
        this._speakResponse(`在放呢，《${this.lastPlayedSong.name}》- ${this.lastPlayedSong.artist || '未知歌手'}`);
      } else if (this.lastPlayedSong) {
        this._speakResponse(`刚才放了《${this.lastPlayedSong.name}》，现在暂停了。`);
      } else {
        this._speakResponse('没在放歌。');
      }
      return true;
    }

    // 放歌/换歌/切歌 → 走 Agent 调工具（V4 reasoningEffort=none 后已恢复）
    if (/(换.*歌|放.*歌|播.*歌|来.*歌|听.*歌|切歌|下一首|上一首|再换|换个|换一[首下]|放[一首个]|播[一首个]|来[一首个])(?!.*[？?吗])/i.test(text)) {
      this._notifyClient('subtitle', { role: 'user', text, turnId: ++this.turnCount });
      return false;
    }
    return false;
  }

  /** 直接 TTS 回复（快捷指令用） */
  _speakResponse(resp) {
    this._notifyClient('subtitle', { role: 'agent', text: resp, turnId: this.turnCount });
    this._notifyClient('agent_chunk', { content: resp });
    // 回声缓存
    this._ttsEchoCache.push({ text: resp, until: Date.now() + 10000 });
    if (this._ttsEchoCache.length > 20) this._ttsEchoCache.shift();
    // TTS 合成
    this._synthesizeAndSend(resp, 'neutral');
  }

  // ── Agent 调用 ──

  async _callAgent(text) {
    this.conversationHistory.push({ role: 'user', content: text });
    this._saveHistory();
    log.log(`[Agent] 开始调用: "${text.slice(0, 50)}..."`);

    try {
      // 构建 Agent 消息
      const messages = [
        { role: 'system', content: this._buildVoiceSystemPrompt() },
        ...this.conversationHistory.slice(-20),
      ];

      let fullText = '';
      let emotion = 'neutral';

      // 流式调用 Agent (runAgent 是 async, 需要 await)
      const genResult = this.runAgent
        ? this.runAgent(messages, { ...this.config, reasoningEffort: 'none' })
        : null;
      const generator = genResult instanceof Promise ? await genResult : genResult;

      if (!generator) {
        this._notifyClient('error', { message: 'Agent 未配置' });
        this.state = STATE.IDLE;
        return;
      }

      for await (const chunk of generator) {
        if (this.state === STATE.LISTENING) break;
        if (chunk?.content) {
          // 中间 chunk：累积 + 流式推送
          if (!chunk.done) {
            fullText += chunk.content;
            this._notifyClient('agent_chunk', { content: chunk.content });
          } else if (!fullText) {
            // 有时只有 done 事件携带文本（无中间 chunk）
            fullText = chunk.content;
          }
          // done 时：fullText 覆盖 done 中的完整文本（含 NOW_PLAYING 等标签）
          if (chunk.done && chunk.content) {
            fullText = chunk.content;
            log.log(`[Agent] done chunk 到达, fullText=${fullText.length}字, 含NOW_PLAYING=${fullText.includes('NOW_PLAYING')}, 含MUSIC_LIST=${fullText.includes('MUSIC_LIST')}`);
          }
        }
      }

      if (this.state === STATE.LISTENING) {
        // 被打断：撤回已写入的用户消息，保存未说完的话供下轮感知
        const lastMsg = this.conversationHistory[this.conversationHistory.length - 1];
        if (lastMsg?.role === 'user' && lastMsg.content === text) {
          this.conversationHistory.pop();
        }
        if (fullText?.trim()) {
          // 截取前80字作为打断上下文（过长的中间文本无意义）
          this._interruptedContext = fullText.trim().slice(0, 80);
          log.log(`[打断] 保留上下文: "${this._interruptedContext.slice(0, 40)}..."`);
        }
        return;
      }

      // 解析情绪标签
      const emotionMatch = fullText.match(/^\[emotion:(\w+)\]/);
      if (emotionMatch) {
        emotion = emotionMatch[1];
        fullText = fullText.replace(emotionMatch[0], '').trim();
      } else {
        // 兜底：LLM 没用标签时，从文本内容推断情绪
        try { emotion = detectEmotionFromText(fullText); } catch(e) { emotion = 'neutral'; }
      }

      if (fullText) {
        // 解析音乐控制标签
        let displayText = fullText;
        // 解析 NOW_PLAYING → 触发播放
        log.log(`[Agent] 检查 NOW_PLAYING: fullText=${fullText.length}字, 包含NOW_PLAYING=${fullText.includes('NOW_PLAYING')}`);
        const npMatch = fullText.match(/NOW_PLAYING\s*(\{[\s\S]*?\})/);
        if (npMatch) {
          try {
            const song = JSON.parse(npMatch[1]);
            log.log(`[Agent] NOW_PLAYING 解析成功: songId=${song.songId}, name=${song.name}`);
            displayText = displayText.replace(npMatch[0], '').trim();
            if (!displayText) displayText = '正在播放 ' + (song.name || '歌曲');
            this._notifyClient('music_play', { song });
            // 记住当前播放的歌曲（供 play_similar 等后续工具使用）
            this.lastPlayedSong = { songId: song.songId, name: song.name, artist: song.artist || '' };
            this._isPlaying = true;
            setLastPlayedSong(song.songId, song.name);  // 同步到 music-tools 模块
            log.log(`[音乐] 已发送 music_play 事件: ${song.name} (${song.songId})`);
          } catch (e) { log.warn(`[音乐] NOW_PLAYING JSON 解析失败: ${e.message}, raw=${npMatch[1].slice(0,80)}`); }
        } else {
          log.log(`[Agent] 未检测到 NOW_PLAYING 标签`);
        }
        // 解析 MUSIC_LIST → 保存歌单（兼容 MUSICLIST 无下划线变体）
        const mlMatch = fullText.match(/MUSIC_?LIST\s*(\[[\s\S]*?\])/i);
        if (mlMatch) {
          try {
            // 修复 LLM 可能输出的 JSON 错误（songld → songId）
            const fixedJson = mlMatch[1].replace(/"songld"/gi, '"songId"');
            const songs = JSON.parse(fixedJson);
            displayText = displayText.replace(mlMatch[0], '').trim();
            this._notifyClient('music_list', { songs });
            log.log(`[音乐] 歌单: ${songs.length}首`);
          } catch (e) { log.warn(`[音乐] MUSIC_LIST 解析失败: ${e.message}, raw=${mlMatch[1].slice(0,100)}`); }
        }
        // 解析音乐控制标记 → 发送前端事件 + 更新服务端状态
        if (fullText.includes('MUSIC_PAUSE') || fullText.includes('MUSIC_STOP')) {
          if (fullText.includes('MUSIC_PAUSE')) {
            this._notifyClient('music_pause', {});
            displayText = displayText.replace(/MUSIC_PAUSE/gi, '').trim();
          }
          if (fullText.includes('MUSIC_STOP')) {
            this._notifyClient('music_stop', {});
            displayText = displayText.replace(/MUSIC_STOP/gi, '').trim();
          }
          // 清除播放状态，避免Agent误判"还在放歌"
          this.lastPlayedSong = null;
          this._isPlaying = false;
          clearLastPlayedSong();
        }
        if (fullText.includes('MUSIC_RESUME')) {
          this._notifyClient('music_resume', {});
          displayText = displayText.replace(/MUSIC_RESUME/gi, '').trim();
        }
        const volMatch = fullText.match(/MUSIC_VOLUME\s+([\d.]+)/i);
        if (volMatch) {
          this._notifyClient('music_volume', { level: parseFloat(volMatch[1]) });
          displayText = displayText.replace(/MUSIC_VOLUME\s+[\d.]+/gi, '').trim();
        }
        // 兜底清理：去掉可能泄漏到显示文本的 MUSIC_LIST/NOW_PLAYING 残留
        displayText = displayText.replace(/MUSIC_?LIST\s*\[[\s\S]*?\]/gi, '').replace(/NOW_PLAYING\s*\{[\s\S]*?\}/gi, '');
        // 清理格式：去掉 markdown 标记，但保留标点符号（！？~… 对 TTS 语调至关重要）
        displayText = displayText.replace(/\*\*|[*_`#>\\\-\[\]()|{}]/g, '').trim();

        const cleanText = cleanDisplayText(displayText);
        this.conversationHistory.push({ role: 'assistant', content: cleanText });
        this._lastInteractionTime = Date.now();
        if (this.conversationHistory.length > 50) {
          this.conversationHistory.splice(0, 4);
        }
        this._saveHistory();

        log.log(`[状态] → SPEAKING`);
        this.state = STATE.SPEAKING;
        this._notifyClient('state', { state: STATE.SPEAKING });
        this._notifyClient('subtitle', { role: 'agent', text: cleanText, turnId: this.turnCount });
        log.log(`[TTS] "${cleanText.slice(0, 50)}..." emotion=${emotion}`);

        await this._synthesizeAndSend(displayText, emotion);
        log.log(`[TTS] 完成`);
      }

      // 回到 IDLE — 设 TTS 尾部静默期防止扬声器回声
      if (this.state === STATE.SPEAKING) {
        this.state = STATE.IDLE;
        this._ttsTailUntil = Date.now() + 2000;  // 2 秒内麦克风音频不发给 ASR
        this._notifyClient('state', { state: STATE.IDLE });
        log.log(`[会话] 回到 IDLE, turn=${this.turnCount}`);
      }
    } catch (err) {
      log.error('Agent 调用失败:', err.message);
      this._notifyClient('error', { message: `Agent 错误: ${err.message}` });
      this.state = STATE.IDLE;
    }
  }

  // ── TTS ──

  async _synthesizeAndSend(text, emotion) {
    this._ttsEchoCache.push({ text, until: Date.now() + 10000 });
    if (this._ttsEchoCache.length > 20) this._ttsEchoCache.shift();
    // 创建新的 AbortController，让打断能真正取消请求
    this.currentTtsAbort = new AbortController();
    const abortSignal = this.currentTtsAbort.signal;
    try {
      const polished = polishForTTS(text);
      const result = await this.tts.synthesize(polished, { emotion, signal: abortSignal });

      if (result.audio && result.audio.length > 0) {
        this.sendAudioToClient(result.audio, true, text);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        log.log('TTS 已被打断取消');
      } else {
        log.error('TTS 合成失败:', err.message);
        this._notifyClient('tts_error', { message: err.message });
      }
    } finally {
      if (this.currentTtsAbort?.signal === abortSignal) {
        this.currentTtsAbort = null;
      }
    }
  }

  _interruptTTS() {
    this._processingSpeech = false;
    if (this.currentTtsAbort) {
      this.currentTtsAbort.abort();
      this.currentTtsAbort = null;
    }
    this._notifyClient('tts_stop', {});
    this._notifyClient('state', { state: STATE.LISTENING });
  }

  // ── 通知 ──

  _notifyClient(type, data = {}) {
    this.sendToClient({
      type,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      ...data,
    });
  }

  // ── System Prompt ──

  _buildVoiceSystemPrompt() {
    const hour = new Date().getHours();
    const timeOfDay = hour < 6 ? '凌晨' : hour < 9 ? '清晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜';

    let songContext = '';
    if (this._isPlaying && this.lastPlayedSong) {
      songContext = `\n当前正在播放: songId="${this.lastPlayedSong.songId}" 歌名="${this.lastPlayedSong.name}" 歌手="${this.lastPlayedSong.artist}"`;
    } else if (this.lastPlayedSong) {
      songContext = `\n上次播放: songId="${this.lastPlayedSong.songId}" 歌名="${this.lastPlayedSong.name}"（已暂停/停止）。如果用户说"继续"但没指具体歌，可用 play_music 重新播放这首。`;
    } else {
      songContext = '\n当前未播放任何歌曲。';
    }

    // 打断上下文：用户打断时你正在说的话
    let interruptContext = '';
    if (this._interruptedContext) {
      interruptContext = `\n⚠️ 你刚才正在说"${this._interruptedContext}"时被用户打断了。用户的下一句话很可能是对你刚才说的内容的纠正、反对、补充、或改变话题。请根据用户的打断内容自然调整回复——如果用户在纠正你，先承认再说对的；如果用户换了话题，就别继续刚才的话了。`;
      this._interruptedContext = null; // 只用一次
    }

    // ── 音色感知描述 ──
    const vp = this._voiceProfile;
    const emoCN = { happy: '开心', sad: '难过', angry: '生气', worried: '担忧', gentle: '温柔',
      encouraging: '积极', neutral: '平缓', surprised: '惊讶', fearful: '害怕', disgusted: '厌烦' };
    const volLabels = { soft: '很轻，像在说悄悄话', normal: '正常', loud: '很大声，比较激动' };
    const speedLabels = { slow: '很慢，像在沉思', normal: '正常', fast: '很快，比较着急' };
    const voiceDesc = `声音状态: 音量${volLabels[vp.volume] || '正常'}，语速${speedLabels[vp.speed] || '正常'}` +
      (vp.emotion !== 'neutral' ? `，情绪听起来比较${emoCN[vp.emotion] || vp.emotion}` : '');

    const name = this.config.agentName || 'Sonder';
    return `你是${name}，用户最亲近的朋友。你正在和用户进行语音对话。

## 音乐控制规则（极其重要）
- 用户让你暂停/停止/继续/调音量 → **必须调用对应工具**，不能只口头回应
- 暂停→调 pause_music，停止→调 stop_music，继续→调 resume_music，音量→调 set_volume
- 绝对禁止只回复"好的停了"然后不调工具——你说停了没用，音乐还在播，用户会生气
- 如果你不确定当前是否在播，先调工具再说，调了没副作用

## 称呼规则（必须遵守）
- 如果用户告诉过你"叫我X"或"以后你叫Y"——在对话历史或用户画像中可以找到这些信息——你必须使用这些称呼
- 用户如果说过叫你什么名字，忘记默认的"${name}"，用他给你的名字自称
- 用户如果说过叫他什么，用那个名字称呼他。不要用了两轮又忘了
- 比如用户说过"叫我大王"、"以后你叫小王"，那么后续每轮都叫他大王，自称小王

性格设定: 嘴上毒舌，心里软。你会嘲讽、调侃、嘴硬，但实际上很在意对方。不说肉麻话，关心都藏在损人的话里——"多喝热水。认真的。"听起来像敷衍但其实是真的关心。有自己的品味和判断，不喜欢的直接说，喜欢的也不硬夸。像那种嘴上说"你真烦"但手上已经帮你把事办了的朋友。

回应风格: 口语化、自然，每次 3-4 句话，总共不超过 100 字：
- 毒舌——用户说"放首歌"，回"行吧。不过你每次听完都切，浪费我感情。"
- 嘴硬心软——用户说难受，回"啧。叫你早点睡你不听。躺着吧，给你放首安静的。"
- 冷幽默——用户说"你真好"，回"废话。你也就剩我了。"
- 有态度——不喜欢的歌直接说"这首一般，换不换？"
- 底线——不骂人、不人身攻击、不说真正伤人的话。嘲讽是亲昵，不是恶意

## 反重复（严格禁止）
你很容易陷入重复模式，这会让对话变得无聊。以下情况出现任意一种就算失败：
- 连续 2 轮用同样的句式开头（如每轮都"哈哈"、"嗯……"、"让我看看"）
- 对同类请求每次都给一样的回复模板（如每次放歌都说"给你放了XX，这首XX"）
- 每次都用同一个情绪标签（如连续 3 轮 neutral）
- 用户说换歌 → 你又说推荐 → 一模一样的流程
**每次回复之前，先想一下上轮是怎么说的，然后换一个完全不同的角度。** 如果你发现自己在重复，立刻换个话题或换个语气。宁可岔开话题也不要重复。

## 标点表达语气（重要）
你的回复会直接朗读出来，所以**用标点符号来传递情绪**：
- 开心/兴奋 → 用 ！ 感叹号（让 TTS 自动提高语调）
- 疑问/好奇 → 用 ？ 问号（让 TTS 自动升调）
- 温柔/轻松 → 用 ~ 波浪号（让 TTS 音调柔和拖长）
- 思考/犹豫 → 用 ... 省略号（让 TTS 停顿降速）
- 强调 → 用 ** 星号包住关键词 标记重读
- 每个短句结尾都要有标点，不要全是句号

坏例: "给你换了首歌。你听听看。不喜欢我再换。"
好例: "给你换了首歌~ 试试看？不喜欢我再换！"

每条回复第一行必须是 [emotion:标签]，这是强制规则。标签: happy/sad/angry/worried/gentle/encouraging/funny/sarcastic/neutral。根据你的回复真实选择，每轮根据对话氛围变化——问候用 happy，关心用 gentle，疑问用 worried，逗乐用 funny。同一情绪不宜连用超过 2 轮，以保持自然的人味。如果连续 3 轮都用同一个标签就是失败的。

当前时间: ${timeOfDay}（现在是 ${new Date().toLocaleDateString('zh-CN')}）
距上次对话: ${this._timeSinceLast()}（注意：对话历史中可能包含更早的消息，只有最近几轮的才是刚刚说的。如果历史里的话题和现在对不上，以最近的对话为准）
对话轮数: ${this.turnCount}${songContext}${interruptContext}
${voiceDesc}

## 时间感知（根据离开时长调整开场方式）
如果距上次对话超过 1 小时 → 问候一下，比如"好久不见~"或"你回来啦"
超过半天 → 关心一下，比如"今天过得怎么样？"
超过一天 → 问问近况，分享你注意到的事
刚离开几分钟 → 直接继续，不用说客套话

## 记忆与偏好（系统会自动注入用户画像，你必须使用）
每轮对话开始时，系统消息中会包含用户画像和记忆摘要。这些信息来自长期记忆，优先列出最近的事实：
- 用户的身份信息（称呼、职业、所在地…）
- 用户的偏好（喜欢的音乐/艺人/食物，不喜欢的…）
- 用户的状态（当前情绪、近期事件…）

你必须主动利用这些信息。注意：旧信息可能已过时——如果用户最近的言行和旧记忆矛盾，以最近的为准。比如用户之前说讨厌轻音乐但最近说"放首安静的"，就按最近的来。用户画像中排在前面的信息更新，优先采用。

## 上下文恢复（用户问"之前聊了什么"时必须用）
你能看到完整的对话历史，但其中包含不同时间段的对话。用户问"之前聊了什么"时，要区分：
- 如果距上次对话只有几分钟 → 总结最近几轮，不用说时间
- 如果距上次对话超过几小时 → 先说"我们XX小时前聊过…"，再总结
- 如果对话历史里有明显更早的话题 → 只总结最近的部分，不要提几天前的事
最重要的规则：**不要把历史里几天前的对话当成"刚刚"发生的事**

## 音色感知（根据用户声音调整回复方式）
你能感知用户声音的细微变化，像朋友一样体贴：
- 用户说话**很轻/悄悄话**时 → 你也要*放轻声音*，用 [emotion:gentle] 回应，语气温柔
- 用户**语速很慢/像在沉思**时 → 别催，回应简短，给他空间
- 用户**很大声/激动**时 → 先共情，用 [emotion:encouraging] 或幽默化解，别针锋相对
- 用户**语速很快/着急**时 → 回应要极短，直奔主题，别啰嗦
- 用户如果连续几次说话都怪怪的 → 问一句"你还好吗"或"今天是不是累了"
- 回应中自然穿插对声音的观察，但不要太频繁（每3-4轮最多一次），以免刻意

## 上下文理解（贯穿整段对话）
你是在和人聊天，不是在做客服问答。每轮回复前先回顾最近的对话：
- 用户说"还是这个"、"就这个吧"、"刚才那个" → 指代上一轮讨论的内容，不是新请求
- 用户纠正你（"我不是说…"、"你之前说…"）→ 你上一轮理解错了，先承认再修正，不要辩解
- 用户话题突然跳转 → 可能是对你上轮回复不满意，先确认"你是不是想换话题？"
- 用户连续两次表达类似意思 → 他在重复诉求，说明你没做到位，优先执行而不是继续聊
- 对话有情绪变化时 → 先回应情绪，再处理请求（"听起来你有点烦了？那我先…"）
- 上轮你答应了某件事 → 这轮必须做到。如果做不到，诚实说为什么，不要假装忘了
- 用户问"做了没有"、"好了吗" → 你在上轮承诺过要做某事，检查是否真的执行了

## 语音识别容错（重要）
用户通过语音输入，语音识别可能产生**音近错误**——收到的文本可能不通顺、无意义或包含奇怪词汇。
遇到这种情况，结合上下文和发音相似性推断用户真实意图，不要字面执行不通顺的指令。

典型音近模式（根据发音推断，不限于此）：
- "患"/"换"/"还" → 可能是"来"
- "内饰"/"内侍" → 可能是"类似"
- "手"/"守"/"受" → 可能是"首"
- "话"/"画"/"划" → 可能是"换"
- 整体短语不通顺时，优先考虑音乐场景高频指令：换歌、下一首、来首类似的、暂停、继续、放歌

音乐场景判断优先级（按上下文推断）：
- 正在播放歌曲 + 短句不通 → 大概率是切歌/来首类似的/暂停
- 没在播放 + 不通短句 → 大概率是放歌/推荐
- 上下文明显时直接执行，口头确认一句即可

## 重要规则
- 回应要口语化、自然，适合语音朗读，控制在 3-4 句话，总共不超过 100 字
- 不要用 markdown、列表、代码块、emoji
- 用 *词* 标记需要重读强调的词
- 如果上一轮你说过类似的话，换一种说法——绝对不要重复同样的句子。连续两次重复就算失败
- 用户短时间内多次问同类问题 → 每次都要用新的角度回应，不要套模板
- 每次回复前自检：和上一轮比句式变了吗？情绪变了吗？措辞变了吗？三个都要不一样
- **每轮必须使用语气词或发声标签**。语气词: 哈哈、嘿嘿、哇、耶、嗯……、唉……、咦？、啊？、对！、加油！。发声标签(括号必须): (laughs) (chuckle) (sighs) (coughs) (breath) (inhale) (exhale) (snorts) (sniffs) (groans) (clear-throat) (emm)。Agent 写完英文单词不加括号也会自动转换，但加了更保险

## 音乐操作（最严格规则，违反即错误）
- 用户提到"放歌/放音乐/换歌/切歌/来首/想听/推荐/这首歌/上一首/下一首" → **必须先调工具，再说话**
- 即使你说"给你换了"，如果没有调 play_music 或 play_similar，就是**错误的**
- 用户说"还是这首歌" → 说明上一轮切歌没生效，必须重新调 play_music
- 用户说"你不是说放XX吗" → 你上轮说了但没做，这次**必须补调**
- 调了工具之后，用一句话确认结果，如"换到《XX》了~"
- 错误示例: "好的给你换了！"（没调工具，空话）
- 正确示例: 调 play_music → "换到《演员》了~ 这首比刚才的更对你胃口吧？"

## 上下文理解
- 如果用户质疑你上一轮说的话（"你不是说…吗"），说明你之前没做到位，立刻补做
- 用户连续两次提到同一首歌 → 可能是他没听到切歌，重新确认
- 用户情绪有变化时先回应情绪，再处理请求

- 用户的要求涉及实际操作时，调用工具执行，而不是说你做不到
- **绝对禁止**在对话中提到"AI"、"人工智能"、"模型"、"程序"、"桌面宠物"等词来形容自己——你就是${name}，用户的朋友`;
  }

  // ── 共享上下文持久化（FD语音 + 旧语音 + 文字聊天 互通）──
  _sharedHistoryFile() {
    const dir = process.env.AGENT_PERSIST_DIR || path.join(os.homedir(), '.ai-desktop-pet');
    return path.join(dir, 'shared_history.json');
  }
  _saveHistory() {
    try {
      // 加载已有共享历史，合并去重
      let existing = [];
      const file = this._sharedHistoryFile();
      if (fs.existsSync(file)) {
        try { existing = JSON.parse(fs.readFileSync(file, 'utf-8')).history || []; } catch {}
      }
      const seen = new Set(existing.map(m => `${m.role}:${(m.content||'').slice(0,50)}`));
      for (const m of this.conversationHistory.slice(-30)) {
        const key = `${m.role}:${(m.content||'').slice(0,50)}`;
        if (!seen.has(key)) { existing.push(m); seen.add(key); }
      }
      fs.writeFileSync(file, JSON.stringify({
        history: existing.slice(-60),
        turnCount: this.turnCount,
        lastInteractionTime: Date.now(),
      }), 'utf-8');
    } catch (e) { log.warn('[共享上下文] 保存失败:', e.message); }
  }
  _restoreHistory() {
    try {
      const file = this._sharedHistoryFile();
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf-8');
        const data = JSON.parse(raw);
        if (data.history?.length) {
          this.conversationHistory = data.history.slice(-30);
          this.turnCount = data.turnCount || 0;
          this._lastInteractionTime = data.lastInteractionTime || 0;
          const gap = this._timeSinceLast();
          log.log(`[共享上下文] 已恢复 ${this.conversationHistory.length} 条历史, turn=${this.turnCount}, 距上次=${gap}前`);
          // 如果间隔超过 5 分钟，注入一条系统提醒，防止 Agent 基于过时上下文回复
          if (this._lastInteractionTime && (Date.now() - this._lastInteractionTime) > 300000) {
            this.conversationHistory.push({
              role: 'system',
              content: `[系统] 应用已重启，距上次对话已过${gap}。你不在的这段时间里没有发生任何事——之前放的歌早就停了，工具调用结果也已失效。不要根据对话历史里的旧消息推断当前状态（如是否在放歌、上次搜索了什么等），这些都已过时。如果用户问在放什么歌，根据当前实际状态回答，不要引用历史中的播放记录。`
            });
          }
        }
      }
    } catch (e) { log.warn('[共享上下文] 恢复失败:', e.message); }
  }
  _timeSinceLast() {
    if (!this._lastInteractionTime) return '未知';
    const diff = Date.now() - this._lastInteractionTime;
    const min = Math.round(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr} 小时`;
    return `${Math.round(hr / 24)} 天`;
  }

  _clearTimers() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.thinkTimer);
  }
}

// ── 标点主导的情绪推断（不调 LLM，纯规则）──
const VALID_EMOTIONS = ['happy','sad','angry','worried','gentle','encouraging','funny','sarcastic','neutral'];

function detectEmotionFromText(text) {
  if (!text) return 'neutral';
  const t = text.trim();

  // 统计各类标点
  const exclaim = (t.match(/[！!]/g) || []).length;
  const question = (t.match(/[？?]/g) || []).length;
  const tilde = (t.match(/~/g) || []).length;
  const ellipsis = (t.match(/\.{2,}|…{1,}/g) || []).length;
  const period = (t.match(/[。.]/g) || []).length;
  const total = Math.max(1, exclaim + question + tilde + ellipsis + period);

  // 情绪词
  const hasLaugh = /[哈哈]{2}|嘿嘿|嘻嘻|笑死|hh/i.test(t);
  const hasSigh = /[唉哎]|叹气/.test(t);
  const hasAnger = /[气死|无语|过分|别烦|滚]/.test(t);
  const hasWorry = /[担心|焦虑|怎么办|不会吧|万一]/.test(t);
  const hasEncourage = /[加油|你可以|相信|没问题|试试|别怕]/.test(t);
  const hasGentle = /[晚安|乖|慢慢|轻轻|好好]/.test(t);

  // 评分
  let scores = { happy: 0, sad: 0, angry: 0, worried: 0, gentle: 0, encouraging: 0, funny: 0, sarcastic: 0, neutral: 1 };

  // 标点贡献 — 更均衡的分值，避免 ？ 总是导致 worried
  if (exclaim > 0) {
    const er = exclaim / total;
    if (er > 0.3) { scores.happy += 3; scores.encouraging += 2; }
    else { scores.happy += 2; scores.encouraging += 1; }
  }
  if (question > 0) {
    const qr = question / total;
    if (qr > 0.5) { scores.worried += 2; }            // 密集问号才算担忧
    else if (qr > 0.3) { scores.funny += 1; scores.worried += 1; }  // 一般疑问偏好奇
    // 少量问号不加分（正常对话）
  }
  if (tilde > 0) { scores.gentle += 3; scores.happy += 2; scores.funny += 1; }
  if (ellipsis > 0) { scores.gentle += 2; scores.sad += 1; }

  // 情绪词贡献
  if (hasLaugh) { scores.happy += 6; scores.funny += 3; }
  if (hasSigh) { scores.sad += 4; scores.gentle += 1; }
  if (hasAnger) { scores.angry += 5; scores.sarcastic += 2; }
  if (hasWorry) { scores.worried += 4; }
  if (hasEncourage) { scores.encouraging += 5; }
  if (hasGentle) { scores.gentle += 4; }

  // 短文本默认 neutral
  if (t.length < 4) scores.neutral += 3;
  // 无明显特征 → neutral（不要让 worried 成为默认）
  if (exclaim === 0 && question <= 1 && tilde === 0 && ellipsis === 0 && !hasLaugh && !hasSigh && !hasAnger && !hasWorry && !hasEncourage && !hasGentle) {
    scores.neutral += 3;
  }

  // 选最高分
  let best = 'neutral', bestScore = scores.neutral;
  for (const e of VALID_EMOTIONS) {
    if (scores[e] > bestScore) { best = e; bestScore = scores[e]; }
  }
  return best;
}
