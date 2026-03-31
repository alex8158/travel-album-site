# 实现计划：处理进度条功能

## 概述

通过 Server-Sent Events（SSE）为旅行相册的素材处理流程增加实时进度反馈。后端新增 SSE 流式端点和 ProgressReporter 服务，前端新增 ProgressBar 组件并改造 ProcessTrigger 组件。采用增量实现策略：先后端基础设施，再前端组件，最后集成联调。

## Tasks

- [x] 1. 实现后端 ProgressReporter 服务
  - [x] 1.1 创建 `server/src/services/progressReporter.ts`，实现 ProgressReporter 类
    - 定义 ProgressEvent、CompleteEvent、ErrorEvent 接口
    - 实现 initSSE() 方法设置 SSE 响应头（Content-Type: text/event-stream, Cache-Control: no-cache, Connection: keep-alive）
    - 实现 sendStepStart(step) 方法，推送步骤开始事件（percent = (stepIndex-1)*25）
    - 实现 sendStepComplete(step) 方法，推送步骤完成事件（percent = stepIndex*25）
    - 实现 sendComplete(result) 方法，推送完成事件并调用 res.end() 关闭连接
    - 实现 sendError(error) 方法，推送错误事件并调用 res.end() 关闭连接
    - SSE 输出格式：`event: {type}\ndata: {json}\n\n`
    - _需求: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

  - [ ]* 1.2 编写 ProgressReporter 属性测试（Property 1: 进度事件结构完整性）
    - **Property 1: 进度事件结构完整性**
    - 使用 fast-check 生成随机步骤标识符（dedup/quality/thumbnail/cover），调用 sendStepStart/sendStepComplete，验证写入响应流的事件数据包含 step、stepIndex、totalSteps、percent 四个字段
    - **验证: 需求 1.2, 1.3, 1.4**

  - [ ]* 1.3 编写 ProgressReporter 属性测试（Property 2: 进度百分比等分计算）
    - **Property 2: 进度百分比等分计算**
    - 使用 fast-check 生成随机步骤序号（1-4），验证步骤开始时 percent = (stepIndex-1)*25，步骤完成时 percent = stepIndex*25
    - **验证: 需求 1.5**

  - [ ]* 1.4 编写 ProgressReporter 属性测试（Property 3: 错误事件包含错误信息）
    - **Property 3: 错误事件包含错误信息**
    - 使用 fast-check 生成随机错误信息字符串和随机步骤名称，调用 sendError，验证写入的事件数据包含错误信息和步骤名称
    - **验证: 需求 1.7**

  - [ ]* 1.5 编写 ProgressReporter 属性测试（Property 6: SSE 事件格式合规性）
    - **Property 6: SSE 事件格式合规性**
    - 使用 fast-check 生成随机事件类型和 JSON 可序列化数据，验证输出符合 `event: {type}\ndata: {json}\n\n` 格式
    - **验证: 需求 3.4**

- [x] 2. 实现后端 SSE 流式端点
  - [x] 2.1 在 `server/src/routes/process.ts` 中新增 `GET /:id/process/stream` 路由
    - 在建立 SSE 连接前验证旅行是否存在，不存在则返回 404 JSON 错误
    - 创建 ProgressReporter 实例并调用 initSSE()
    - 按顺序执行四个处理步骤（dedup → quality → thumbnail → cover），每步前后调用 sendStepStart/sendStepComplete
    - 所有步骤完成后调用 sendComplete 推送结果并关闭连接
    - 任一步骤失败时调用 sendError 推送错误并关闭连接
    - 监听 req 的 close 事件，检测客户端断开连接后停止后续处理
    - 保留原有 POST 端点不变
    - _需求: 1.1, 1.2, 1.3, 1.6, 1.7, 3.3, 3.4_

  - [ ]* 2.2 编写 SSE 端点单元测试
    - 测试旅行不存在时返回 404 JSON 错误
    - 测试完整处理流程推送的事件序列
    - _需求: 1.6, 3.2_

- [x] 3. 检查点 - 确保后端测试通过
  - 确保所有后端测试通过，如有问题请向用户确认。

- [x] 4. 实现前端 ProgressBar 组件
  - [x] 4.1 创建 `client/src/components/ProgressBar.tsx`
    - 定义 ProgressStatus 类型（'idle' | 'processing' | 'complete' | 'error' | 'disconnected'）和 ProgressBarProps 接口
    - 实现步骤名称映射函数 getStepLabel（dedup→图片去重、quality→质量评分、thumbnail→缩略图生成、cover→封面图选择，未知标识符原样返回）
    - 渲染水平进度条，宽度按 percent 百分比设置
    - 显示当前步骤中文名称、步骤序号文本（"步骤 X/4"）和百分比数值（"XX%"）
    - 进度条使用 CSS transition 实现平滑动画过渡
    - processing 状态：显示进度条和步骤信息
    - complete 状态：显示处理完成提示
    - error 状态：显示错误信息（role="alert"）
    - disconnected 状态：显示连接中断提示
    - idle 状态：不渲染内容
    - _需求: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.2, 4.1, 4.2, 4.3, 4.4_

  - [ ]* 4.2 编写 ProgressBar 属性测试（Property 4: 进度条渲染内容完整性）
    - **Property 4: 进度条渲染内容完整性**
    - 使用 fast-check 生成随机有效进度状态（stepIndex 1-4，percent 0-100），渲染 ProgressBar 组件，验证输出包含中文步骤名、步骤序号文本和百分比文本
    - **验证: 需求 2.1, 2.2, 2.3, 2.4**

  - [ ]* 4.3 编写 ProgressBar 属性测试（Property 5: 错误状态展示错误信息）
    - **Property 5: 错误状态展示错误信息**
    - 使用 fast-check 生成随机非空字符串作为错误信息，渲染 error 状态的 ProgressBar，验证输出包含该错误信息
    - **验证: 需求 2.7**

  - [ ]* 4.4 编写 ProgressBar 属性测试（Property 7: 步骤名称映射完备性）
    - **Property 7: 步骤名称映射完备性**
    - 使用 fast-check 生成随机步骤标识符（包括四个有效值和随机无效值），验证有效值返回对应中文名，无效值原样返回
    - **验证: 需求 4.1, 4.2, 4.3, 4.4**

  - [ ]* 4.5 编写 ProgressBar 单元测试
    - 测试 complete 状态显示处理结果摘要
    - 测试 disconnected 状态显示连接中断提示
    - 测试进度条动画 CSS transition 属性存在
    - _需求: 2.5, 2.6, 3.2_

- [x] 5. 改造 ProcessTrigger 组件集成 SSE
  - [x] 5.1 改造 `client/src/components/ProcessTrigger.tsx`
    - 移除 axios POST 请求逻辑
    - 点击按钮后创建 EventSource 连接到 `/api/trips/${tripId}/process/stream`
    - 监听 `progress` 事件更新进度状态（currentStep、stepIndex、totalSteps、percent）
    - 监听 `complete` 事件更新结果状态并关闭 EventSource
    - 监听 `error` 事件更新错误状态并关闭 EventSource
    - EventSource 的 onerror 回调处理连接断开，设置 disconnected 状态
    - 在 useEffect cleanup 中调用 eventSource.close() 释放连接
    - 集成 ProgressBar 子组件，传递进度状态 props
    - 保留处理结果摘要展示逻辑
    - _需求: 1.1, 2.1, 2.6, 3.1, 3.2, 3.3_

  - [ ]* 5.2 编写 ProcessTrigger 组件测试
    - 测试组件卸载时关闭 EventSource 连接
    - 测试步骤名称映射的四个具体值
    - _需求: 3.3, 4.1, 4.2, 4.3, 4.4_

- [x] 6. 最终检查点 - 确保所有测试通过
  - 确保前后端所有测试通过，如有问题请向用户确认。

## 备注

- 标记 `*` 的子任务为可选任务，可跳过以加速 MVP 交付
- 每个任务引用了具体的需求编号以确保可追溯性
- 属性测试验证设计文档中定义的正确性属性
- 原有 POST 端点保留不变，保持向后兼容
