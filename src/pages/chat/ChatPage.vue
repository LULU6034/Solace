<template>
  <div class="main-area">
    <!-- 历史侧边栏 -->
    <aside class="history-sidebar" :class="{ open: showHistory }">
      <div class="history-header">
        <span>对话历史</span>
        <button class="history-close-btn" @click="showHistory=false" title="关闭">
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 2l10 10M12 2l-10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="history-list">
        <div v-if="sessions.length===0" class="history-empty">暂无历史对话</div>
        <div v-for="(s,i) in sessions" :key="s.id" class="history-item" :class="{ active: s.id===activeSessionId }" @click="loadSession(i)">
          <div class="history-item-title">{{ s.title }}</div>
          <div class="history-item-meta">
            <span>{{ s.date }}</span>
            <span>{{ s.count }} 条</span>
          </div>
          <button class="history-del-btn" @click.stop="deleteSession(i)" title="删除">
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
    </aside>
    <!-- 主内容 -->
    <div class="main-content">
    <div class="header-bar">
      <div class="tab-actions">
        <button class="history-toggle-btn" :class="{ active: showHistory }" title="对话历史" @click.stop="showHistory=!showHistory">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </button>
        <button class="add-btn" title="新建对话" @click.stop="addNewConv">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M9 3v12M3 9h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>

    <div v-if="renaming !== null" class="rename-overlay" @click="renaming = null">
      <div class="rename-dialog" @click.stop>
        <input v-model="renameText" class="setting-input" placeholder="对话名称..."
          @keydown.enter="doRename" @keydown.escape="renaming = null" ref="renameInput" />
        <div class="rename-actions">
          <button class="setting-btn secondary" @click="renaming = null">取消</button>
          <button class="setting-btn primary" @click="doRename">确定</button>
        </div>
      </div>
    </div>

    <div class="messages-area" ref="msgArea" @click="ctxMenu = null">
      <div v-if="conv.messages.length === 0" class="welcome-placeholder">
        <div class="welcome-avatar-ring">
          <div class="pulse-ring r1"></div><div class="pulse-ring r2"></div><div class="pulse-ring r3"></div>
          <div class="welcome-icon" :style="{ background: welcomeColor }">{{ welcomeIcon }}</div>
        </div>
        <div class="welcome-title">你好，我是 {{ welcomeName }}</div>
        <div class="welcome-sub">有什么可以帮你的？</div>
      </div>
      <div v-for="(msg, i) in conv.messages" :key="i" class="message-row"
        :class="[msg.role, { review: msg._review }]"
        @mouseenter="msg._hover = true" @mouseleave="msg._hover = false">
        <div v-if="msg.role === 'assistant'" class="msg-avatar"
          :style="msg._expert?.avatarUrl ? { backgroundImage: 'url('+msg._expert.avatarUrl+')', backgroundSize:'cover' } : { background: (msg._expert?.color||char.color)+'18' }">
          <span v-if="!msg._expert?.avatarUrl" v-html="msg._expert?.icon || char.icon"></span>
        </div>
        <div v-else class="msg-avatar user-avatar">
          <img v-if="userAvatar.startsWith('data:')" :src="userAvatar" class="avatar-img" />
          <div v-else class="avatar-geo" :style="{ background: avatarColor }">
            <svg viewBox="0 0 40 40" class="avatar-geo-svg">
              <path d="M12 28 Q20 8 28 28" fill="none" stroke="rgba(0,0,0,0.12)" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M8 22 Q20 16 32 22" fill="none" stroke="rgba(0,0,0,0.1)" stroke-width="1.5" stroke-linecap="round"/>
              <circle cx="20" cy="18" r="3" fill="rgba(255,255,255,0.3)" />
            </svg>
          </div>
        </div>
        <div class="bubble-wrap">
          <div class="bubble" :class="msg.role" :style="msg._expert ? { borderColor: msg._expert.color+'60' } : {}">
            <div v-if="msg.role==='assistant'" class="msg-role" :style="msg._expert?{color:msg._expert.color}:{}">{{ msg._expert?.name || char.name }}</div>
            <div v-if="msg._reasoning" class="bubble-reasoning">
              <button class="bubble-reasoning-toggle" @click="msg._reasoningOpen=!msg._reasoningOpen"><span>🧠 思考过程</span><span class="bubble-reasoning-arrow" :class="{open:msg._reasoningOpen}">▾</span></button>
              <div class="bubble-reasoning-content" :class="{open:msg._reasoningOpen}">{{ msg._reasoning }}</div>
            </div>
            <div v-if="isStreamingMsg(msg,i) && reasoningText" class="bubble-reasoning">
              <button class="bubble-reasoning-toggle" @click="reasoningExpanded=!reasoningExpanded"><span>🧠 思考中...</span><span class="bubble-reasoning-arrow" :class="{open:reasoningExpanded}">▾</span></button>
              <div class="bubble-reasoning-content" :class="{open:reasoningExpanded}">{{ reasoningText }}</div>
            </div>
            <div v-if="msg._previewImages" class="msg-images"><img v-for="(img,ii) in msg._previewImages" :key="ii" :src="img" class="msg-image-preview" /></div>
            <div class="msg-text" v-html="renderMarkdown(msg.content)"></div>
            <span v-if="isStreamingMsg(msg,i)" class="streaming-cursor"></span>
            <div v-if="msg.timestamp" class="msg-footer">
              <span class="msg-arrow">{{ msg.role==='user'?'↘︎':'↙︎' }}</span>
              <span class="msg-time">{{ fmtTime(msg.timestamp) }}</span>
              <span v-if="msg.elapsed" class="msg-elapsed">⏱ {{ msg.elapsed }}s</span>
              <span v-if="msg.role==='user'" class="msg-check">✓</span>
            </div>
          </div>
          <button v-if="msg._hover" class="copy-btn" @click="copyMsg(msg.content)" :class="{copied:msg._copied}">{{ msg._copied?'✓ 已复制':'⎘ 复制' }}</button>
        </div>
      </div>
      <div v-if="loading && conv.messages.length>0" class="typing-indicator"><div class="typing-dot"/><div class="typing-dot"/><div class="typing-dot"/></div>
      <div v-if="pendingApproval" class="approval-inline">
        <span class="approval-inline-label">执行命令: <code>{{ pendingApproval.tool }}</code></span>
        <pre class="approval-inline-cmd">{{ fmtApprovalInput(pendingApproval.input) }}</pre>
        <div class="approval-inline-actions">
          <button class="approval-btn deny" @click="approveTool(false)">取消</button>
          <button class="approval-btn allow" @click="approveTool(true)">确认执行</button>
        </div>
      </div>
      <div ref="msgEnd"/>
    </div>

    <div class="input-area">
      <div v-if="pendingImages.length>0" class="img-preview-strip">
        <div v-for="(img,i) in pendingImages" :key="i" class="img-preview"><img :src="img.data"/><button class="img-remove" @click="pendingImages.splice(i,1)">&times;</button></div>
      </div>
      <div class="input-toolbar-top">
        <div class="effort-dropdown">
          <button ref="modelTrigger" class="effort-trigger model-trigger" :disabled="loading" @click="openModel" :class="{ open: modelOpen }">
            <span class="effort-label">{{ convModelLabel || '模型' }}</span>
            <span class="effort-arrow" :class="{ open: modelOpen }">▾</span>
          </button>
          <Teleport to="body">
            <transition name="dropdown">
              <div v-if="modelOpen" class="effort-menu" :style="modelMenuStyle" @click.stop>
                <button v-for="m in currentModels" :key="m.value"
                  class="effort-item" :class="{ active: convModel === m.value }"
                  @click="convModel=m.value;modelOpen=false">
                  <span class="effort-item-name">{{ m.label }}</span>
                </button>
              </div>
            </transition>
          </Teleport>
        </div>
        <div class="effort-dropdown">
          <button ref="effortTrigger" class="effort-trigger" :disabled="loading" @click="openEffort" :class="{ open: effortOpen }">
            <span class="effort-label">{{ effortLabel }}</span>
            <span class="effort-arrow" :class="{ open: effortOpen }">▾</span>
          </button>
          <Teleport to="body">
            <transition name="dropdown">
              <div v-if="effortOpen" class="effort-menu" :style="effortMenuStyle" @click.stop>
                <button v-for="opt in EFFORT_OPTIONS" :key="opt.value"
                  class="effort-item" :class="{ active: reasoningEffort === opt.value }"
                  @click="reasoningEffort=opt.value;effortOpen=false">
                  <span class="effort-item-name">{{ opt.label }}</span>
                  <span class="effort-item-desc">{{ opt.desc }}</span>
                </button>
              </div>
            </transition>
          </Teleport>
        </div>
      </div>
      <div class="input-box">
        <div class="voice-input-wrap">
          <textarea ref="ta" v-model="text" placeholder="输入消息…" @keydown="onKeydown" @paste="onPaste" rows="1"/>
        </div>
        <button v-if="sendState==='idle'" class="send-btn-inline" :disabled="!text.trim() && pendingImages.length===0" @click="handleSend" title="发送"><ArrowUp :size="16"/></button>
        <button v-else-if="sendState==='loading'" class="send-btn-inline loading" title="发送中..."><span class="btn-spinner"/></button>
        <button v-else-if="sendState==='sent'" class="send-btn-inline sent" title="已发送"><Check :size="16" class="btn-check"/></button>
        <button v-if="sendState==='loading'" class="stop-btn" @click="stopGeneration">⏹</button>
      </div>
    </div>

    </div><!-- /main-content -->
  </div><!-- /main-area -->
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { Check, ArrowUp } from 'lucide-vue-next'
import gsap from 'gsap'
import { marked } from 'marked'
import { animSpeed, Spring } from '../../animations/gsap'

marked.setOptions({ breaks: true, gfm: true })

const CHARS = { claude:{icon:'<svg viewBox="0 0 24 24" fill="none" stroke="#D97757" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z"/></svg>',color:'#D97757',name:'Claude'}, deepseek:{icon:'<svg viewBox="0 0 24 24" fill="#4C6EF5" style="width:16px;height:16px"><path d="M12 2l9 5v10l-9 5-9-5V7z"/></svg>',color:'#4C6EF5',name:'DeepSeek'}, openai:{icon:'<svg viewBox="0 0 24 24" fill="none" stroke="#10A37F" stroke-width="2" stroke-linecap="round" style="width:16px;height:16px"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>',color:'#10A37F',name:'OpenAI'} }
const MODELS = {
  claude:[{value:'claude-sonnet-4-20250506',label:'Claude-Sonnet-4'},{value:'claude-opus-4-7',label:'Claude-Opus-4.7'}],
  deepseek:[{value:'deepseek-v4-flash',label:'DeepSeek-V4-Flash'},{value:'deepseek-v4-pro',label:'DeepSeek-V4-Pro'}],
  openai:[{value:'gpt-4o-mini',label:'GPT-4o-Mini'},{value:'gpt-4o',label:'GPT-4o'}],
}

// ── State ──
const loading=ref(false),sendState=ref('idle'),text=ref(''),pendingImages=ref([]),ctxMenu=ref(null)
const agentSteps=ref([]),pendingApproval=ref(null),reasoningEffort=ref('auto'),reasoningText=ref(''),reasoningExpanded=ref(true)
const effortOpen=ref(false),modelOpen=ref(false)
const modelTrigger=ref(null),effortTrigger=ref(null)
const modelMenuStyle=ref({}),effortMenuStyle=ref({})
function openModel(){ const r=modelTrigger.value?.getBoundingClientRect(); if(r){ modelMenuStyle.value={position:'fixed',bottom:(window.innerHeight-r.top+6)+'px',left:r.left+'px',zIndex:99999} }; modelOpen.value=!modelOpen.value; effortOpen.value=false }
function openEffort(){ const r=effortTrigger.value?.getBoundingClientRect(); if(r){ effortMenuStyle.value={position:'fixed',bottom:(window.innerHeight-r.top+6)+'px',left:r.left+'px',zIndex:99999} }; effortOpen.value=!effortOpen.value; modelOpen.value=false }
const convModelLabel=computed(()=>currentModels.value.find(m=>m.value===convModel.value)?.label||'')
const EFFORT_OPTIONS=[
  { value:'auto', label:'自动', desc:'自动调节' },
  { value:'high', label:'High', desc:'标准推理' },
  { value:'max',  label:'Max',  desc:'深度推理' },
  { value:'xhigh',label:'XHigh',desc:'全力推理' },
]
const effortLabel=computed(()=>EFFORT_OPTIONS.find(o=>o.value===reasoningEffort.value)?.label||'自动')
const elapsedTime=ref(0); let elapsedTimer=null
const renaming=ref(null),renameText=ref(''),renameInput=ref(null)
const showHistory=ref(false),activeSessionId=ref(null)
const sessions=ref((()=>{try{return JSON.parse(localStorage.getItem('chat-sessions')||'[]')}catch{return[]}})())
const ta=ref(null),msgEnd=ref(null),msgArea=ref(null)
const activeAgentId=ref(localStorage.getItem('active-agent-id')||'')
const convs=ref([{id:Date.now(),title:'对话',agentId:activeAgentId.value,provider:localStorage.getItem('llm-provider')||'deepseek',messages:[],history:[],mode:'chat'}])
const viewConvs=computed(()=>convs.value.filter(c=>(c.mode||'chat')==='chat'&&(!activeAgentId.value||!c.agentId||c.agentId===activeAgentId.value)))
const viewIdx=ref(0); const conv=computed(()=>viewConvs.value[viewIdx.value]||convs.value[0])
const char=computed(()=>CHARS[conv.value.provider]||CHARS.deepseek)
const currentModels=computed(()=>MODELS[conv.value.provider]||MODELS.claude)
const convModel=computed({get(){const c=conv.value;if(c._model)return c._model;const s=localStorage.getItem("llm-model");if(s){for(const m of currentModels.value){if(m.value===s)return s}}return currentModels.value[0]?.value||""},set(v){conv.value._model=v;localStorage.setItem("llm-model",v);window.electronAPI?.loadConfig().then(c=>{if(c){c.model=v;window.electronAPI?.saveConfig(c)}})}})
const allAgents=ref([])
const userAvatar=ref(localStorage.getItem('user-avatar')||''),avatarColor=ref(localStorage.getItem('user-avatar-color')||'#6366F1')
const welcomeName=computed(()=>(allAgents.value.find(a=>a.isActive)||{}).name||char.value.name)
const welcomeIcon=computed(()=>(allAgents.value.find(a=>a.isActive)||{}).icon||char.value.icon)
const welcomeColor=computed(()=>((allAgents.value.find(a=>a.isActive)||{}).color||char.value.color)+'18')

// ── Scroll ──
let userAtBottom=true,scrollObserver=null
function setupScrollObserver(){if(!msgArea.value)return;if(scrollObserver)scrollObserver.disconnect();scrollObserver=new IntersectionObserver(([e])=>{userAtBottom=e.isIntersecting},{root:msgArea.value,threshold:.1});if(msgEnd.value)scrollObserver.observe(msgEnd.value)}
function scrollDown(){if(userAtBottom&&msgEnd.value)msgEnd.value.scrollIntoView({behavior:'smooth',block:'end'})}

// ── Helpers ──
function isStreamingMsg(m,i){return i===conv.value.messages.length-1&&loading.value&&m.role==='assistant'}
function renderMarkdown(t){if(!t)return'';try{return marked.parse(t)}catch{return t}}
function fmtTime(ts){const d=new Date(ts);return d.toDateString()===new Date().toDateString()?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):d.toLocaleDateString([],{month:'short',day:'numeric'})+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
function getNextId(){let max=0;for(const c of convs.value){if(c.id>max)max=c.id};return Math.max(Date.now(),max+1)}
function fmtApprovalInput(i){if(!i)return'';if(typeof i==='string')return i;try{return JSON.stringify(i,null,2)}catch{return String(i)}}

// ── Convs ──
function newConv(p){const id=Date.now();convs.value=[{id,title:'对话',agentId:activeAgentId.value,provider:p||'deepseek',messages:[],history:[],mode:'chat'}];viewIdx.value=0;activeSessionId.value=null}
let _la=0; function addNewConv(){if(Date.now()-_la<300)return;_la=Date.now();saveAllSessions();newConv(localStorage.getItem('llm-provider')||'deepseek')}
function switchConv(i){if(i!==viewIdx.value)viewIdx.value=i}
let _lc=0; function closeConv(i){if(Date.now()-_lc<300)return;_lc=Date.now();const vc=viewConvs.value;if(vc.length<=1)return;const r=vc[i],gi=convs.value.findIndex(c=>c.id===r.id);convs.value.splice(gi,1);const nv=viewConvs.value;if(viewIdx.value>=nv.length)viewIdx.value=nv.length-1;ctxMenu.value=null}
function clearConv(){const c=conv.value;c.messages=[];c.history=[];c.title='对话 '+c.id}
function renameConv(i){ctxMenu.value=null;renaming.value=i;renameText.value=viewConvs.value[i].title;nextTick(()=>renameInput.value?.focus())}
function doRename(){const t=renameText.value.trim();if(t&&renaming.value!==null){const vc=viewConvs.value;if(vc[renaming.value])vc[renaming.value].title=t}renaming.value=null}
function copyMsg(c){navigator.clipboard.writeText(c).then(()=>{for(const m of conv.value.messages){if(m.content===c){m._copied=true;setTimeout(()=>{m._copied=false},1800);break}}}).catch(()=>{})}

// ── 对话历史持久化 ──
function _cleanMessages(msgs) {
  return (msgs || []).slice(-100).map(m => ({ role: m.role, content: m.content || '', images: m.images?.length ? m.images.slice() : undefined }))
}
function _sessionEntry(c) {
  const userMsgs = c.messages.filter(m => m.role === 'user')
  const title = userMsgs.length ? userMsgs[0].content.slice(0, 40) : (c.title || '对话')
  return { id: c.id, title, updatedAt: Date.now(), count: c.messages.length, provider: c.provider, messages: _cleanMessages(c.messages), agentId: c.agentId, mode: c.mode || 'chat' }
}
function saveAllSessions() {
  // 保存所有有消息的对话
  const now = Date.now()
  const list = sessions.value.slice()
  for (const c of convs.value) {
    if (!c.messages.length) continue
    const entry = _sessionEntry(c)
    const idx = list.findIndex(s => s.id === c.id)
    if (idx >= 0) {
      entry.date = list[idx].date || entry.date  // 保留原始创建日期
      list[idx] = entry
    } else {
      const now = new Date()
      entry.date = now.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' ' + now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      list.unshift(entry)
    }
  }
  // 去重 + 排序 + 限20
  const seen = new Set()
  const unique = []
  for (const s of list) {
    if (!seen.has(s.id)) { seen.add(s.id); unique.push(s) }
  }
  unique.sort((a, b) => (b.updatedAt||b.id) - (a.updatedAt||a.id))
  if (unique.length > 20) unique.length = 20
  sessions.value = unique
  try { localStorage.setItem('chat-sessions', JSON.stringify(unique)) } catch(e) {}
}
function loadSession(i) {
  const s = sessions.value[i]; if (!s || !s.messages?.length) return
  saveAllSessions()
  // 查找是否已打开（按 id 精确匹配）
  let vi = viewConvs.value.findIndex(c => c.id === s.id)
  if (vi >= 0) {
    viewIdx.value = vi; showHistory.value = false; activeSessionId.value = s.id; nextTick(scrollDown); return
  }
  // 替换当前空对话，或新增标签
  const cur = conv.value
  if (cur && !cur.messages.length) {
    // 当前标签是空的 → 直接替换
    const ci = convs.value.findIndex(c => c.id === cur.id)
    if (ci >= 0) {
      convs.value[ci] = { id: s.id, title: s.title, agentId: activeAgentId.value, provider: s.provider || 'deepseek', messages: s.messages, history: [], mode: 'chat' }
      vi = viewConvs.value.findIndex(c => c.id === s.id)
      if (vi >= 0) { viewIdx.value = vi; showHistory.value = false; activeSessionId.value = s.id; nextTick(scrollDown); return }
    }
  }
  // 新增标签
  if (convs.value.length >= 8) convs.value.shift()
  convs.value.push({ id: s.id, title: s.title, agentId: activeAgentId.value, provider: s.provider || 'deepseek', messages: s.messages, history: [], mode: 'chat' })
  viewIdx.value = viewConvs.value.length - 1
  activeSessionId.value = s.id
  showHistory.value = false
  nextTick(scrollDown)
}
function deleteSession(i) {
  const s = sessions.value[i]; if (!s) return
  sessions.value.splice(i, 1)
  // 同时从打开标签中移除
  const ci = convs.value.findIndex(c => c.id === s.id)
  if (ci >= 0 && convs.value.length > 1) convs.value.splice(ci, 1)
  if (activeSessionId.value === s.id) activeSessionId.value = null
  try { localStorage.setItem('chat-sessions', JSON.stringify(sessions.value)) } catch(e) {}
}
let _saveTimeout = null
watch(() => convs.value.map(c => c.messages.length + '|' + (c.messages[c.messages.length-1]?.content||'').slice(0,10)).join(','), () => {
  clearTimeout(_saveTimeout)
  _saveTimeout = setTimeout(saveAllSessions, 2000)
})


// ── Timer ──
function startTimer(){elapsedTime.value=0;elapsedTimer=setInterval(()=>{elapsedTime.value++},1000)}
function stopTimer(){if(elapsedTimer){clearInterval(elapsedTimer);elapsedTimer=null};elapsedTime.value=0}

// ── Music Playback ──
function handleMusicCmd(t) {
  let a = window.__musicAudio;
  // 下一首/换一首 → 直接切队列，不走 Agent
  if (/^(下一首|换一首|切歌|next|跳过)/.test(t)) {
    try {
      let pl = JSON.parse(localStorage.getItem('music-playlist') || '[]');
      let cur = window.__musicCurrentTrack;
      if (pl.length > 0 && cur) {
        let idx = pl.findIndex(function(s){return String(s.songId)===String(cur.songId)});
        if (idx >= 0 && idx < pl.length - 1) {
          let next = pl[idx + 1];
          triggerMusicPlay(next.songId, next.name, next.artist, next.cover, '下一首');
          return;
        }
      }
    } catch(e) {}
  }
  // 暂停/继续
  if (/^(暂停|stop)/.test(t)) { if(a) a.pause(); return; }
  if (/^(继续|播放|resume)/.test(t)) { if(a) a.play().catch(function(){}); return; }
}

function getGlobalAudio() {
  if (!window.__musicAudio) {
    window.__musicAudio = new Audio();
  }
  return window.__musicAudio;
}

async function triggerMusicPlay(songId, songName, artist, cover, reason) {
  try {
    let r = await window.electronAPI?.neteaseSongUrl({ songId, level: 'higher' });
    if (!r?.ok || !r.data?.url) {
      r = await window.electronAPI?.neteaseSongUrl({ songId, level: 'standard' });
    }
    if (!r?.ok || !r.data?.url) {
      console.warn('[Chat] 歌曲无播放源:', songName, r);
      return false;
    }
    getGlobalAudio().src = r.data.url;
    getGlobalAudio().play().catch(() => {});
    window.__musicCurrentTrack = { songId: String(songId), name: songName, artist: artist || '', cover: cover || '' };
    // 播放时：读 stripAndSaveMusicList 刚存的歌单，把当前歌插入第一位；若歌单为空则只放当前这首
    try {
      let pl = JSON.parse(localStorage.getItem('music-playlist') || '[]');
      const sid = String(songId);
      // 去掉当前歌的旧位置（如果重复播放）
      pl = pl.filter(s => String(s.songId) !== sid);
      // 当前歌插入第一位
      pl.unshift({ songId: sid, name: songName, artist: artist || '', cover: cover || '' });
      if (pl.length > 30) pl.length = 30;
      console.log('[Music] triggerMusicPlay 歌单:', pl.length, '首, 当前:', songName);
      localStorage.setItem('music-playlist', JSON.stringify(pl));
      window.dispatchEvent(new CustomEvent('music-playlist-updated'));
    } catch {}
    window.dispatchEvent(new CustomEvent('music-nowplaying', {
      detail: { songId, name: songName, artist, cover, reason }
    }));
    return true;
  } catch { return false; }
}

function parseNowPlaying(content) {
  // 清理 MUSIC_LIST（不显示 + 保存歌单）
  stripAndSaveMusicList(content);
  content = content.replace(/MUSIC_?LIST[\s\S]*$/i, '').trim();
  const m = content.match(/NOW_PLAYING\s*(\{[\s\S]*?\})/);
  if (!m) return { content, song: null };
  try {
    const song = JSON.parse(m[1]);
    let text = content.replace(m[0], '').trim();
    if (!text) text = `♪ ${song.name} — ${song.artist || '未知歌手'}`;
    return { content: text, song };
  } catch { console.warn('[Music] NOW_PLAYING JSON parse failed:', m[1]); return { content, song: null }; }
}

// ── 音乐歌单存储 + 显示清理 ──
function stripAndSaveMusicList(text) {
  // 匹配 MUSIC_LIST [...] 或 MUSICLIST {...}{...}（LLM 可能拼错格式）
  let songs = null;
  // 标准格式: MUSIC_LIST [{"songId":...},...]
  const m1 = text.match(/MUSIC_?LIST\s*(\[[\s\S]*?\])/);
  if (m1) {
    try { songs = JSON.parse(m1[1]); } catch {}
  }
  // LLM 产出的非标准格式: MUSICLIST\n{...}\n{...}（逐行 JSON 对象）
  if (!songs) {
    const m2 = text.match(/MUSIC_?LIST\s*([\s\S]*?)$/);
    if (m2) {
      const objs = [];
      const re = /\{[^}]+\}/g;
      let objMatch;
      while ((objMatch = re.exec(m2[1])) !== null) {
        try {
          const obj = JSON.parse(objMatch[0]);
          const id = obj.songId || obj.songld || obj.id;
          const name = obj.name || obj.songName || '';
          if (id && name) objs.push({ songId: String(id), name, artist: obj.artist || '', cover: obj.cover || '' });
        } catch {}
      }
      if (objs.length) songs = objs;
    }
  }

  if (songs && Array.isArray(songs) && songs.length) {
    // 新推荐直接替换旧歌单
    const clean = [];
    for (const s of songs) {
      const id = s.songId || s.songld || s.id;
      if (id) clean.push({ songId: String(id), name: s.name || '', artist: s.artist || '', cover: s.cover || '' });
    }
    console.log('[Music] 歌单已替换:', clean.length, '首', clean.map(s=>s.name).join(', '));
    localStorage.setItem('music-playlist', JSON.stringify(clean));
    window.dispatchEvent(new CustomEvent('music-playlist-updated'));
  }

  // 从显示文本中移除所有 MUSIC_LIST / MUSICLIST 相关内容
  return text.replace(/MUSIC_?LIST[\s\S]*$/i, '').trim();
}

function onKeydown(e){ if(loading.value)return; if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();clearConv();return}if((e.metaKey||e.ctrlKey||e.shiftKey)&&e.key==='Enter')return;if(e.key==='Enter'){e.preventDefault();handleSend()}}
function onPaste(e){const items=e.clipboardData?.items;if(!items)return;for(const item of items){if(item.type.startsWith('image/')){e.preventDefault();const f=item.getAsFile();if(!f)continue;const r=new FileReader();r.onload=ev=>pendingImages.value.push({data:ev.target.result,file:f});r.readAsDataURL(f)}}}

// ── Stop ──
let activeAbortController=null
function cleanupListeners(u){for(const x of(u||[])){try{x()}catch{}}if(activeAbortController){activeAbortController.abort();activeAbortController=null}}
function stopGeneration(){if(!loading.value)return;if(activeAbortController){activeAbortController.abort();activeAbortController=null}stopTimer();loading.value=false;sendState.value='idle';agentSteps.value=[];reasoningText.value='';reasoningExpanded.value=false;pendingApproval.value=null;const c=conv.value;if(c.messages.length>0&&c.messages[c.messages.length-1].role==='assistant')c.messages.pop()}
function approveTool(ok){if(pendingApproval.value?.approvalId){if(!ok){const el=document.querySelector('.approval-dialog');if(el){el.classList.add('shake');setTimeout(()=>el.classList.remove('shake'),400)}setTimeout(()=>{window.electronAPI?.agentApproveTool(pendingApproval.value.approvalId,ok);agentSteps.value.push({type:'thought',content:'用户拒绝了执行'});pendingApproval.value=null},300);return}window.electronAPI?.agentApproveTool(pendingApproval.value.approvalId,ok);agentSteps.value.push({type:'thought',content:'用户批准了执行'});pendingApproval.value=null}}

// ── Send ──
async function handleSend(){let t=text.value.trim();let hi=pendingImages.value.length>0;if(!t&&!hi)return;let activatedSkill='';if(t.startsWith('/')){let sp=t.indexOf(' ');let sn=sp>0?t.slice(1,sp):t.slice(1);if(sn.length>0){activatedSkill=sn;t=sp>0?t.slice(sp+1).trim():'请执行你的任务'}};// 音乐控制命令前端拦截（不走 Agent）
if(/^(下一首|换一首|切歌|next|跳过|暂停|继续|停止|播放|静音|音量)/.test(t)){text.value='';pendingImages.value=[];handleMusicCmd(t);return};let uc=t;const il=hi?pendingImages.value.map(i=>i.data):[];text.value='';pendingImages.value=[];const c=conv.value;const um={role:'user',content:uc,timestamp:new Date()};if(il.length>0){um.images=il;um._previewImages=il}c.messages.push(um);const hm={role:'user',content:uc};if(il.length>0){hm.images=il;hm.content=uc||'请分析这张图片'}// 注入待发送的音乐反馈（暂存，发送成功后再清空）
let fbqBackup=null;try{const fbq=JSON.parse(localStorage.getItem('music-feedback-queue')||'[]');if(fbq.length>0){fbqBackup=fbq;const fbText='[系统通知] 用户最近的音乐行为: '+fbq.map(f=>`${f.action==='complete'?'听完了':f.action==='skip_early'?'快速切掉了':f.action==='skip'?'切掉了':'重播了'}《${f.songName}》(${f.artist})`).join('; ');c.history.push({role:'user',content:fbText})}}catch{}c.history.push(hm);loading.value=true;sendState.value='loading';reasoningText.value='';reasoningExpanded.value=true;startTimer();let sc=await window.electronAPI?.loadConfig();if(!sc){const s=localStorage.getItem('llm-config');if(s){try{sc=JSON.parse(s)}catch{}}}if(!sc){stopTimer();loading.value=false;sendState.value='idle';return}if(convModel.value)sc.model=convModel.value;sc.reasoningEffort=reasoningEffort.value;const ok=await runAgent(c,sc,activatedSkill||'');
// 发送成功后清空反馈队列
if(ok&&fbqBackup){try{localStorage.setItem('music-feedback-queue','[]')}catch{}}
if(!ok){stopTimer();loading.value=false;sendState.value='idle'}}

async function runAgent(c,config,activatedSkill){let mi=-1,us=[],fullContent='',firstContent=true,msgCreated=false;cleanupListeners(null);activeAbortController=new AbortController();const sig=activeAbortController.signal;try{const rd=await window.electronAPI?.agentGetReady();if(!rd?.ready)return false;const steps=[];agentSteps.value=steps;const lr={text:''};function em(){if(!msgCreated){c.messages.push({role:'assistant',content:'',timestamp:new Date(),_reasoning:'',_reasoningOpen:true});mi=c.messages.length-1;msgCreated=true}};function sd(){nextTick(()=>msgEnd.value?.scrollIntoView({behavior:'smooth'}))};us.push(window.electronAPI.onAgentThought(d=>{const x=d?.data||d;const t=typeof x==='string'?x:x?.content||'';if(t){steps.push({type:'thought',content:t});sd()}}));us.push(window.electronAPI.onAgentAction(d=>{const x=d?.data||d;steps.push({type:'action',tool:x?.tool||'未知工具',input:x?.input||x,round:x?.round||''});sd()}));us.push(window.electronAPI.onAgentObservation(d=>{const x=d?.data||d;steps.push({type:'observation',tool:x?.tool||'工具',content:x?.content||String(x),round:x?.round||''});sd()}));us.push(window.electronAPI.onAgentChunk(d=>{if(sig.aborted)return;em();const x=d?.data||d;if(firstContent){fullContent='';firstContent=false};fullContent+=x?.content||'';if(mi>=0&&c.messages[mi])c.messages[mi].content=fullContent.replace(/^\[emotion:\w+\]\s*\n?/,'');sd()}));us.push(window.electronAPI.onAgentReasoningChunk(d=>{if(sig.aborted)return;em();const x=d?.data||d;const ck=x?.content||'';if(ck==='.')return;lr.text+=ck;reasoningText.value=lr.text;sd()}));us.push(window.electronAPI.onAgentDone(d=>{if(sig.aborted)return;em();const x=d?.data||d;const finalContent=(x?.content||fullContent).replace(/^\[emotion:\w+\]\s*\n?/,'');if(finalContent&&mi>=0&&c.messages[mi]){stripAndSaveMusicList(finalContent);const parsed=parseNowPlaying(finalContent);c.messages[mi].content=parsed.content;if(parsed.song){triggerMusicPlay(parsed.song.songId,parsed.song.name,parsed.song.artist,parsed.song.cover,parsed.song.reason)}}if(mi>=0&&c.messages[mi]){c.messages[mi].elapsed=elapsedTime.value;c.messages[mi]._steps=[...steps]}}));us.push(window.electronAPI.onAgentError(d=>{if(sig.aborted)return;em();const x=d?.data||d;if(mi>=0&&c.messages[mi])c.messages[mi].content=`❌ ${x?.content||'Agent 执行出错'}`}));us.push(window.electronAPI.onAgentToolApprovalRequest(d=>{const x=d?.data||d;pendingApproval.value={approvalId:x?.approval_id||'',tool:x?.tool||'',input:x?.input||{}}}));// 注入音乐上下文
let _mCtx = window.__musicCurrentTrack;
let _ctxMsg = null;
if (_mCtx && _mCtx.songId) {
  try {
    let _pl = JSON.parse(localStorage.getItem('music-playlist') || '[]');
    let _curIdx = _pl.findIndex(function(s){return String(s.songId)===String(_mCtx.songId)});
    _ctxMsg = '[系统] 当前正在播放: ' + _mCtx.name + ' - ' + (_mCtx.artist||'');
    if (_curIdx >= 0 && _curIdx < _pl.length - 1) {
      let _next = _pl.slice(_curIdx+1, _curIdx+4).map(function(s){return s.name+' - '+s.artist+' (songId='+s.songId+')'}).join('; ');
      if (_next) _ctxMsg += '。接下来: ' + _next;
    }
    if (_curIdx > 0) {
      let _prev = _pl[_curIdx-1];
      if (_prev) _ctxMsg += '。上一首: ' + _prev.name + ' - ' + _prev.artist + ' (songId='+_prev.songId+')';
    }
  } catch(e) {}
};const ph=JSON.parse(JSON.stringify(c.history));if(_ctxMsg){ph.splice(Math.max(0,ph.length-1),0,{role:'user',content:_ctxMsg})};const pc=JSON.parse(JSON.stringify(config));pc.userNickname=localStorage.getItem('user-nickname')||'';pc.agentPersonality=localStorage.getItem('agent-personality')||'default';pc.customPersonalities=JSON.parse(localStorage.getItem('custom-personalities')||'[]');pc.agentId=activeAgentId.value||'';const result=await window.electronAPI.agentChat(pc,ph,`conv-${c.id}`,'chat',activatedSkill||'');cleanupListeners(us);const sr=lr.text||reasoningText.value;if(mi>=0&&c.messages[mi]?.role==='assistant'&&sr){c.messages[mi]={...c.messages[mi],_reasoning:sr,_reasoningOpen:true}};reasoningText.value='';agentSteps.value=[];reasoningExpanded.value=false;pendingApproval.value=null;stopTimer();loading.value=false;sendState.value='sent';setTimeout(()=>{if(sendState.value==='sent')sendState.value='idle'},1500);activeAbortController=null;let fc=(c.messages[mi]?.content||'').replace(/^\[emotion:\w+\]\s*\n?/,'');stripAndSaveMusicList(fc);if(fc){const parsed=parseNowPlaying(fc);if(parsed.song){fc=parsed.content;if(mi>=0)c.messages[mi].content=fc;triggerMusicPlay(parsed.song.songId,parsed.song.name,parsed.song.artist,parsed.song.cover,parsed.song.reason)}};if(fc&&!fc.startsWith('❌'))c.history.push({role:'assistant',content:fc});return true}catch(err){console.error('[Agent]',err);if(mi>=0&&c.messages[mi]?.role==='assistant')c.messages.pop();return false}finally{cleanupListeners(us);agentSteps.value=[];pendingApproval.value=null;activeAbortController=null}}

// ── Feed ──
async function feedFile(data){const c=conv.value;const dn=data.name||'未知文件';let um='';let hasBinary=false;let binaryImages=[];if(window.electronAPI?.readFileContent){const r=await window.electronAPI.readFileContent(data.path);if(r.success){if(r.binary){hasBinary=true;const kb=Math.round(r.size/1024);um=`📎 喂食了文件: ${dn} (${kb}KB, ${r.ext})\n\n[系统已将文件内容编码，Agent 可使用 read_image 工具查看]`;binaryImages.push(r.base64)}else{um=`📎 喂食了文件: ${dn}\n\n\`\`\`\n${r.content.slice(0,3000)}\n\`\`\``}}}if(!um)um=`📎 喂食了文件: ${dn}（无法读取文件内容）`;const m={role:'user',content:um,timestamp:new Date()};if(hasBinary){m.images=binaryImages;m._previewImages=binaryImages}c.messages.push(m);const hm={role:'user',content:um};if(hasBinary){hm.images=binaryImages}c.history.push(hm);loading.value=true;let sc=await window.electronAPI?.loadConfig();if(!sc){const s=localStorage.getItem('llm-config');if(s){try{sc=JSON.parse(s)}catch{}}};if(!sc){loading.value=false;sendState.value='idle';return};if(convModel.value)sc.model=convModel.value;const ok=await runAgent(c,sc,'');if(!ok){stopTimer();loading.value=false;sendState.value='idle'}}

// ── Anim ──
function onTabBeforeEnter(el){el.style.opacity='0';el.style.transform='translateX(-12px) scale(0.9)'}
function onTabEnter(el,done){const s=animSpeed();gsap.to(el,{opacity:1,x:0,scale:1,duration:.28/s,ease:'back.out(1.5)',onComplete:done})}
function onTabLeave(el,done){const s=animSpeed();gsap.to(el,{opacity:0,x:-6,scale:.93,duration:.18/s,ease:'power2.in',onComplete:done})}
function animateDialog(sel){nextTick(()=>{const el=document.querySelector(sel);if(!el)return;const s=animSpeed();gsap.from(el,{y:24,scale:.94,opacity:0,duration:.4/s,ease:'back.out(1.3)'})})}
function animateWelcome(){nextTick(()=>{const w=msgArea.value?.querySelector('.welcome-placeholder');if(!w)return;const s=animSpeed();const tl=gsap.timeline();tl.from(w.querySelector('.welcome-avatar-ring'),{scale:0,opacity:0,duration:.5/s,ease:'back.out(2)'});tl.from(w.querySelector('.welcome-title'),{y:12,opacity:0,duration:.4/s,ease:'power2.out'},'-=0.15');tl.from(w.querySelector('.welcome-sub'),{y:8,opacity:0,duration:.3/s,ease:'power2.out'},'-=0.2');gsap.to(w.querySelector('.welcome-avatar-ring'),{scale:1.005,duration:4/s,ease:'power1.inOut',repeat:-1,yoyo:true})})}

// ── Watchers ──
watch(()=>conv.value.messages.length,()=>{nextTick(()=>{scrollDown();const rows=msgArea.value?.querySelectorAll('.message-row');if(rows&&rows.length>0){const lr=rows[rows.length-1];if(!lr.dataset.gsapAnimated){lr.dataset.gsapAnimated='1';const s=animSpeed();gsap.from(lr,{y:18,opacity:0,scale:.96,duration:Spring.snappy.duration/s,ease:Spring.snappy.ease})}}})})
watch(loading,v=>window.electronAPI?.notifyWorking(v))

// ── Lifecycle ──
let removeFileFed=null,agentPoll=null,unwatchRename=null,unwatchApproval=null
onMounted(async()=>{try{const r=await window.electronAPI?.agentList();allAgents.value=r?.data?.agents||r?.agents||[]}catch{allAgents.value=[]};removeFileFed=window.electronAPI?.onFileFed?.(d=>feedFile(d));agentPoll=setInterval(()=>{const s=localStorage.getItem('active-agent-id');if(s&&s!==activeAgentId.value)activeAgentId.value=s},2000);window.addEventListener('beforeunload', saveAllSessions);nextTick(()=>{setupScrollObserver();animateWelcome()});unwatchRename=watch(renaming,v=>{if(v!==null)nextTick(()=>animateDialog('.rename-dialog'))});unwatchApproval=watch(pendingApproval,v=>{if(v)nextTick(()=>animateDialog('.approval-dialog'))});})
onUnmounted(()=>{clearTimeout(_saveTimeout);saveAllSessions();removeFileFed?.();if(agentPoll)clearInterval(agentPoll);if(elapsedTimer)clearInterval(elapsedTimer);if(scrollObserver)scrollObserver.disconnect();if(activeAbortController){activeAbortController.abort();activeAbortController=null};unwatchRename?.();unwatchApproval?.()})
</script>
