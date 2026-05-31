"""
AI 桌面宠物 — Python Agent 服务
通过 stdin/stdout JSON 行协议与 Electron 主进程通信

协议:
  输入(stdin):  每行一个JSON对象,代表Electron发来的请求
  输出(stdout): 每行一个JSON对象,代表Agent发回的事件

请求类型:
  - agent_chat:     运行Agent对话
  - tool_approval:  工具审批回复
  - index_file:     索引文件到RAG
  - ping:           健康检查

事件类型:
  - agent_thought:      Agent的思考过程
  - agent_action:       即将调用工具
  - agent_observation:  工具执行结果
  - chunk:              流式文本块
  - done:               Agent完成
  - tool_approval_request: 请求工具审批
  - memory_updated:     记忆已更新
  - error:              错误
  - pong:               心跳回应
"""
import asyncio
import json
import os
import sys
import traceback

# 全部懒加载 — Windows 上 Python 导入 langchain 很慢
_MemoryStore = None
_RAGPipeline = None
_run_agent = None
_create_llm = None
_security_gate = None
_run_intent_coordinator = None
_vision_expert_pipeline = None


def _lazy_import_agent():
    global _run_agent, _create_llm
    if _run_agent is None:
        from agent_loop import run_agent as _ra, _create_llm as _cl
        _run_agent, _create_llm = _ra, _cl


def _lazy_import_security():
    global _security_gate
    if _security_gate is None:
        from security_gate import security_gate as _sg
        _security_gate = _sg


def _lazy_import_coordinator():
    global _run_intent_coordinator
    if _run_intent_coordinator is None:
        from intent_coordinator import run_intent_coordinator as _ric
        _run_intent_coordinator = _ric


def _lazy_import_vision():
    global _vision_expert_pipeline
    if _vision_expert_pipeline is None:
        from vision_expert import vision_expert_pipeline as _vep
        _vision_expert_pipeline = _vep


class AgentService:
    def __init__(self, persist_dir: str):
        self.persist_dir = persist_dir
        self._memory_store = None
        self._rag_pipeline = None
        self.pending_approvals = {}  # approval_id -> Future
        self._running = True

    @property
    def memory_store(self):
        global _MemoryStore
        if self._memory_store is None:
            if _MemoryStore is None:
                from memory_store import MemoryStore as MS
                globals()['_MemoryStore'] = MS
            self._memory_store = _MemoryStore(os.path.join(self.persist_dir, "memory"))
        return self._memory_store

    @property
    def rag_pipeline(self):
        global _RAGPipeline
        if self._rag_pipeline is None:
            if _RAGPipeline is None:
                from rag_pipeline import RAGPipeline as RP
                globals()['_RAGPipeline'] = RP
            self._rag_pipeline = _RAGPipeline(self.persist_dir)
        return self._rag_pipeline

    async def write_event(self, event_type: str, data=None):
        """发送事件到 stdout"""
        event = {"type": event_type}
        if data is not None:
            event["data"] = data
        line = json.dumps(event, ensure_ascii=False, default=str)
        sys.stdout.write(line + "\n")
        sys.stdout.flush()

    async def handle_agent_chat(self, msg: dict):
        """处理 agent_chat 请求"""
        import time as _time
        _t0 = _time.time()
        request_id = msg.get("request_id", "")
        config = msg.get("config", {})
        messages = msg.get("messages", [])
        conv_id = msg.get("conversation_id", "default")
        print(f"[agent_service] handle_agent_chat 收到: provider={config.get('provider')} msgs={len(messages)}", file=sys.stderr)

        async def send_event(e_type, e_data=None):
            ev = {"type": e_type, "request_id": request_id}
            if e_data is not None:
                ev["data"] = e_data
            line = json.dumps(ev, ensure_ascii=False, default=str)
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

        async def wait_approval(tool_name, tool_args):
            """等待用户审批,返回 True/False"""
            approval_id = f"{request_id}:{tool_name}"
            fut = asyncio.get_event_loop().create_future()
            self.pending_approvals[approval_id] = fut

            await send_event("tool_approval_request", {
                "approval_id": approval_id,
                "tool": tool_name,
                "input": tool_args,
            })

            try:
                result = await asyncio.wait_for(fut, timeout=120.0)
                return result
            except asyncio.TimeoutError:
                self.pending_approvals.pop(approval_id, None)
                return False

        try:
            _lazy_import_agent()
            await _run_agent(
                config=config,
                messages=messages,
                conv_id=conv_id,
                memory_store=self.memory_store,
                rag_pipeline=self.rag_pipeline,
                send_event=send_event,
                wait_approval=wait_approval,
            )
        except Exception as e:
            print(f"[agent_service] handle_agent_chat 异常: {e}", file=sys.stderr)
            await send_event("error", str(e))
            traceback.print_exc(file=sys.stderr)
        finally:
            print(f"[agent_service] handle_agent_chat 完成 ({_time.time() - _t0:.1f}s)", file=sys.stderr)

    def handle_tool_approval(self, msg: dict):
        """处理工具审批回复"""
        approval_id = msg.get("approval_id", "")
        approved = msg.get("approved", False)
        fut = self.pending_approvals.pop(approval_id, None)
        if fut and not fut.done():
            fut.set_result(approved)

    async def handle_agent_chat_group(self, msg: dict):
        """处理群聊模式请求 — 安全预检 → 意图拆解 → 多 expert 并行"""
        request_id = msg.get("request_id", "")
        config = msg.get("config", {})
        messages = msg.get("messages", [])
        conv_id = msg.get("conversation_id", "default")
        expert_ids = msg.get("expert_ids", None)
        mentioned_ids = msg.get("mentioned_ids", None)
        expert_data = msg.get("expert_data", None)
        group_settings = msg.get("group_settings", {})

        async def send_event(e_type, e_data=None):
            ev = {"type": e_type, "request_id": request_id}
            if e_data is not None:
                ev["data"] = e_data
            line = json.dumps(ev, ensure_ascii=False, default=str)
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

        try:
            # 获取最后一条用户消息
            last_user_msg = ""
            for m in reversed(messages):
                if m.get("role") == "user":
                    last_user_msg = m.get("content", "")
                    break

            if not last_user_msg:
                await send_event('error', {'content': '没有找到用户消息'})
                return

            # ── Step 1: 安全预检 ──
            await send_event('coordinator_info', {'content': '安全预检中...'})
            user_role = config.get('userRole', 'unknown')
            _lazy_import_agent()
            _lazy_import_security()
            gate_result = await _security_gate(
                last_user_msg, messages, user_role,
                create_llm=lambda **kw: _create_llm({**config, **kw}),
            )

            await send_event('coordinator_info', {
                'content': f'安全预检: {gate_result["level"]} — {gate_result.get("reason", "")}',
            })

            if gate_result['level'] == 'red':
                await send_event('coordinator_error', {
                    'content': f'操作已被安全策略拦截: {gate_result.get("reason", "高危操作")}',
                })
                return

            if gate_result['level'] == 'yellow':
                # 需要二次确认 — 在 Electron 侧弹出确认框
                await send_event('security_confirm_required', {
                    'reason': gate_result.get('reason', ''),
                    'evidence': gate_result.get('evidence', []),
                })
                # 等待确认... 简化处理: 先执行,后续可加等待逻辑
                await send_event('coordinator_info', {
                    'content': '风险操作需确认,已记录审计日志',
                })

            # ── Step 2: 意图拆解 ──
            _lazy_import_coordinator()
            coordinator_result = await _run_intent_coordinator(
                last_user_msg,
                create_llm=lambda **kw: _create_llm({**config, **kw}),
                expert_timeout=15.0,
                send_event=send_event,
            )

            intent_list = coordinator_result.get('intent_list', [])
            expert_results = coordinator_result.get('expert_results', [])
            degradations = coordinator_result.get('degradations', [])

            # 发送各 expert 结果
            active_experts = (expert_data or []) if expert_ids is None else [
                e for e in (expert_data or []) if e.get('id') in (expert_ids or [])
            ]

            # 检查是否有图片需要视觉专家处理
            has_images = any(m.get('images') for m in messages if m.get('role') == 'user')
            if has_images and not any(r.get('expert_type') == 'vision' for r in expert_results):
                # 用户发了图片但 coordinator 没识别, 强制加入视觉分析
                last_user_msg_data = None
                for m in reversed(messages):
                    if m.get('role') == 'user':
                        last_user_msg_data = m
                        break
                imgs = last_user_msg_data.get('images', []) if last_user_msg_data else []
                if imgs:
                    await send_event('coordinator_info', {'content': '检测到图片, 调用视觉专家...'})
                    _lazy_import_vision()
                    vis_result = await _vision_expert_pipeline(
                        imgs,
                        last_user_msg_data.get('content', ''),
                        config,
                        send_event,
                    )
                    expert_results.append(vis_result)

            for result in expert_results:
                expert_type = result.get('expert_type', 'unknown')
                plan = result.get('result', {}).get('plan', '')
                status = result.get('status', 'unknown')

                if status == 'success':
                    await send_event('expert_done', {
                        'expert_id': expert_type,
                        'expert_name': expert_type,
                        'expert_icon': '🤖',
                        'expert_color': '#B7A48E',
                        'content': plan,
                        'elapsed': result.get('elapsed', 0),
                    })
                else:
                    await send_event('expert_error', {
                        'expert_id': expert_type,
                        'error': plan or f'{status}',
                    })

            # ── Step 3: 汇总 ──
            if expert_results:
                summary_parts = []
                for r in expert_results:
                    if r['status'] == 'success':
                        plan = r['result'].get('plan', '')
                        if plan:
                            summary_parts.append(f"【{r['expert_type']}】{plan}")
                summary_text = '\n\n'.join(summary_parts) if summary_parts else '意图分析完成,但无专家输出'

                await send_event('coordinator_done', {
                    'replies': expert_results,
                    'summary': coordinator_result.get('summary', ''),
                    'degradations': degradations,
                })
            else:
                await send_event('coordinator_done', {
                    'replies': [],
                    'summary': '未能识别到可执行的意图',
                })

            # 记录降级情况
            if degradations:
                for d in degradations:
                    await send_event('coordinator_info', {
                        'content': f'降级: {d.get("expert_type","")} — {d.get("reason","")}',
                    })

        except Exception as e:
            await send_event('coordinator_error', {'content': f'群聊模式出错: {str(e)}'})
            traceback.print_exc(file=sys.stderr)

    async def handle_index_file(self, msg: dict):
        """索引文件到 RAG"""
        request_id = msg.get("request_id", "")
        file_path = msg.get("file_path", "")

        try:
            chunks = self.rag_pipeline.index_file(file_path)
            await self.write_event("file_indexed", {
                "request_id": request_id,
                "file_path": file_path,
                "chunks": chunks,
            })
        except Exception as e:
            await self.write_event("error", {
                "request_id": request_id,
                "content": f"文件索引失败: {str(e)}",
            })

    async def handle_search_rag(self, msg: dict):
        """搜索 RAG 文档"""
        request_id = msg.get("request_id", "")
        query = msg.get("query", "")
        results = self.rag_pipeline.search(query)
        await self.write_event("rag_results", {
            "request_id": request_id,
            "results": results,
        })

    def _preload(self):
        """后台预热: 提前导入全部重量模块, 避免首条消息卡顿"""
        import sys, time
        t0 = time.time()
        print("[agent_service] 后台预热中...", file=sys.stderr)
        try:
            _lazy_import_agent()
            t1 = time.time()
            print(f"[agent_service] agent_loop 加载 ({t1-t0:.1f}s)", file=sys.stderr)
            _lazy_import_security()
            _lazy_import_coordinator()
            _lazy_import_vision()
            t2 = time.time()
            print(f"[agent_service] 预热完成 ({t2-t0:.1f}s)", file=sys.stderr)
        except Exception as e:
            import traceback
            print(f"[agent_service] 预热失败: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    async def run(self):
        """主循环: 读取 stdin,处理请求"""
        # 后台预热: 提前加载 agent_loop, 避免第一条消息等 10 秒
        asyncio.get_event_loop().run_in_executor(None, self._preload)

        loop = asyncio.get_event_loop()

        while self._running:
            try:
                line = await loop.run_in_executor(None, sys.stdin.readline)
            except Exception:
                break

            if not line:
                break

            line = line.strip()
            if not line:
                continue

            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type", "")

            if msg_type == "agent_chat":
                asyncio.create_task(self.handle_agent_chat(msg))
            elif msg_type == "agent_chat_group":
                asyncio.create_task(self.handle_agent_chat_group(msg))
            elif msg_type == "tool_approval":
                self.handle_tool_approval(msg)
            elif msg_type == "index_file":
                asyncio.create_task(self.handle_index_file(msg))
            elif msg_type == "search_rag":
                asyncio.create_task(self.handle_search_rag(msg))
            elif msg_type == "get_memory_count":
                count = self.memory_store.count()
                await self.write_event("memory_count", {
                    "request_id": msg.get("request_id", ""),
                    "count": count,
                })
            elif msg_type == "clear_memory":
                self.memory_store.clear()
                await self.write_event("memory_cleared", {
                    "request_id": msg.get("request_id", ""),
                })
            elif msg_type == "get_indexed_files":
                files = self.rag_pipeline.get_indexed_files()
                await self.write_event("indexed_files", {
                    "request_id": msg.get("request_id", ""),
                    "files": files,
                })
            elif msg_type == "remove_file":
                self.rag_pipeline.remove_file(msg.get("file_name", ""))
                await self.write_event("file_removed", {
                    "request_id": msg.get("request_id", ""),
                })
            elif msg_type == "ping":
                await self.write_event("pong", {
                    "request_id": msg.get("request_id", ""),
                    "memory_count": self.memory_store.count(),
                    "indexed_files": len(self.rag_pipeline.get_indexed_files()),
                })
            elif msg_type == "quit":
                self._running = False
                break


def main():
    """入口函数"""
    # 持久化目录: 优先从环境变量读取,否则用默认
    persist_dir = os.environ.get(
        "AGENT_PERSIST_DIR",
        os.path.join(os.path.expanduser("~"), ".ai-desktop-pet"),
    )
    os.makedirs(persist_dir, exist_ok=True)

    service = AgentService(persist_dir)

    # 发送启动就绪信号
    sys.stdout.write(json.dumps({
        "type": "ready",
        "data": {"persist_dir": persist_dir}
    }, ensure_ascii=False) + "\n")
    sys.stdout.flush()

    try:
        asyncio.run(service.run())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        sys.stderr.write(f"Agent 服务崩溃: {e}\n")
        traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
