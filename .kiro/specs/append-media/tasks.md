# 实施计划：追加素材（append-media）

## 概述

本功能的实现工作集中在前端 GalleryPage 组件，通过新增追加上传状态管理和 UI 区域，复用现有 FileUploader 和 ProcessTrigger 组件，实现在已有相册中追加素材的完整流程。后端无需修改。

## 任务

- [x] 1. 在 GalleryPage 中添加追加上传状态管理和"追加素材"按钮
  - [x] 1.1 在 GalleryPage 中新增 `appendMode` 和 `showAppend` 状态，定义 AppendState 类型
    - 新增状态：`appendMode: 'idle' | 'uploading' | 'uploaded' | 'processing' | 'done'`
    - 新增状态：`showAppend: boolean`（控制追加区域展开/收起）
    - _需求：6.1_

  - [x] 1.2 在 GalleryPage header 区域添加"追加素材"按钮
    - 仅当 `trip.visibility === 'public'` 时渲染按钮
    - 按钮添加 `data-testid="append-media-btn"` 和 `aria-label="追加素材"`
    - 点击按钮时设置 `showAppend = true`，`appendMode = 'uploading'`
    - _需求：1.1, 1.2, 1.3_

  - [ ]* 1.3 为追加按钮可见性编写属性测试
    - **属性 1：追加按钮的可见性与 Trip 可见性一致**
    - **验证需求：1.1, 1.3**

  - [ ]* 1.4 为追加按钮可见性和点击行为编写单元测试
    - 测试公开相册显示追加按钮
    - 测试不公开相册隐藏追加按钮
    - 测试点击按钮展开追加上传区域
    - _需求：1.1, 1.2, 1.3_

- [x] 2. 实现追加上传区域的 UI 和交互逻辑
  - [x] 2.1 在 GalleryPage 中渲染追加上传区域
    - 当 `showAppend` 为 true 且 `appendMode` 为 `'uploading'` 时，渲染 `<FileUploader tripId={id} />` 组件
    - 追加区域包含一个"取消"按钮，点击后设置 `showAppend = false`，`appendMode = 'idle'`
    - 添加 `data-testid="append-area"` 标识追加区域容器
    - _需求：2.1, 2.3, 2.4, 2.5, 6.3_

  - [x] 2.2 监听 FileUploader 上传完成状态，切换到 uploaded 阶段
    - 为 FileUploader 添加 `onAllUploaded` 回调 prop（需要修改 FileUploader 组件）
    - 当所有文件上传完成时，FileUploader 调用 `onAllUploaded` 回调
    - GalleryPage 收到回调后设置 `appendMode = 'uploaded'`
    - _需求：3.1, 6.1_

  - [ ]* 2.3 为文件格式拒绝编写属性测试
    - **属性 2：不支持格式的文件被拒绝**
    - **验证需求：2.2**

  - [ ]* 2.4 为追加上传区域编写单元测试
    - 测试追加区域展开时显示 FileUploader
    - 测试取消操作收起追加区域
    - _需求：2.1, 6.3_

- [x] 3. 检查点 - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

- [x] 4. 实现追加处理流程和完成后的自动刷新
  - [x] 4.1 在追加区域中渲染 ProcessTrigger 组件
    - 当 `appendMode` 为 `'uploaded'` 或 `'processing'` 时，渲染 `<ProcessTrigger tripId={id} onProcessed={handleAppendProcessed} />`
    - 用户点击"开始处理"后设置 `appendMode = 'processing'`
    - _需求：3.1, 3.2, 3.3_

  - [x] 4.2 实现处理完成后的自动刷新和收起逻辑
    - `handleAppendProcessed` 回调中：调用 `fetchGallery()` 刷新数据
    - 设置 `appendMode = 'done'`，短暂显示完成提示
    - 延迟后自动设置 `showAppend = false`，`appendMode = 'idle'`（收起追加区域）
    - _需求：3.4, 6.2_

  - [ ]* 4.3 为追加上传状态流转编写属性测试
    - **属性 7：追加上传状态流转合法性**
    - **验证需求：6.1**

  - [ ]* 4.4 为处理流程和自动刷新编写单元测试
    - 测试上传完成后显示 ProcessTrigger
    - 测试处理完成后刷新 Gallery 数据
    - 测试处理完成后收起追加区域并显示完成提示
    - _需求：3.1, 3.4, 6.2_

- [x] 5. 修改 FileUploader 组件支持上传完成回调
  - [x] 5.1 为 FileUploader 添加可选的 `onAllUploaded` 回调 prop
    - 在 `FileUploaderProps` 接口中添加 `onAllUploaded?: () => void`
    - 在 `handleUpload` 函数中，当所有文件上传完成（无 pending 状态）后调用 `onAllUploaded`
    - 确保不影响现有 UploadPage 中的使用
    - _需求：3.1, 6.1_

  - [ ]* 5.2 为 FileUploader 的 onAllUploaded 回调编写单元测试
    - 测试所有文件上传完成后触发回调
    - 测试部分文件失败时不触发回调
    - _需求：3.1_

- [x] 6. 最终检查点 - 确保所有测试通过
  - 确保所有测试通过，如有问题请询问用户。

## 备注

- 标记 `*` 的任务为可选任务，可跳过以加快 MVP 进度
- 每个任务引用了具体的需求编号以确保可追溯性
- 后端无需任何修改，所有 API 已天然支持追加场景
- 属性测试使用 `fast-check` 库，与项目现有的 vitest 测试框架兼容
- 属性 3-6（去重分组、默认展示图、缩略图完整性、封面选择）为后端已有逻辑的属性，无需在本功能中重复测试
