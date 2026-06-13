/**
 * 统一粒子系统 — 浮游星尘 · 深邃能量
 *
 * 300 粒子 + 自定义着色器双层光晕 + 5 吸引子轨道 + 情绪音频响应
 */
import * as THREE from 'three';

let _up = null;
export { _up };

const ATTRACTORS = 5, N = 200;
const COLORS = {
  neutral:[0.35,0.5,1.0], happy:[0.45,0.6,1.0], sad:[0.3,0.35,0.8],
  angry:[0.95,0.4,0.35], worried:[0.5,0.4,0.9], encouraging:[0.35,0.8,0.65],
  funny:[0.9,0.7,0.25], sarcastic:[0.55,0.5,0.9],
};

// 顶点着色器 — 景深 + 世界坐标 + 视线方向
const VS = /*glsl*/`
  attribute float aSize;
  varying float vDepth;
  varying vec3 vWorldPos;
  varying vec3 vEyeDir;
  void main(){
    vec4 worldPos=modelMatrix*vec4(position,1.);
    vec4 mv=modelViewMatrix*vec4(position,1.);
    gl_Position=projectionMatrix*mv;
    vDepth=clamp(-mv.z/8.,0.,1.);
    gl_PointSize=aSize*(1000./-mv.z);
    vWorldPos=worldPos.xyz;
    vEyeDir=normalize(cameraPosition-worldPos.xyz);
  }
`;

// 片元着色器 — 六边形全息光晕 + 视角色移 + 情绪混合
const FS = /*glsl*/`
  uniform vec3 uCore,uHalo;
  uniform float uMix,uVol,uTime;
  varying float vDepth;
  varying vec3 vWorldPos;
  varying vec3 vEyeDir;

  void main(){
    vec2 uv=gl_PointCoord-.5;
    float angle=atan(uv.y,uv.x);
    // 纯圆形粒子: 边缘完全羽化到透明, 无边框
    float d=length(uv)*2.;
    if(d>.92)discard;
    float inner=1.-smoothstep(0.,.55,d);
    float outer=1.-smoothstep(.1,1.,d);

    // 全息色移：视角方向影响色调
    float hueShift=sin(vEyeDir.x*3.+uTime)*.1+cos(vEyeDir.y*2.5)*.08;

    vec3 core=uCore*(.9+uVol*.8);
    core.r+=hueShift;core.b-=hueShift;
    vec3 halo=mix(uHalo,uCore,uMix*.5);
    vec3 c=core*inner*.9+halo*outer*.6;
    float a=clamp((inner+outer*.6)*(1.-vDepth*.4)*.65,0.,1.);
    gl_FragColor=vec4(c,a);
  }
`;

function makeGlowTex() {
  const c=document.createElement('canvas');c.width=c.height=64;
  const x=c.getContext('2d'),g=x.createRadialGradient(32,32,0,32,32,32);
  g.addColorStop(0,'rgba(255,255,255,1)');
  g.addColorStop(.2,'rgba(220,225,255,.7)');
  g.addColorStop(.5,'rgba(140,150,240,.15)');
  g.addColorStop(1,'transparent');
  x.fillStyle=g;x.fillRect(0,0,64,64);
  return new THREE.CanvasTexture(c);
}

export async function createUnifiedParticles(canvas) {
  if (_up) { console.log('[particles] 复用已有'); return _up; }
  if (!canvas) { console.error('[particles] 无 canvas'); return null; }
  try {
    const w=window.innerWidth,h=window.innerHeight;
    const renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true});
    renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    renderer.setSize(w,h,false);
    window.addEventListener('resize',()=>{
      const w2=window.innerWidth,h2=window.innerHeight;
      camera.aspect=w2/h2;camera.updateProjectionMatrix();
      renderer.setSize(w2,h2,false);
      renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    });

    const scene=new THREE.Scene();
    scene.background=null; // 透明，让 body 背景透出
    const camera=new THREE.PerspectiveCamera(60,w/h,.1,30);
    camera.position.set(0,.6,6.5);camera.lookAt(0,-1.5,0);

    // 粒子几何
    const geo=new THREE.BufferGeometry();
    const pos=new Float32Array(N*3),siz=new Float32Array(N);
    const data=[];
    for(let i=0;i<N;i++){
      pos[i*3]=(Math.random()-.5)*6;pos[i*3+1]=(Math.random()-.5)*4;pos[i*3+2]=(Math.random()-.5)*3;
      siz[i]=.02+Math.random()*.05;
      data.push({
        vx:(Math.random()-.5)*.0015,vy:(Math.random()-.5)*.0015,vz:(Math.random()-.5)*.0005,
        aid:i%ATTRACTORS,base:siz[i],ph:Math.random()*Math.PI*2,or:.2+Math.random()*1.2,os:.2+Math.random()*.6,
      });
    }
    geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
    geo.setAttribute('aSize',new THREE.BufferAttribute(siz,1));

    // 主粒子 — 自定义着色器 (六边形光晕 + 全息色移)
    const mat=new THREE.ShaderMaterial({
      uniforms:{
        uCore:{value:new THREE.Color(...COLORS.neutral)},
        uHalo:{value:new THREE.Color(0.35,0.42,0.9)},
        uMix:{value:0},uVol:{value:0},uTime:{value:0},
      },
      vertexShader:VS,fragmentShader:FS,
      transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
    });
    // 背景粒子 — 更淡的独立材质
    const bgMat=mat.clone();
    bgMat.uniforms.uCore.value=new THREE.Color(.22,.28,.45);
    bgMat.uniforms.uHalo.value=new THREE.Color(.22,.28,.45);
    const points=new THREE.Points(geo,bgMat);
    scene.add(points);

    // 晶体点缀 (减少)
    const cGeo=new THREE.BufferGeometry(),cPos=new Float32Array(24);
    for(let i=0;i<8;i++){cPos[i*3]=(Math.random()-.5)*5;cPos[i*3+1]=(Math.random()-.5)*3.5;cPos[i*3+2]=(Math.random()-.5)*3;}
    cGeo.setAttribute('position',new THREE.BufferAttribute(cPos,3));
    const cry=new THREE.Points(cGeo,new THREE.PointsMaterial({
      size:.15,map:makeGlowTex(),color:0x818CF8,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:.85,
    }));
    scene.add(cry);

    // 粒子呼吸球体 — 均匀体积填充
    const orbN=400,Rb=1.6,orbGeo=new THREE.BufferGeometry();
    const orbPos=new Float32Array(orbN*3),orbSiz=new Float32Array(orbN),orbData=[];
    for(let i=0;i<orbN;i++){
      const phi=Math.acos(1-2*(i+.5)/orbN);
      const theta=Math.PI*(1+Math.sqrt(5))*i;
      const shell=.78+Math.random()*.22;
      const r=Rb*shell;
      orbPos[i*3]=Math.cos(theta)*Math.sin(phi)*r;
      orbPos[i*3+1]=Math.sin(theta)*Math.sin(phi)*r;
      orbPos[i*3+2]=Math.cos(phi)*r;
      orbSiz[i]=.05+Math.random()*.065;
      orbData.push({r,phi,theta,shell,phase:Math.random()*Math.PI*2,baseS:orbSiz[i],
        vx:(Math.random()-.5)*.4,vy:(Math.random()-.5)*.4,vz:(Math.random()-.5)*.4});
    }
    orbGeo.setAttribute('position',new THREE.BufferAttribute(orbPos,3));
    orbGeo.setAttribute('aSize',new THREE.BufferAttribute(orbSiz,1));
    // 球体独立材质: 明亮纯净无光晕
    const orbShader=new THREE.ShaderMaterial({
      uniforms:{
        uColor:{value:new THREE.Color(0.35,0.5,1.0)}, uTime:{value:0}, uVol:{value:0},
      },
      vertexShader:`attribute float aSize;uniform float uVol,uTime;varying float vD;varying float vPulse;void main(){vec4 mv=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mv;float pulse=1.+uVol*1.2+sin(uTime*4.)*.15*uVol;gl_PointSize=aSize*(900./-mv.z)*pulse;vD=clamp(-mv.z/8.,0.,1.);vPulse=pulse;}`,
      fragmentShader:`uniform vec3 uColor;uniform float uVol;varying float vD;varying float vPulse;void main(){float d=length(gl_PointCoord-.5)*2.;if(d>.9)discard;float bright=1.+uVol*.8;float a=clamp((1.-smoothstep(0.,.65,d))*(1.-vD*.3)*bright,0.,1.)*.8;gl_FragColor=vec4(uColor*bright,a);}`,
      transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
    });
    const orbPts=new THREE.Points(orbGeo,orbShader);
    orbPts.frustumCulled=false;
    orbPts.renderOrder=-1;
    scene.add(orbPts);

    // ═══ 神经波邻域预计算 ═══
    const neighbors=Array.from({length:orbN},()=>[]);
    const TH=Math.PI/6; // 30° 阈值
    for(let i=0;i<orbN;i++){
      for(let j=i+1;j<orbN;j++){
        const dx=orbPos[i*3]-orbPos[j*3],dy=orbPos[i*3+1]-orbPos[j*3+1],dz=orbPos[i*3+2]-orbPos[j*3+2];
        const dot=orbPos[i*3]*orbPos[j*3]+orbPos[i*3+1]*orbPos[j*3+1]+orbPos[i*3+2]*orbPos[j*3+2];
        const r1=Math.sqrt(orbPos[i*3]**2+orbPos[i*3+1]**2+orbPos[i*3+2]**2);
        const r2=Math.sqrt(orbPos[j*3]**2+orbPos[j*3+1]**2+orbPos[j*3+2]**2);
        const ang=Math.acos(Math.min(1,dot/(r1*r2+1e-9)));
        if(ang<TH){neighbors[i].push(j);neighbors[j].push(i);}
      }
    }
    const fireState=new Float32Array(orbN),fireRem=new Float32Array(orbN);

    // 吸引子
    const att=Array.from({length:ATTRACTORS},()=>({
      x:(Math.random()-.5)*3,y:(Math.random()-.5)*2.5,z:(Math.random()-.5)*2,
      ph:Math.random()*Math.PI*2,drift:Math.random()*.3+.1,
    }));

    const st={page:'chat',emotion:'neutral',target:'neutral',_et:1,audio:{volume:0}};

    let lt=performance.now(),et=0,running=true;

    function loop(){
      if(!running)return;requestAnimationFrame(loop);
      try{
      const now=performance.now(),dt=Math.min((now-lt)/1000,.1);lt=now;if(dt<=0)return;et+=dt;

      // 吸引子漂移
      const sp=st.page==='voice'?1.5:2.5;
      for(const a of att){a.ph+=a.drift*dt*.2;a.x+=(Math.sin(et*.2+a.ph)*sp-a.x)*dt*.3;a.y+=(Math.cos(et*.25+a.ph)*sp*.7-a.y)*dt*.3;a.z+=(Math.cos(et*.15+a.ph)*sp*.5-a.z)*dt*.3;}

      // 粒子运动
      for(let i=0;i<N;i++){
        const d=data[i],a=att[d.aid],idx=i*3;
        d.ph+=d.os*dt*2;
        const tx=a.x+Math.cos(d.ph)*d.or,ty=a.y+Math.sin(d.ph*1.3)*d.or*.7,tz=a.z+Math.cos(d.ph*.7)*d.or*.5;
        const vol=st.page==='voice'?st.audio.volume:0;
        pos[idx]+=(tx-pos[idx])*.02*(1+vol)+d.vx*dt*60;
        pos[idx+1]+=(ty-pos[idx+1])*.02*(1+vol)+d.vy*dt*60;
        pos[idx+2]+=(tz-pos[idx+2])*.02*(1+vol)+d.vz*dt*60;
        if(Math.abs(pos[idx])>3)pos[idx]*=-.95;
        if(Math.abs(pos[idx+1])>2.5)pos[idx+1]*=-.95;
        if(Math.abs(pos[idx+2])>2)pos[idx+2]*=-.95;
        siz[i]=d.base*(st.page==='voice'?1+vol*.4:1);
      }
      geo.attributes.position.needsUpdate=true;
      geo.attributes.aSize.needsUpdate=true;

      // 晶体微动
      for(let i=0;i<8;i++){cPos[i*3]+=Math.sin(et*.4+i)*.001;cPos[i*3+1]+=Math.cos(et*.5+i)*.001;}
      cGeo.attributes.position.needsUpdate=true;

      // ── 球体粒子各自运动 ──
      const orbSpd=.08+st.audio.volume*1.2;
      const orbR=Rb;
      for(let i=0;i<orbN;i++){
        const d=orbData[i];
        // 布朗运动 + 轨道漂移
        d.vx+=(Math.random()-.5)*.08*dt;d.vy+=(Math.random()-.5)*.08*dt;d.vz+=(Math.random()-.5)*.08*dt;
        // 阻尼
        d.vx*=.998;d.vy*=.998;d.vz*=.998;
        // 速度限制
        const spd=Math.sqrt(d.vx*d.vx+d.vy*d.vy+d.vz*d.vz);
        if(spd>orbSpd){d.vx*=orbSpd/spd;d.vy*=orbSpd/spd;d.vz*=orbSpd/spd;}
        // 更新位置
        orbPos[i*3]+=d.vx*dt;orbPos[i*3+1]+=d.vy*dt;orbPos[i*3+2]+=d.vz*dt;
        // 约束在球壳范围内
        const dist=Math.sqrt(orbPos[i*3]*orbPos[i*3]+orbPos[i*3+1]*orbPos[i*3+1]+orbPos[i*3+2]*orbPos[i*3+2]);
        if(dist>orbR){const s=orbR/dist;orbPos[i*3]*=s;orbPos[i*3+1]*=s;orbPos[i*3+2]*=s;d.vx*=-.5;d.vy*=-.5;d.vz*=-.5;}
        if(dist<orbR*.4){const s=orbR*.4/dist;orbPos[i*3]*=s;orbPos[i*3+1]*=s;orbPos[i*3+2]*=s;d.vx*=-.5;d.vy*=-.5;d.vz*=-.5;}
      }
      orbGeo.attributes.position.needsUpdate=true;

      // ── 球体旋转 + 状态颜色平滑过渡 ──
      const rotSpd=.08+st.audio.volume*.2;
      orbPts.rotation.y+=dt*rotSpd;orbPts.rotation.x+=dt*rotSpd*.3;
      // 思考=暖紫 / 说话=亮蓝靛 / 空闲=柔和蓝
      let targetCol;
      if(st.audio._thinking)targetCol=[.6,.2,.9];
      else if(st.audio.volume>.2)targetCol=[.3,.6,1.];
      else targetCol=[.25,.45,.9];
      st._orbCol=st._orbCol||[.25,.45,.9];
      const lerp=Math.min(1,dt*3.);
      for(let j=0;j<3;j++)st._orbCol[j]+=(targetCol[j]-st._orbCol[j])*lerp;
      orbPts.material.uniforms.uColor.value.setRGB(st._orbCol[0],st._orbCol[1],st._orbCol[2]);

      // ── 邻域神经波传播 ──
      if(st.audio.volume>.7&&Math.random()<dt*2) fireState[Math.floor(Math.random()*orbN)]=1,fireRem[Math.floor(Math.random()*orbN)]=.1;
      if(st.target!==st.emotion&&st._et<.1) fireState[Math.floor(Math.random()*orbN)]=1,fireRem[Math.floor(Math.random()*orbN)]=.1;
      for(let i=0;i<orbN;i++){
        if(fireRem[i]>0){
          fireRem[i]-=dt;
          if(fireRem[i]<=0){fireState[i]=0;continue;}
          for(const j of neighbors[i]){
            if(fireState[j]===0){fireState[j]=.8;fireRem[j]=.12;}
          }
        }
        orbSiz[i]=orbData[i].baseS*(1+fireState[i]*1.2);
      }
      orbGeo.attributes.aSize.needsUpdate=true;

      // 球体表面鼠标高亮 (覆盖神经波, 必须放最后)
      if(st.mouse){
        const smx=st.mouse.x*3,smy=st.mouse.y*3;
        for(let i=0;i<orbN;i++){
          const px=orbPos[i*3]*orbPts.scale.x,py=orbPos[i*3+1]*orbPts.scale.y,pz=orbPos[i*3+2]*orbPts.scale.z;
          const odx=px-smx,ody=py-smy,odz=pz+1.5;
          const od2=odx*odx+ody*ody+odz*odz;
          if(od2<2.5){orbSiz[i]=orbData[i].baseS*1.4;}
        }
        orbGeo.attributes.aSize.needsUpdate=true;
      }

      // 情绪过渡
      if(st.target!==st.emotion){st._et+=dt/1.2;if(st._et>=1){st.emotion=st.target;st._et=1;}
        const f=COLORS[st.emotion]||COLORS.neutral,t=COLORS[st.target]||COLORS.neutral,e=Math.min(1,st._et);
        const r=f[0]+(t[0]-f[0])*e,g=f[1]+(t[1]-f[1])*e,b=f[2]+(t[2]-f[2])*e;
        mat.uniforms.uCore.value.setRGB(r,g,b);mat.uniforms.uMix.value=e;
      }
      mat.uniforms.uVol.value=st.audio.volume;
      mat.uniforms.uTime.value=et;
      orbPts.material.uniforms.uVol.value=st.audio.volume;
      orbPts.material.uniforms.uTime.value=et;

      renderer.render(scene,camera);
      }catch(e){} // 单帧错误不中断循环
    }

    // 直接注册鼠标事件 (不依赖 App.vue)
    window.addEventListener('mousemove',(e)=>{st.mouse={x:(e.clientX/w)*2-1,y:-(e.clientY/h)*2+1};});
    window.addEventListener('click',()=>{st._collapseRipple=1;});

    _up={
      camera,switchPage(id){st.page=id;},
      updateEmotion(e){st.target=e;st._et=0;},
      updateAudio(d){st.audio.volume=Math.min(1,d.volume||0);st.audio._thinking=d.thinking||false;},
      onMouseMove(x,y){
        st.mouse={x:(x/w)*2-1,y:-(y/h)*2+1};
        if(!orbPos)return;
        const mx=st.mouse.x,my=st.mouse.y;
        for(let i=0;i<orbN;i++){
          const px=orbPos[i*3]*orbPts.scale.x+orbPts.position.x;
          const py=orbPos[i*3+1]*orbPts.scale.y+orbPts.position.y;
          const dx=px-mx*3,dy=py-my*3,dz=(orbPos[i*3+2]*orbPts.scale.z+orbPts.position.z)-(-1.5);
          const d2=dx*dx+dy*dy+dz*dz;
          if(d2<2.5){orbSiz[i]=orbData[i].baseS*2.5;orbGeo.attributes.aSize.needsUpdate=true;}
          else if(orbSiz[i]>orbData[i].baseS*1.2){orbSiz[i]=orbData[i].baseS;orbGeo.attributes.aSize.needsUpdate=true;}
        }
      },onClick(){st._collapseRipple=1;},
      destroy(){running=false;geo.dispose();mat.dispose();cGeo.dispose();cry.material.map?.dispose();cry.material.dispose();orbPts.geometry.dispose();orbPts.material.dispose();renderer.dispose();_up=null;},
    };

    console.log('[particles] 就绪 —',N,'粒子');
    loop();
    return _up;
  }catch(e){
    console.error('[particles] 失败:',e.message);return null;
  }
}
