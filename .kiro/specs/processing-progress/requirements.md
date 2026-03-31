# 需求文档

## 简介

处理进度条功能是旅行相册展示网站的增强功能。当前系统在用户触发素材处理（去重、质量评分、缩略图生成、封面图选择）后，前端没有任何进度反馈，用户无法得知处理进展。本功能通过 Server-Sent Events（SSE）实现后端到前端的实时进度推送，让用户能够看到当前处理步骤和整体进度百分比，并以可视化进度条的形式呈现。

## 术语表

- **Progress_Reporter**：负责在后端处理流程中收集和推送进度信息的模块
- **Progress_Bar**：前端用于可视化展示处理进度的 UI 组件
- **Processing_Step**：处理流程中的一个阶段，包括去重（dedup）、质量评分（quality）、缩略图生成（thumbnail）、封面图选择（cover）
- **SSE_Connection**：基于 Server-Sent Events 协议的服务端到客户端的单向实时通信连接
- **Progress_Event**：通过 SSE_Connection 推送的单条进度更新消息，包含当前步骤名称、步骤进度和整体进度

## 需求

### 需求 1：后端处理进度推送

**用户故事：** 作为旅行者，我想要在触发素材处理后实时接收处理进度信息，以便了解系统当前的处理状态。

#### 验收标准

1. WHEN 用户触发素材处理时, THE Progress_Reporter SHALL 通过 SSE_Connection 向前端推送 Progress_Event
2. THE Progress_Reporter SHALL 在每个 Processing_Step 开始时推送一条包含步骤名称的 Progress_Event
3. THE Progress_Reporter SHALL 在每个 Processing_Step 完成时推送一条包含该步骤完成状态的 Progress_Event
4. THE Progress_Reporter SHALL 在每条 Progress_Event 中包含当前步骤名称、步骤序号、总步骤数和整体进度百分比
5. THE Progress_Reporter SHALL 将整体进度百分比按四个 Processing_Step 等分计算（每步占 25%）
6. WHEN 所有 Processing_Step 完成后, THE Progress_Reporter SHALL 推送一条包含最终处理结果的完成事件并关闭 SSE_Connection
7. IF 某个 Processing_Step 执行过程中发生错误, THEN THE Progress_Reporter SHALL 推送一条包含错误信息的错误事件并关闭 SSE_Connection

### 需求 2：前端进度条可视化

**用户故事：** 作为旅行者，我想要在页面上看到一个可视化的进度条和当前步骤说明，以便直观了解处理进展。

#### 验收标准

1. WHEN 用户点击"开始处理"按钮后, THE Progress_Bar SHALL 显示一个水平进度条并实时更新进度百分比
2. THE Progress_Bar SHALL 在进度条上方或下方显示当前正在执行的 Processing_Step 的中文名称
3. THE Progress_Bar SHALL 显示当前步骤序号与总步骤数（如"步骤 2/4"）
4. THE Progress_Bar SHALL 显示整体进度百分比数值（如"50%"）
5. WHEN 整体进度百分比更新时, THE Progress_Bar SHALL 以平滑动画过渡到新的进度值
6. WHEN 所有处理完成后, THE Progress_Bar SHALL 显示处理完成状态并展示处理结果摘要
7. IF 处理过程中发生错误, THEN THE Progress_Bar SHALL 显示错误状态并展示错误信息

### 需求 3：SSE 连接管理

**用户故事：** 作为旅行者，我想要在处理过程中保持稳定的进度更新连接，以便不会错过任何进度信息。

#### 验收标准

1. WHEN 用户触发素材处理时, THE SSE_Connection SHALL 使用 EventSource API 建立与后端的连接
2. WHEN SSE_Connection 意外断开时, THE Progress_Bar SHALL 显示连接中断提示并允许用户重新触发处理
3. WHEN 用户在处理过程中离开页面时, THE SSE_Connection SHALL 被正确关闭以释放服务端资源
4. THE SSE_Connection SHALL 使用标准的 Server-Sent Events 协议格式传输 Progress_Event

### 需求 4：处理步骤名称映射

**用户故事：** 作为旅行者，我想要看到中文的处理步骤名称，以便清楚理解每个步骤的含义。

#### 验收标准

1. THE Progress_Bar SHALL 将 Processing_Step 标识符"dedup"显示为"图片去重"
2. THE Progress_Bar SHALL 将 Processing_Step 标识符"quality"显示为"质量评分"
3. THE Progress_Bar SHALL 将 Processing_Step 标识符"thumbnail"显示为"缩略图生成"
4. THE Progress_Bar SHALL 将 Processing_Step 标识符"cover"显示为"封面图选择"
