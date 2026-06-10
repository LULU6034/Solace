<template>
  <div class="main-area">
    <div class="header-bar">
      <div class="conversation-pills">
        <TransitionGroup @before-enter="onTabBeforeEnter" @enter="onTabEnter" @leave="onTabLeave">
          <div v-for="(c, i) in viewConvs" :key="c.id" class="pill-wrap"
            @contextmenu.prevent="ctxMenu = { idx: i, x: $event.clientX, y: $event.clientY }">
            <button class="conv-pill" :class="{ active: i === viewIdx }" @click="switchConv(i)">
              <span class="pill-label">{{ c.title }}</span>
              <span v-if="viewConvs.length > 1" class="pill-close" @click.stop="closeConv(i)" title="关闭对话">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
              </span>
            </button>
          </div>
        </TransitionGroup>
      </div>
      <div class="tab-actions">
        <button class="add-btn" title="新建对话" @click.stop="addNewConv">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M9 3v12M3 9h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>

    <div v-if="ctxMenu" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @click="ctxMenu = null" @mouseleave="ctxMenu = null">
      <button class="ctx-menu-item" @click="renameConv(ctxMenu.idx)">重命名</button>
      <button v-if="viewConvs.length > 1" class="ctx-menu-item danger" @click.stop="closeConv(ctxMenu.idx)">关闭对话</button>
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
          <span v-if="!msg._expert?.avatarUrl">{{ msg._expert?.icon || char.icon }}</span>
        </div>
        <div v-else class="msg-avatar user-avatar">
          <img v-if="userAvatar.startsWith('data:')" :src="userAvatar" class="avatar-img" />
          <div v-else class="avatar-geo" :style="{ background: avatarColor }">
            <svg viewBox="0 0 40 40" class="avatar-geo-svg">
              <path d="M12 28 Q20 8 28 28" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M8 22 Q20 16 32 22" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1.5" stroke-linecap="round"/>
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
      <div ref="msgEnd"/>
    </div>

    <div class="input-area">
      <div v-if="pendingImages.length>0" class="img-preview-strip">
        <div v-for="(img,i) in pendingImages" :key="i" class="img-preview"><img :src="img.data"/><button class="img-remove" @click="pendingImages.splice(i,1)">&times;</button></div>
      </div>
      <div class="input-toolbar-top">
        <select class="model-select" v-model="convModel" :disabled="loading">
          <option v-for="m in currentModels" :key="m.value" :value="m.value">{{ m.label }}</option>
        </select>
        <button v-if="supportsSpeech" class="mic-btn-inline" :class="{recording:isRecording}" :title="isRecording?'停止':'语音'" @click="toggleSpeech">{{ isRecording?'⬤':'🎤' }}</button>
        <button class="reasoning-btn" :class="{on:reasoningOn}" @click="reasoningOn=!reasoningOn" :title="reasoningOn?'关闭推理':'开启推理'"><Brain :size="15"/></button>
      </div>
      <div class="input-box">
        <textarea ref="ta" v-model="text" placeholder="输入消息..." @keydown="onKeydown" @paste="onPaste" rows="1"/>
        <button v-if="sendState==='idle'" class="send-btn-inline" :disabled="!text.trim() && pendingImages.length===0" @click="handleSend" title="发送"><ArrowUp :size="16"/></button>
        <button v-else-if="sendState==='loading'" class="send-btn-inline loading" title="发送中..."><span class="btn-spinner"/></button>
        <button v-else-if="sendState==='sent'" class="send-btn-inline sent" title="已发送"><Check :size="16" class="btn-check"/></button>
        <button v-if="sendState==='loading'" class="stop-btn" @click="stopGeneration">⏹</button>
      </div>
    </div>

    <div v-if="pendingApproval" class="approval-overlay" @click.self="approveTool(false)">
      <div class="approval-dialog">
        <div class="approval-icon">⚠️</div>
        <div class="approval-title">确认执行命令</div>
        <div class="approval-tool-name">{{ pendingApproval.tool }}</div>
        <pre class="approval-input">{{ fmtApprovalInput(pendingApproval.input) }}</pre>
        <div class="approval-warning">此操作需要你的批准。请确认命令安全后再执行。</div>
        <div class="approval-actions">
          <button class="setting-btn secondary" @click="approveTool(false)">拒绝</button>
          <button class="setting-btn primary approval-allow" @click="approveTool(true)">批准执行</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { Brain, Check, ArrowUp } from 'lucide-vue-next'
import gsap from 'gsap'
import { marked } from 'marked'
import { animSpeed, Spring } from '../animations/gsap'

marked.setOptions({ breaks: true, gfm: true })

const CHARS = { claude:{icon:'🦞',color:'#B7A48E',name:'Clawd'}, deepseek:{icon:'🐟',color:'#9BB7AA',name:'小鱼'}, openai:{icon:'⌨️',color:'#9DC0AF',name:'Coco'} }
const MODELS = {
  claude:[{value:'claude-sonnet-4-20250506',label:'Claude-Sonnet-4'},{value:'claude-opus-4-7',label:'Claude-Opus-4.7'}],
  deepseek:[{value:'deepseek-v4-flash',label:'DeepSeek-V4-Flash'},{value:'deepseek-v4-pro',label:'DeepSeek-V4-Pro'}],
  openai:[{value:'gpt-4o-mini',label:'GPT-4o-Mini'},{value:'gpt-4o',label:'GPT-4o'}],
}

// ── State ──
const loading=ref(false),sendState=ref('idle'),text=ref(''),pendingImages=ref([]),ctxMenu=ref(null)
const agentSteps=ref([]),pendingApproval=ref(null),reasoningOn=ref(true),reasoningText=ref(''),reasoningExpanded=ref(true)
const elapsedTime=ref(0); let elapsedTimer=null
const renaming=ref(null),renameText=ref(''),renameInput=ref(null)
const ta=ref(null),msgEnd=ref(null),msgArea=ref(null)
const activeAgentId=ref(localStorage.getItem('active-agent-id')||'')
const convs=ref([{id:1,title:'对话',agentId:activeAgentId.value,provider:localStorage.getItem('llm-provider')||'deepseek',messages:[],history:[],mode:'chat'}])
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
const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition
const supportsSpeech=ref(!!SpeechRecognition),isRecording=ref(false); let recognition=null

// ── Scroll ──
let userAtBottom=true,scrollObserver=null
function setupScrollObserver(){if(!msgArea.value)return;if(scrollObserver)scrollObserver.disconnect();scrollObserver=new IntersectionObserver(([e])=>{userAtBottom=e.isIntersecting},{root:msgArea.value,threshold:.1});if(msgEnd.value)scrollObserver.observe(msgEnd.value)}
function scrollDown(){if(userAtBottom&&msgEnd.value)msgEnd.value.scrollIntoView({behavior:'smooth',block:'end'})}

// ── Helpers ──
function isStreamingMsg(m,i){return i===conv.value.messages.length-1&&loading.value&&m.role==='assistant'}
function renderMarkdown(t){if(!t)return'';try{return marked.parse(t)}catch{return t}}
function fmtTime(ts){const d=new Date(ts);return d.toDateString()===new Date().toDateString()?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):d.toLocaleDateString([],{month:'short',day:'numeric'})+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
function getNextId(){return Math.max(1,...convs.value.map(c=>c.id))+1}
function fmtApprovalInput(i){if(!i)return'';if(typeof i==='string')return i;try{return JSON.stringify(i,null,2)}catch{return String(i)}}

// ── Convs ──
function newConv(p){if(convs.value.length>=8)return;const t=convs.value.filter(c=>c.mode==='chat').length===0?'对话':`对话 ${getNextId()}`;convs.value.push({id:getNextId(),title:t,agentId:activeAgentId.value,provider:p||'deepseek',messages:[],history:[],mode:'chat'})}
let _la=0; function addNewConv(){if(Date.now()-_la<300)return;_la=Date.now();newConv(localStorage.getItem('llm-provider')||'deepseek')}
function switchConv(i){if(i!==viewIdx.value)viewIdx.value=i}
let _lc=0; function closeConv(i){if(Date.now()-_lc<300)return;_lc=Date.now();const vc=viewConvs.value;if(vc.length<=1)return;const r=vc[i],gi=convs.value.findIndex(c=>c.id===r.id);convs.value.splice(gi,1);const nv=viewConvs.value;if(viewIdx.value>=nv.length)viewIdx.value=nv.length-1;ctxMenu.value=null}
function clearConv(){const c=conv.value;c.messages=[];c.history=[];c.title='对话 '+c.id}
function renameConv(i){ctxMenu.value=null;renaming.value=i;renameText.value=viewConvs.value[i].title;nextTick(()=>renameInput.value?.focus())}
function doRename(){const t=renameText.value.trim();if(t&&renaming.value!==null){const vc=viewConvs.value;if(vc[renaming.value])vc[renaming.value].title=t}renaming.value=null}
function copyMsg(c){navigator.clipboard.writeText(c).then(()=>{for(const m of conv.value.messages){if(m.content===c){m._copied=true;setTimeout(()=>{m._copied=false},1800);break}}}).catch(()=>{})}

// ── Timer ──
function startTimer(){elapsedTime.value=0;elapsedTimer=setInterval(()=>{elapsedTime.value++},1000)}
function stopTimer(){if(elapsedTimer){clearInterval(elapsedTimer);elapsedTimer=null};elapsedTime.value=0}

// ── Music Playback ──
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
    window.dispatchEvent(new CustomEvent('music-nowplaying', {
      detail: { songId, name: songName, artist, cover, reason }
    }));
    return true;
  } catch { return false; }
}

function parseNowPlaying(content) {
  const m = content.match(/NOW_PLAYING\s*(\{[\s\S]*?\})/);
  if (!m) return { content, song: null };
  try {
    const song = JSON.parse(m[1]);
    return { content: content.replace(m[0], '').trim(), song };
  } catch { console.warn('[Music] NOW_PLAYING JSON parse failed:', m[1]); return { content, song: null }; }
}

// ── Speech ──
function toggleSpeech(){if(isRecording.value){stopSpeech();return}if(!SpeechRecognition)return;recognition=new SpeechRecognition();recognition.continuous=true;recognition.interimResults=true;recognition.lang='zh-CN';recognition.onresult=e=>{let t='';for(let i=e.resultIndex;i<e.results.length;i++)t+=e.results[i][0].transcript;text.value=t};recognition.onerror=()=>stopSpeech();recognition.onend=()=>{isRecording.value=false;recognition=null};recognition.start();isRecording.value=true}
function stopSpeech(){if(recognition){recognition.stop();recognition=null};isRecording.value=false}
function onKeydown(e){if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();clearConv();return}if((e.metaKey||e.ctrlKey||e.shiftKey)&&e.key==='Enter')return;if(e.key==='Enter'){e.preventDefault();handleSend()}}
function onPaste(e){const items=e.clipboardData?.items;if(!items)return;for(const item of items){if(item.type.startsWith('image/')){e.preventDefault();const f=item.getAsFile();if(!f)continue;const r=new FileReader();r.onload=ev=>pendingImages.value.push({data:ev.target.result,file:f});r.readAsDataURL(f)}}}

// ── Stop ──
let activeAbortController=null
function cleanupListeners(u){for(const x of(u||[])){try{x()}catch{}}if(activeAbortController){activeAbortController.abort();activeAbortController=null}}
function stopGeneration(){if(!loading.value)return;if(activeAbortController){activeAbortController.abort();activeAbortController=null}stopTimer();loading.value=false;sendState.value='idle';agentSteps.value=[];reasoningText.value='';reasoningExpanded.value=false;pendingApproval.value=null;const c=conv.value;if(c.messages.length>0&&c.messages[c.messages.length-1].role==='assistant')c.messages.pop()}
function approveTool(ok){if(pendingApproval.value?.approvalId){if(!ok){const el=document.querySelector('.approval-dialog');if(el){el.classList.add('shake');setTimeout(()=>el.classList.remove('shake'),400)}setTimeout(()=>{window.electronAPI?.agentApproveTool(pendingApproval.value.approvalId,ok);agentSteps.value.push({type:'thought',content:'用户拒绝了执行'});pendingApproval.value=null},300);return}window.electronAPI?.agentApproveTool(pendingApproval.value.approvalId,ok);agentSteps.value.push({type:'thought',content:'用户批准了执行'});pendingApproval.value=null}}

// ── Send ──
async function handleSend(){const t=text.value.trim();const hi=pendingImages.value.length>0;if(!t&&!hi)return;let uc=t;const il=hi?pendingImages.value.map(i=>i.data):[];text.value='';pendingImages.value=[];const c=conv.value;const um={role:'user',content:uc,timestamp:new Date()};if(il.length>0){um.images=il;um._previewImages=il}c.messages.push(um);const hm={role:'user',content:uc};if(il.length>0){hm.images=il;hm.content=uc||'请分析这张图片'}// 注入待发送的音乐反馈（暂存，发送成功后再清空）
let fbqBackup=null;try{const fbq=JSON.parse(localStorage.getItem('music-feedback-queue')||'[]');if(fbq.length>0){fbqBackup=fbq;const fbText='[系统通知] 用户最近的音乐行为: '+fbq.map(f=>`${f.action==='complete'?'听完了':f.action==='skip_early'?'快速切掉了':f.action==='skip'?'切掉了':'重播了'}《${f.songName}》(${f.artist})`).join('; ');c.history.push({role:'user',content:fbText})}}catch{}c.history.push(hm);loading.value=true;sendState.value='loading';reasoningText.value='';reasoningExpanded.value=true;startTimer();let sc=await window.electronAPI?.loadConfig();if(!sc){const s=localStorage.getItem('llm-config');if(s){try{sc=JSON.parse(s)}catch{}}}if(!sc){stopTimer();loading.value=false;sendState.value='idle';return}if(convModel.value)sc.model=convModel.value;sc.reasoningEffort=reasoningOn.value?'max':'none';const ok=await runAgent(c,sc);
// 发送成功后清空反馈队列
if(ok&&fbqBackup){try{localStorage.setItem('music-feedback-queue','[]')}catch{}}
if(ok)return;await runLegacy(c)}

async function runAgent(c,config){let mi=-1,us=[],fullContent='',firstContent=true,msgCreated=false;cleanupListeners(null);activeAbortController=new AbortController();const sig=activeAbortController.signal;try{const rd=await window.electronAPI?.agentGetReady();if(!rd?.ready)return false;const steps=[];agentSteps.value=steps;const lr={text:''};function em(){if(!msgCreated){c.messages.push({role:'assistant',content:'',timestamp:new Date(),_reasoning:'',_reasoningOpen:true});mi=c.messages.length-1;msgCreated=true}};function sd(){nextTick(()=>msgEnd.value?.scrollIntoView({behavior:'smooth'}))};us.push(window.electronAPI.onAgentThought(d=>{const x=d?.data||d;const t=typeof x==='string'?x:x?.content||'';if(t){steps.push({type:'thought',content:t});sd()}}));us.push(window.electronAPI.onAgentAction(d=>{const x=d?.data||d;steps.push({type:'action',tool:x?.tool||'未知工具',input:x?.input||x,round:x?.round||''});sd()}));us.push(window.electronAPI.onAgentObservation(d=>{const x=d?.data||d;steps.push({type:'observation',tool:x?.tool||'工具',content:x?.content||String(x),round:x?.round||''});sd()}));us.push(window.electronAPI.onAgentChunk(d=>{if(sig.aborted)return;em();const x=d?.data||d;if(firstContent){fullContent='';firstContent=false};fullContent+=x?.content||'';if(mi>=0&&c.messages[mi])c.messages[mi].content=fullContent;sd()}));us.push(window.electronAPI.onAgentReasoningChunk(d=>{if(sig.aborted)return;em();const x=d?.data||d;const ck=x?.content||'';if(ck==='.')return;lr.text+=ck;reasoningText.value=lr.text;sd()}));us.push(window.electronAPI.onAgentDone(d=>{if(sig.aborted)return;em();const x=d?.data||d;const finalContent=x?.content||fullContent;if(finalContent&&mi>=0&&c.messages[mi]){const parsed=parseNowPlaying(finalContent);c.messages[mi].content=parsed.content;if(parsed.song){triggerMusicPlay(parsed.song.songId,parsed.song.name,parsed.song.artist,parsed.song.cover,parsed.song.reason)}}if(mi>=0&&c.messages[mi]){c.messages[mi].elapsed=elapsedTime.value;c.messages[mi]._steps=[...steps]}}));us.push(window.electronAPI.onAgentError(d=>{if(sig.aborted)return;em();const x=d?.data||d;if(mi>=0&&c.messages[mi])c.messages[mi].content=`❌ ${x?.content||'Agent 执行出错'}`}));us.push(window.electronAPI.onAgentToolApprovalRequest(d=>{const x=d?.data||d;pendingApproval.value={approvalId:x?.approval_id||'',tool:x?.tool||'',input:x?.input||{}}}));const ph=JSON.parse(JSON.stringify(c.history));const pc=JSON.parse(JSON.stringify(config));pc.userNickname=localStorage.getItem('user-nickname')||'';pc.agentPersonality=localStorage.getItem('agent-personality')||'default';pc.customPersonalities=JSON.parse(localStorage.getItem('custom-personalities')||'[]');const result=await window.electronAPI.agentChat(pc,ph,`conv-${c.id}`);cleanupListeners(us);const sr=lr.text||reasoningText.value;if(mi>=0&&c.messages[mi]?.role==='assistant'&&sr){c.messages[mi]={...c.messages[mi],_reasoning:sr,_reasoningOpen:true}};reasoningText.value='';agentSteps.value=[];reasoningExpanded.value=false;pendingApproval.value=null;stopTimer();loading.value=false;sendState.value='sent';setTimeout(()=>{if(sendState.value==='sent')sendState.value='idle'},1500);activeAbortController=null;let fc=c.messages[mi]?.content||'';if(fc){const parsed=parseNowPlaying(fc);if(parsed.song){fc=parsed.content;if(mi>=0)c.messages[mi].content=fc;triggerMusicPlay(parsed.song.songId,parsed.song.name,parsed.song.artist,parsed.song.cover,parsed.song.reason)}};if(fc&&!fc.startsWith('❌'))c.history.push({role:'assistant',content:fc});return true}catch(err){console.error('[Agent]',err);if(mi>=0&&c.messages[mi]?.role==='assistant')c.messages.pop();return false}finally{cleanupListeners(us);agentSteps.value=[];pendingApproval.value=null;activeAbortController=null}}

async function runLegacy(c){try{const{llmService}=await import('../lib/llm/LLMProvider');if(!llmService.isInitialized()){loading.value=false;sendState.value='idle';return};let full='';c.messages.push({role:'assistant',content:'',timestamp:new Date()});await llmService.chat([{role:'system',content:'你是一个桌面上的智能助手。回复简洁高效。'},...c.history],chunk=>{full+=chunk;c.messages[c.messages.length-1].content=full});c.history.push({role:'assistant',content:full})}catch(err){c.messages.push({role:'assistant',content:`❌ ${err}`,timestamp:new Date()})}finally{stopTimer();loading.value=false;sendState.value='idle'}}

// ── Feed ──
async function feedFile(data){const c=conv.value;const dn=data.name||'未知文件';let fc='';if(window.electronAPI?.readFileContent){const r=await window.electronAPI.readFileContent(data.path);if(r.success)fc=r.content};const um=fc?`📎 喂食了文件: ${dn}\n\n\`\`\`\n${fc.slice(0,3000)}\n\`\`\``:`📎 喂食了文件: ${dn}（无法读取文件内容）`;c.messages.push({role:'user',content:um,timestamp:new Date()});c.history.push({role:'user',content:um});loading.value=true;let sc=await window.electronAPI?.loadConfig();if(!sc){const s=localStorage.getItem('llm-config');if(s){try{sc=JSON.parse(s)}catch{}}};if(!sc){loading.value=false;sendState.value='idle';return};if(convModel.value)sc.model=convModel.value;const ok=await runAgent(c,sc);if(ok)return;await runLegacy(c)}

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
onMounted(async()=>{try{const r=await window.electronAPI?.agentList();allAgents.value=r?.data?.agents||r?.agents||[]}catch{allAgents.value=[]};removeFileFed=window.electronAPI?.onFileFed?.(d=>feedFile(d));agentPoll=setInterval(()=>{const s=localStorage.getItem('active-agent-id');if(s&&s!==activeAgentId.value)activeAgentId.value=s},2000);nextTick(()=>{setupScrollObserver();animateWelcome()});unwatchRename=watch(renaming,v=>{if(v!==null)nextTick(()=>animateDialog('.rename-dialog'))});unwatchApproval=watch(pendingApproval,v=>{if(v)nextTick(()=>animateDialog('.approval-dialog'))})})
onUnmounted(()=>{removeFileFed?.();stopSpeech();if(agentPoll)clearInterval(agentPoll);if(elapsedTimer)clearInterval(elapsedTimer);if(scrollObserver)scrollObserver.disconnect();if(activeAbortController){activeAbortController.abort();activeAbortController=null};unwatchRename?.();unwatchApproval?.()})
</script>
