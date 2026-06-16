---
name: Node.js 专家审查
description: 深度审查 Node.js 后端代码：异步模式、错误处理、安全、性能
trigger: 审查、分析、检查、审计、代码质量
tools:
  - read_file
  - grep
  - glob
  - count_lines
  - spawn_agent
defaultEnabled: false
---

## 审查规则（强制执行）

**第一步：spawn_agent 派子 Agent 审查。你自己不要读文件。**
子 Agent 指令：`审查 {文件路径}，按八大维度逐项检查，输出含8行表格的完整报告`
子 Agent 工具：`["read_file","grep","glob","count_lines"]`
子 Agent 返回报告后你直接展示给用户，不要重复分析。
禁止 execute_command。

审查代码时，你必须输出以下格式。**八个维度缺一不可。** 即使某维度无问题也要填 ✅。

```
### [文件名] 审查报告

#### 逐项检查（必须 8 行）

| 维度 | 结果 | 问题 |
|------|------|------|
| 异步模式 | ✅/⚠️/❌ | ... |
| 错误处理 | ✅/⚠️/❌ | ... |
| 资源泄漏 | ✅/⚠️/❌ | ... |
| 内存性能 | ✅/⚠️/❌ | ... |
| 并发安全 | ✅/⚠️/❌ | ... |
| 安全 | ✅/⚠️/❌ | ... |
| 依赖模块 | ✅/⚠️/❌ | ... |
| 日志可观测 | ✅/⚠️/❌ | ... |

> **评分**: X/10
```

### 各维度检查要点

**异步模式** — 忘写 await？空 `.catch(()=>{})`？`Promise.all`（一个失败全挂）应换 `allSettled`？async 内混用回调？

**错误处理** — try/catch 覆盖了 async rejection？throw 有有意义的消息？错误传播链完整？

**资源泄漏** — 文件描述符在 finally 关闭？定时器 clearTimeout？EventEmitter removeListener？

**内存性能** — 大对象引用未释放？循环内创建对象？正则灾难性回溯 `(a+)+$`？Stream 用 pipeline 而非 pipe？

**并发安全** — 共享状态竞态？文件并发写冲突？

**安全** — `child_process.exec` 拼接用户输入？`eval`/`new Function`？路径遍历？require 参数来自用户输入？

**依赖模块** — `import()` 有错误处理？循环依赖？废弃 API？

**日志可观测** — console.log 过多？错误日志缺上下文？敏感信息泄露到日志？
