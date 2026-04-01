# 需求文档

## 简介

追加素材功能允许用户在已有的旅行相册中追加上传新的照片或视频。当前系统仅支持在创建旅行时上传素材，创建完成后无法再添加新内容。本功能在 Gallery 页面提供追加上传入口，用户可以选择新文件并上传到已有相册，上传完成后重新执行处理流程（去重、缩略图生成、质量评分、封面选择），将新素材与已有素材合并展示。

## 术语表

- **Gallery_Page**：展示某次旅行相册中所有已处理素材（图片和视频）的页面
- **Append_Uploader**：在已有相册中追加上传新素材的上传组件
- **Processing_Pipeline**：素材处理流水线，包含去重、缩略图生成、质量评分和封面选择四个步骤
- **Media_API**：负责接收和存储上传文件的后端接口
- **Trip**：一次旅行相册，包含标题、说明和关联素材

## 需求

### 需求 1：Gallery 页面追加上传入口

**用户故事：** 作为旅行者，我想要在已有相册的 Gallery 页面中看到一个追加上传的入口，以便我能方便地为已有相册添加新素材。

#### 验收标准

1. WHILE 一个 Trip 的可见性状态为公开时, THE Gallery_Page SHALL 在页面头部区域显示一个"追加素材"按钮
2. WHEN 用户点击"追加素材"按钮时, THE Gallery_Page SHALL 展开追加上传区域，显示 Append_Uploader 组件
3. WHILE 一个 Trip 的可见性状态为不公开时, THE Gallery_Page SHALL 隐藏"追加素材"按钮（因为不公开相册的 Gallery 页面本身不可访问）

### 需求 2：追加上传文件

**用户故事：** 作为旅行者，我想要在追加上传区域选择并上传新的照片或视频文件，以便新素材能被保存到已有相册中。

#### 验收标准

1. THE Append_Uploader SHALL 提供文件选择控件，支持选择多个文件，接受的格式与创建旅行时的上传组件一致（JPEG、PNG、WebP、HEIC、MP4、MOV、AVI、MKV）
2. WHEN 用户选择了不支持格式的文件时, THE Append_Uploader SHALL 跳过该文件并显示格式不支持的警告信息
3. WHEN 用户点击开始上传按钮时, THE Append_Uploader SHALL 逐个将文件通过 Media_API 上传到对应 Trip 的存储目录中
4. WHILE 文件上传过程中, THE Append_Uploader SHALL 显示每个文件的上传进度百分比和状态（待上传、上传中、已完成、失败）
5. IF 某个文件上传失败, THEN THE Append_Uploader SHALL 显示错误信息并提供重试按钮

### 需求 3：追加上传后触发处理流程

**用户故事：** 作为旅行者，我想要在追加上传完成后自动或手动触发素材处理流程，以便新素材能被去重、生成缩略图和评分。

#### 验收标准

1. WHEN 所有追加文件上传完成后, THE Append_Uploader SHALL 显示"开始处理"按钮，允许用户触发 Processing_Pipeline
2. WHEN 用户点击"开始处理"按钮时, THE Processing_Pipeline SHALL 对该 Trip 的所有素材（包括已有素材和新追加素材）重新执行去重、缩略图生成、质量评分和封面选择流程
3. WHILE Processing_Pipeline 执行过程中, THE Gallery_Page SHALL 通过 SSE 流式展示处理进度，包括当前步骤名称和完成百分比
4. WHEN Processing_Pipeline 执行完成后, THE Gallery_Page SHALL 自动刷新素材列表，展示合并后的所有素材
5. IF Processing_Pipeline 执行过程中发生错误, THEN THE Gallery_Page SHALL 显示错误信息并提供重试按钮

### 需求 4：新素材与已有素材的去重合并

**用户故事：** 作为旅行者，我想要新追加的素材能与已有素材进行去重处理，以便相册中不会出现重复的照片。

#### 验收标准

1. WHEN Processing_Pipeline 执行去重步骤时, THE Processing_Pipeline SHALL 将新追加的图片与已有图片一起进行感知哈希去重比较
2. WHEN 新追加的图片与已有图片被判定为重复时, THE Processing_Pipeline SHALL 将新图片归入已有的重复组中
3. WHEN 新追加的图片之间被判定为重复时, THE Processing_Pipeline SHALL 为这些图片创建新的重复组
4. THE Processing_Pipeline SHALL 为所有重复组重新执行质量评分，选出每组中质量最高的图片作为默认展示图

### 需求 5：追加上传后的缩略图和封面更新

**用户故事：** 作为旅行者，我想要新追加的素材也能生成缩略图，并且相册封面能根据所有素材重新选择最佳封面。

#### 验收标准

1. WHEN Processing_Pipeline 执行缩略图生成步骤时, THE Processing_Pipeline SHALL 为所有尚未生成缩略图的图片生成缩略图
2. WHEN Processing_Pipeline 执行封面选择步骤时, THE Processing_Pipeline SHALL 从该 Trip 的所有图片（包括已有和新追加的）中重新选择质量最高的图片作为封面
3. THE Processing_Pipeline SHALL 保留已有素材已生成的缩略图，仅为新追加的素材生成缩略图

### 需求 6：追加上传流程的状态管理

**用户故事：** 作为旅行者，我想要追加上传流程有清晰的状态反馈，以便我能了解当前操作的进展。

#### 验收标准

1. THE Append_Uploader SHALL 支持以下状态流转：选择文件 → 上传中 → 上传完成 → 处理中 → 处理完成
2. WHEN 追加上传和处理全部完成后, THE Gallery_Page SHALL 显示完成提示并自动收起追加上传区域
3. WHEN 用户在上传或处理过程中点击取消时, THE Append_Uploader SHALL 停止当前操作并保留已成功上传的文件
