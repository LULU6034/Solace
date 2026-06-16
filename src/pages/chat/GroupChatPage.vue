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
        <button class="header-btn" @click="showGM = true" title="群聊管理">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="4" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="12" cy="8" r="1.5"/>
          </svg>
        </button>
        <button class="add-btn" title="新建群聊" @click.stop="addNewConv">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M9 3v12M3 9h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>

    <div v-if="ctxMenu" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @click="ctxMenu = null" @mouseleave="ctxMenu = null">
      <button class="ctx-menu-item" @click="renameConv(ctxMenu.idx)">重命名</button>
      <button v-if="viewConvs.length > 1" class="ctx-menu-item danger" @click.stop="closeConv(ctxMenu.idx)">关闭群聊</button>
    </div>

    <div v-if="renaming !== null" class="rename-overlay" @click="renaming = null">
      <div class="rename-dialog" @click.stop>
        <input v-model="renameText" class="setting-input" placeholder="群聊名称..."
          @keydown.enter="doRename" @keydown.escape="renaming = null" ref="renameInput" />
        <div class="rename-actions">
          <button class="setting-btn secondary" @click="renaming = null">取消</button>
          <button class="setting-btn primary" @click="doRename">确定</button>
        </div>
      </div>
    </div>

    <div v-if="pendingPlan" class="plan-confirm-card">
      <div class="plan-confirm-header"><span>执行计划</span><span class="plan-confirm-summary">{{ pendingPlan.summary }}</span></div>
      <div class="plan-confirm-phases">
        <span v-for="p in pendingPlan.phases" :key="p.phase" class="plan-phase-item">
          <span class="plan-phase-num">{{ p.phase }}.</span><span class="plan-phase-title">{{ p.assigned_to }}</span><span class="plan-phase-agent">{{ p.title }}</span>
        </span>
      </div>
      <div class="plan-confirm-actions">
        <button class="setting-btn secondary" @click="confirmPlan(false)">取消</button>
        <button class="setting-btn primary" @click="confirmPlan(true)">执行</button>
      </div>
    </div>

    <div v-if="collabActive" class="collab-progress">
      <span v-for="(s, i) in collabSteps" :key="i" class="collab-step" :class="s.status">
        <span class="collab-step-dot"/><span class="collab-step-label">{{ s.assigned_to }}</span>
        <span v-if="i < collabSteps.length - 1" class="collab-step-line"/>
      </span>
    </div>

    <div class="messages-area" ref="msgArea" @click="ctxMenu = null">
      <div v-if="conv.messages.length === 0" class="welcome-placeholder">
        <div class="welcome-avatar-ring">
          <div class="pulse-ring r1"/><div class="pulse-ring r2"/><div class="pulse-ring r3"/>
          <div class="welcome-icon" :style="{ background: welcomeColor }">🌐</div>
        </div>
        <div class="welcome-title">群聊模式</div>
        <div class="welcome-sub">多个 AI 专家一起回答你的问题</div>
      </div>
      <div v-for="(msg, i) in conv.messages" :key="i" class="message-row"
        :class="[msg.role, { review: msg._review }]"
        @mouseenter="msg._hover = true" @mouseleave="msg._hover = false">
        <div v-if="msg.role === 'assistant'" class="msg-avatar"
          :style="msg._expert?.avatarUrl ? { backgroundImage: 'url('+msg._expert.avatarUrl+')', backgroundSize:'cover' } : { background: (msg._expert?.color||'#6366F1')+'18' }">
          <span v-if="!msg._expert?.avatarUrl">{{ msg._expert?.icon || '🤖' }}</span>
        </div>
        <div v-else class="msg-avatar user-avatar">
          <img v-if="userAvatar.startsWith('data:')" :src="userAvatar" class="avatar-img"/>
          <div v-else class="avatar-geo" :style="{ background: avatarColor }">
            <svg viewBox="0 0 40 40" class="avatar-geo-svg">
              <path d="M12 28 Q20 8 28 28" fill="none" stroke="rgba(0,0,0,0.12)" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M8 22 Q20 16 32 22" fill="none" stroke="rgba(0,0,0,0.1)" stroke-width="1.5" stroke-linecap="round"/>
              <circle cx="20" cy="18" r="3" fill="rgba(255,255,255,0.3)"/>
            </svg>
          </div>
        </div>
        <div class="bubble-wrap">
          <div class="bubble" :class="msg.role" :style="msg._expert ? { borderColor: msg._expert.color+'60' } : {}">
            <div v-if="msg.role==='assistant'" class="msg-role" :style="msg._expert?{color:msg._expert.color}:{}">{{ msg._expert?.name || '专家' }}</div>
            <div class="msg-text" v-html="renderMarkdown(msg.content)"></div>
            <span v-if="isStreamingMsg(msg,i)" class="streaming-cursor"></span>
          </div>
        </div>
      </div>
      <div v-if="loading" class="typing-indicator"><div class="typing-dot"/><div class="typing-dot"/><div class="typing-dot"/></div>
      <div ref="msgEnd"/>
    </div>

    <div class="input-area">
      <div class="input-toolbar-top">
        <select class="model-select" v-model="convModel" :disabled="loading">
          <option v-for="m in currentModels" :key="m.value" :value="m.value">{{ m.label }}</option>
        </select>
        <span class="group-mode-badge">🌐 群聊</span>
        <button v-if="supportsSpeech" class="mic-btn-inline" :class="{recording:isRecording}" :title="isRecording?'停止':'语音'" @click="toggleSpeech">{{ isRecording?'⬤':'🎤' }}</button>
      </div>
      <div class="input-box">
        <textarea ref="ta" v-model="text" placeholder="@专家名 提问..." @keydown="onKeydown" @paste="onPaste" rows="1"/>
        <button v-if="sendState==='idle'" class="send-btn-inline" :disabled="!text.trim()" @click="handleSend" title="发送"><ArrowUp :size="16"/></button>
        <button v-else-if="sendState==='loading'" class="send-btn-inline loading" title="发送中..."><span class="btn-spinner"/></button>
        <button v-else-if="sendState==='sent'" class="send-btn-inline sent" title="已发送"><Check :size="16" class="btn-check"/></button>
        <button v-if="sendState==='loading'" class="stop-btn" @click="stopGeneration">⏹</button>
      </div>
    </div>

    <!-- 群聊管理弹窗 -->
    <div v-if="showGM" class="dialog-backdrop" @click.self="showGM = false">
      <div class="role-dialog" @click.stop style="width:380px">
        <div class="role-dialog-title">群聊管理</div>
        <div class="role-dialog-body">
          <div class="group-setting-row" style="margin-bottom:12px">
            <span>群聊模式</span>
            <div class="segmented-row" style="background:var(--bg-input);border-radius:6px">
              <button class="seg-btn" :class="{active:gs.mode==='discussion'}" @click="gs.mode='discussion';saveGS()">讨论</button>
              <button class="seg-btn" :class="{active:gs.mode==='collaboration'}" @click="gs.mode='collaboration';saveGS()">协作</button>
            </div>
          </div>
          <div class="group-member-grid">
            <div v-for="a in activeG" :key="a.id" class="group-member-item">
              <span class="group-member-emoji" :style="{background:(a.color||'#6366F1')+'18'}">{{ a.icon||'🤖' }}</span>
              <span class="group-member-name">{{ a.name }}</span>
              <button class="group-member-remove" @click="toggleGA(a.id)" title="移除">✕</button>
            </div>
            <div v-if="inactiveG.length>0" class="group-member-item group-member-add" @click="showPick=!showPick">
              <div class="group-member-emoji" style="background:var(--accent-soft);border-style:dashed">+</div>
              <span class="group-member-name">添加</span>
            </div>
          </div>
          <div v-if="showPick" class="rd-tool-list" style="max-height:140px">
            <label v-for="a in inactiveG" :key="a.id" class="rd-tool-item" @click="toggleGA(a.id);showPick=false">
              <span>{{ a.icon||'🤖' }}</span><span class="rd-tool-name">{{ a.name }}</span>
            </label>
          </div>
          <div class="group-settings-inline">
            <div class="group-setting-row">
              <span>同时回复数</span>
              <select v-model.number="gs.maxRoles" @change="saveGS" class="rd-input" style="width:auto;padding:4px 8px;font-size:12px">
                <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
              </select>
            </div>
            <div class="group-setting-row">
              <span>角色互评</span>
              <input type="checkbox" v-model="gs.interReview" @change="saveGS"/>
            </div>
          </div>
        </div>
        <div class="role-dialog-actions">
          <button class="setting-btn primary" @click="showGM=false">完成</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { Check, ArrowUp } from 'lucide-vue-next'
import gsap from 'gsap'
import { marked } from 'marked'
import { animSpeed, Spring } from '../../animations/gsap'

marked.setOptions({ breaks: true, gfm: true })

const MODELS = {
  claude:[{value:'claude-sonnet-4-20250506',label:'Claude-Sonnet-4'},{value:'claude-opus-4-7',label:'Claude-Opus-4.7'}],
  deepseek:[{value:'deepseek-v4-flash',label:'DeepSeek-V4-Flash'},{value:'deepseek-v4-pro',label:'DeepSeek-V4-Pro'}],
  openai:[{value:'gpt-4o-mini',label:'GPT-4o-Mini'},{value:'gpt-4o',label:'GPT-4o'}],
}

const loading=ref(false),sendState=ref('idle'),text=ref(''),ctxMenu=ref(null)
const agentSteps=ref([]),reasoningText=ref('')
const elapsedTime=ref(0); let elapsedTimer=null
const renaming=ref(null),renameText=ref(''),renameInput=ref(null)
const ta=ref(null),msgEnd=ref(null),msgArea=ref(null)
const convs=ref([{id:100,title:'群聊',provider:localStorage.getItem('llm-provider')||'deepseek',messages:[],history:[],mode:'groupchat'}])
const viewConvs=computed(()=>convs.value.filter(c=>(c.mode||'chat')==='groupchat'))
const viewIdx=ref(0); const conv=computed(()=>viewConvs.value[viewIdx.value]||convs.value[0])
const currentModels=computed(()=>MODELS[conv.value.provider]||MODELS.claude)
const convModel=computed({get(){const c=conv.value;if(c._model)return c._model;const s=localStorage.getItem('llm-model');return s&&currentModels.value.some(m=>m.value===s)?s:currentModels.value[0]?.value||''},set(v){conv.value._model=v;localStorage.setItem('llm-model',v)}})
const allAgents=ref([]); const allGs=ref(loadGIds())
const activeG=computed(()=>allAgents.value.filter(a=>allGs.value.includes(a.id)))
const inactiveG=computed(()=>allAgents.value.filter(a=>!allGs.value.includes(a.id)))
const gs=reactive({maxRoles:parseInt(localStorage.getItem('gs-max-roles')||'3'),mode:localStorage.getItem('gs-mode')||'discussion',interReview:localStorage.getItem('gs-inter-review')==='true'})
const lastErr=ref(''),pendingPlan=ref(null),planCid=ref(''),collabSteps=ref([]),collabActive=ref(false)
const showGM=ref(false),showPick=ref(false)
const userAvatar=ref(localStorage.getItem('user-avatar')||''),avatarColor=ref(localStorage.getItem('user-avatar-color')||'#6366F1')
const welcomeColor=computed(()=>((allAgents.value.find(a=>a.isActive)||{}).color||'#6366F1')+'18')
const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition
const supportsSpeech=ref(!!SpeechRecognition),isRecording=ref(false); let recognition=null

function loadGIds(){try{const s=localStorage.getItem('active-group-agent-ids');return s?JSON.parse(s):['__builtin_manager__','__builtin_researcher__','__builtin_executor__','__builtin_reviewer__','__builtin_memory_keeper__']}catch{return[]}}
function saveGS(){localStorage.setItem('gs-max-roles',String(gs.maxRoles));localStorage.setItem('gs-mode',gs.mode);localStorage.setItem('gs-inter-review',String(gs.interReview))}
function toggleGA(id){const i=allGs.value.indexOf(id);if(i>=0)allGs.value.splice(i,1);else allGs.value.push(id);localStorage.setItem('active-group-agent-ids',JSON.stringify(allGs.value))}
function resetCollab(){collabSteps.value=[];collabActive.value=false}
function confirmPlan(ok){if(planCid.value)window.electronAPI?.agentConfirmPlan(planCid.value,ok);pendingPlan.value=null}

let userAtBottom=true,scrollObserver=null
function setupScrollObserver(){if(!msgArea.value)return;if(scrollObserver)scrollObserver.disconnect();scrollObserver=new IntersectionObserver(([e])=>{userAtBottom=e.isIntersecting},{root:msgArea.value,threshold:.1});if(msgEnd.value)scrollObserver.observe(msgEnd.value)}
function scrollDown(){if(userAtBottom&&msgEnd.value)msgEnd.value.scrollIntoView({behavior:'smooth',block:'end'})}

function isStreamingMsg(m,i){return i===conv.value.messages.length-1&&loading.value&&m.role==='assistant'}
function renderMarkdown(t){if(!t)return'';try{return marked.parse(t)}catch{return t}}
function getNextId(){return Math.max(100,...convs.value.map(c=>c.id))+1}

let _la=0; function addNewConv(){if(Date.now()-_la<300)return;_la=Date.now();const p=localStorage.getItem('llm-provider')||'deepseek';const sc=convs.value.filter(c=>c.mode==='groupchat');const t=sc.length===0?'群聊':`群聊 ${getNextId()}`;convs.value.push({id:getNextId(),title:t,provider:p,messages:[],history:[],mode:'groupchat'})}
function switchConv(i){if(i!==viewIdx.value)viewIdx.value=i}
let _lc=0; function closeConv(i){if(Date.now()-_lc<300)return;_lc=Date.now();const vc=viewConvs.value;if(vc.length<=1)return;const r=vc[i],gi=convs.value.findIndex(c=>c.id===r.id);convs.value.splice(gi,1);if(viewIdx.value>=viewConvs.value.length)viewIdx.value=viewConvs.value.length-1;ctxMenu.value=null}
function renameConv(i){ctxMenu.value=null;renaming.value=i;renameText.value=viewConvs.value[i].title;nextTick(()=>renameInput.value?.focus())}
function doRename(){const t=renameText.value.trim();if(t&&renaming.value!==null){const vc=viewConvs.value;if(vc[renaming.value])vc[renaming.value].title=t}renaming.value=null}

function startTimer(){elapsedTime.value=0;elapsedTimer=setInterval(()=>{elapsedTime.value++},1000)}
function stopTimer(){if(elapsedTimer){clearInterval(elapsedTimer);elapsedTimer=null};elapsedTime.value=0}

function toggleSpeech(){if(isRecording.value){stopSpeech();return};if(!SpeechRecognition)return;recognition=new SpeechRecognition();recognition.continuous=true;recognition.interimResults=true;recognition.lang='zh-CN';recognition.onresult=e=>{let t='';for(let i=e.resultIndex;i<e.results.length;i++)t+=e.results[i][0].transcript;text.value=t};recognition.onerror=()=>stopSpeech();recognition.onend=()=>{isRecording.value=false;recognition=null};recognition.start();isRecording.value=true}
function stopSpeech(){if(recognition){recognition.stop();recognition=null};isRecording.value=false}
function onKeydown(e){if(e.key==='Enter'&&!(e.metaKey||e.ctrlKey||e.shiftKey)){e.preventDefault();handleSend()}}
function onPaste(e){const items=e.clipboardData?.items;if(!items)return;for(const item of items){if(item.type.startsWith('image/')){e.preventDefault();const f=item.getAsFile();if(!f)continue;const r=new FileReader();r.onload=ev=>{/* ignore images in group chat */};r.readAsDataURL(f)}}}

let activeAbortController=null
function cleanupListeners(u){for(const x of(u||[])){try{x()}catch{}}if(activeAbortController){activeAbortController.abort();activeAbortController=null}}
function stopGeneration(){if(!loading.value)return;if(activeAbortController){activeAbortController.abort();activeAbortController=null};stopTimer();loading.value=false;sendState.value='idle';agentSteps.value=[];reasoningText.value='';const c=conv.value;if(c.messages.length>0&&c.messages[c.messages.length-1].role==='assistant')c.messages.pop()}

function parseMentions(t){const re=/@(\S+)/g,ids=[];let m;while((m=re.exec(t))!==null){const f=allAgents.value.find(a=>a.name===m[1]||a.id===m[1]||a.name.startsWith(m[1]));if(f)ids.push(f.id)}return ids}

async function handleSend(){const t=text.value.trim();if(!t)return;text.value='';const c=conv.value;c.messages.push({role:'user',content:t,timestamp:new Date()});c.history.push({role:'user',content:t});loading.value=true;sendState.value='loading';startTimer();let sc=await window.electronAPI?.loadConfig();if(!sc){const s=localStorage.getItem('llm-config');if(s){try{sc=JSON.parse(s)}catch{}}};if(!sc){stopTimer();loading.value=false;sendState.value='idle';return};if(convModel.value)sc.model=convModel.value;const mids=parseMentions(t);const ok=await runGroup(c,sc,mids);loading.value=false;stopTimer();if(!ok){const ac=allGs.value.length;const reason=ac===0?'群聊中没有激活的角色。请点击侧边栏"角色"，勾选至少一个角色的"群聊"开关。':`群聊请求失败: ${lastErr.value||'请检查 Agent 服务是否就绪'}（当前 ${ac} 个角色选中）。`;c.messages.push({role:'assistant',content:reason,timestamp:new Date()})}}

async function runGroup(c,config,mids){try{const rd=await window.electronAPI?.agentGetReady();if(!rd?.ready){lastErr.value='Agent 服务未就绪';return false};const steps=[];agentSteps.value=steps;const ph=JSON.parse(JSON.stringify(c.history));const pc=JSON.parse(JSON.stringify(config));pc.userNickname=localStorage.getItem('user-nickname')||'';pc.agentPersonality=localStorage.getItem('agent-personality')||'default';pc.customPersonalities=JSON.parse(localStorage.getItem('custom-personalities')||'[]');pc.interReview=gs.interReview;pc.maxRoles=gs.maxRoles;const us=[],er=[],tm={};const isC=gs.mode==='collaboration';us.push(window.electronAPI.onCoordinatorStart(d=>{const x=d?.data||d;if(isC&&x?.phases){pendingPlan.value=null;collabActive.value=true;collabSteps.value=x.phases.map(p=>({title:p.title,assigned_to:p.assigned_to,status:'pending'}))}else if(x?.experts){steps.push({type:'thought',content:'已激活: '+x.experts.map(e=>e.name).join('、')})}}));us.push(window.electronAPI.onCoordinatorInfo(d=>{const x=d?.data||d;if(isC&&x?.phase!=null&&x?.phase_status){const cur=collabSteps.value[x.phase-1];if(cur)cur.status=x.phase_status};if(x?.content)steps.push({type:'thought',content:x.content})}));us.push(window.electronAPI.onExpertThought(d=>{const x=d?.data||d;if(x?.content)steps.push({type:'thought',content:`${x?.expert_name}: ${x.content}`})}));us.push(window.electronAPI.onExpertReasoning(d=>{const x=d?.data||d;if(x?.content)steps.push({type:'thought',content:`${x?.expert_name} 思考: ${x.content.slice(0,100)}`,expert:x?.expert_name})}));us.push(window.electronAPI.onExpertAction(d=>{const x=d?.data||d;steps.push({type:'action',tool:x?.tool,input:x?.input,expert:x?.expert_name})}));us.push(window.electronAPI.onExpertObservation(d=>{const x=d?.data||d;steps.push({type:'observation',tool:x?.tool,content:x?.content,expert:x?.expert_name})}));us.push(window.electronAPI.onExpertChunk(d=>{const x=d?.data||d;if(!x?.content)return;const eid=x.expert_id;if(eid in tm){c.messages[tm[eid]].content+=x.content}else{const ra=allAgents.value.find(a=>a.id===eid);tm[eid]=c.messages.length;c.messages.push({role:'assistant',content:x.content,timestamp:new Date(),_expert:{id:eid,name:x.expert_name,icon:x.expert_icon,color:x.expert_color,avatarUrl:ra?.avatarUrl||''}})}}));us.push(window.electronAPI.onExpertDone(d=>{const x=d?.data||d;if(x?.content){const eid=x.expert_id;const ei=er.findIndex(r=>r.expert_id===eid);if(ei>=0)er[ei]=x;else er.push(x);const ra=allAgents.value.find(a=>a.id===eid);const msg={role:'assistant',content:x.content,timestamp:new Date(),elapsed:x.elapsed,_expert:{id:eid,name:x.expert_name,icon:x.expert_icon,color:x.expert_color,avatarUrl:ra?.avatarUrl||''}};if(eid in tm)c.messages[tm[eid]]=msg;else{tm[eid]=c.messages.length;c.messages.push(msg)}}}));us.push(window.electronAPI.onExpertError(d=>{const x=d?.data||d;const em=`❌ ${x?.expert_id||'专家'} 出错: ${x?.error||'未知'}`;steps.push({type:'thought',content:em});c.messages.push({role:'assistant',content:em,timestamp:new Date()})}));us.push(window.electronAPI.onCoordinatorDone(d=>{const x=d?.data||d;if(x?.replies?.length===0)c.messages.push({role:'assistant',content:'抱歉，群聊专家们暂时无法回答这个问题，试试换种问法？',timestamp:new Date()})}));us.push(window.electronAPI.onCoordinatorReview(d=>{const x=d?.data||d;if(!x?.reviews?.length)return;for(const rv of x.reviews){if(!rv.content)continue;c.messages.push({role:'assistant',content:rv.content,timestamp:new Date(),_expert:{id:rv.expert_id,name:rv.expert_name,icon:rv.expert_icon,color:rv.expert_color,avatarUrl:(allAgents.value.find(a=>a.id===rv.expert_id)||{}).avatarUrl||''},_review:true})}}));us.push(window.electronAPI.onPlanReady(d=>{const x=d?.data||d;if(x?.plan){pendingPlan.value=x.plan;planCid.value=`group-${c.id}`}}));us.push(window.electronAPI.onCoordinatorError(d=>{const x=d?.data||d;pendingPlan.value=null;resetCollab();c.messages.push({role:'assistant',content:'群聊模式出问题了: '+(x?.content||'未知错误')+'。',timestamp:new Date()})}));const aids=allGs.value.length>0?[...new Set(allGs.value)]:null;if(typeof window.electronAPI?.agentChatGroup!=='function'){lastErr.value='agentChatGroup API 未暴露';return false};await window.electronAPI.agentChatGroup(pc,ph,`group-${c.id}`,aids,mids.length>0?mids:null,JSON.parse(JSON.stringify(gs)));for(const u of us)u();agentSteps.value=[];resetCollab();stopTimer();loading.value=false;sendState.value='sent';setTimeout(()=>{if(sendState.value==='sent')sendState.value='idle'},1500);for(const r of er){if(r?.content&&!r.content.startsWith('❌')){const ag=allAgents.value.find(x=>x.id===r.expert_id);c.history.push({role:'assistant',content:r.content,_expert:{id:r.expert_id,name:r.expert_name,icon:r.expert_icon,color:r.expert_color,avatarUrl:ag?.avatarUrl||''}})}}return true}catch(err){console.error('[GroupChat]',err);lastErr.value=err.message||String(err);resetCollab();return false}}

function onTabBeforeEnter(el){el.style.opacity='0';el.style.transform='translateX(-12px) scale(0.9)'}
function onTabEnter(el,done){const s=animSpeed();gsap.to(el,{opacity:1,x:0,scale:1,duration:.28/s,ease:'back.out(1.5)',onComplete:done})}
function onTabLeave(el,done){const s=animSpeed();gsap.to(el,{opacity:0,x:-6,scale:.93,duration:.18/s,ease:'power2.in',onComplete:done})}
function animateWelcome(){nextTick(()=>{const w=msgArea.value?.querySelector('.welcome-placeholder');if(!w)return;const s=animSpeed();const tl=gsap.timeline();tl.from(w.querySelector('.welcome-avatar-ring'),{scale:0,opacity:0,duration:.5/s,ease:'back.out(2)'});tl.from(w.querySelector('.welcome-title'),{y:12,opacity:0,duration:.4/s,ease:'power2.out'},'-=0.15');tl.from(w.querySelector('.welcome-sub'),{y:8,opacity:0,duration:.3/s,ease:'power2.out'},'-=0.2');gsap.to(w.querySelector('.welcome-avatar-ring'),{scale:1.005,duration:4/s,ease:'power1.inOut',repeat:-1,yoyo:true})})}

watch(()=>conv.value.messages.length,()=>{nextTick(()=>{scrollDown();const rows=msgArea.value?.querySelectorAll('.message-row');if(rows&&rows.length>0){const lr=rows[rows.length-1];if(!lr.dataset.gsapAnimated){lr.dataset.gsapAnimated='1';const s=animSpeed();gsap.from(lr,{y:18,opacity:0,scale:.96,duration:Spring.snappy.duration/s,ease:Spring.snappy.ease})}}})})
watch(loading,v=>window.electronAPI?.notifyWorking(v))

let removeFF=null
onMounted(async()=>{try{const r=await window.electronAPI?.agentList();allAgents.value=r?.data?.agents||r?.agents||[]}catch{allAgents.value=[]};removeFF=window.electronAPI?.onFileFed?.(d=>{const dn=d.name||'未知文件';const c=conv.value;c.messages.push({role:'user',content:`📎 喂食了文件: ${dn}`,timestamp:new Date()});c.history.push({role:'user',content:`📎 喂食了文件: ${dn}`})});nextTick(()=>{setupScrollObserver();animateWelcome()})})
onUnmounted(()=>{removeFF?.();stopSpeech();if(elapsedTimer)clearInterval(elapsedTimer);if(scrollObserver)scrollObserver.disconnect();if(activeAbortController){activeAbortController.abort();activeAbortController=null}})
</script>
