# Requirements Document

## Introduction

在"我的相册"页面（MyGalleryPage）中，用户在 CLIP 自动分类和去重处理完成后，需要手动调整照片管理结果。本功能支持三项核心操作：手动删除图片（移到待删除区）、手动更换图片分类（people/animal/landscape/other）、从待删除区恢复图片。这些操作弥补了自动处理对水下照片等特殊场景识别不准确的问题。

## Glossary

- **MyGalleryPage**: 我的相册页面，用户管理自己旅行相册的前端页面组件
- **Media_Item**: 媒体文件记录，存储在 media_items 表中，包含 category、status、trashed_reason 等字段
- **Category**: 图片分类标签，取值为 people、animal、landscape、other 四种之一
- **Trash_Zone**: 待删除区，展示 status 为 trashed 的媒体文件，支持恢复和永久删除
- **Category_API**: 后端更换分类的 API 端点
- **Batch_Trash_API**: 后端批量移入待删除区的 API 端点（已有）
- **Restore_API**: 后端恢复单个媒体文件的 API 端点（已有）

## Requirements

### Requirement 1: 单张图片手动删除（移到待删除区）

**User Story:** As a 相册拥有者, I want 在图片上直接点击删除按钮将单张图片移到待删除区, so that 我可以快速移除自动处理后不满意的照片。

#### Acceptance Criteria

1. WHEN 用户点击某张图片的删除按钮, THE MyGalleryPage SHALL 弹出确认对话框询问用户是否确认删除该图片
2. WHEN 用户确认删除, THE Batch_Trash_API SHALL 将该 Media_Item 的 status 更新为 trashed，trashed_reason 设置为 manual
3. WHEN 单张删除操作成功, THE MyGalleryPage SHALL 将该图片从图片网格中移除，并在 Trash_Zone 中显示该图片
4. IF 删除操作失败, THEN THE MyGalleryPage SHALL 保持图片在原位置不变，允许用户重试

### Requirement 2: 手动更换图片分类

**User Story:** As a 相册拥有者, I want 更换图片的分类标签, so that 我可以纠正 CLIP 自动分类不准确的结果。

#### Acceptance Criteria

1. WHEN 用户在图片上触发分类更换操作, THE MyGalleryPage SHALL 显示包含 people、animal、landscape、other 四个选项的分类选择器
2. WHEN 用户选择一个新的 Category, THE Category_API SHALL 将该 Media_Item 的 category 字段更新为用户选择的值
3. WHEN 分类更换成功, THE MyGalleryPage SHALL 立即更新本地状态，使图片在对应的分类标签页下正确显示
4. THE Category_API SHALL 仅接受 people、animal、landscape、other 四个有效分类值
5. IF 用户选择的分类与当前分类相同, THEN THE MyGalleryPage SHALL 不发送 API 请求，直接关闭分类选择器
6. IF 分类更换请求失败, THEN THE MyGalleryPage SHALL 恢复图片的原始分类显示，允许用户重试

### Requirement 3: 从待删除区恢复图片

**User Story:** As a 相册拥有者, I want 从待删除区恢复误删的图片, so that 我可以撤回错误的删除操作。

#### Acceptance Criteria

1. WHEN 用户点击待删除区中某张图片的恢复按钮, THE Restore_API SHALL 将该 Media_Item 的 status 更新为 active，清除 trashed_reason
2. WHEN 恢复操作成功, THE MyGalleryPage SHALL 将该图片从 Trash_Zone 移除，并在图片网格中重新显示
3. WHEN 恢复的图片有 category 值, THE MyGalleryPage SHALL 将该图片显示在对应的分类标签页下
4. IF 恢复操作失败, THEN THE MyGalleryPage SHALL 保持图片在 Trash_Zone 中不变，允许用户重试

### Requirement 4: 更换分类后端 API

**User Story:** As a 系统开发者, I want 提供更换图片分类的 API 端点, so that 前端可以调用该接口更新图片分类。

#### Acceptance Criteria

1. THE Category_API SHALL 提供 PUT /api/media/:id/category 端点，接受 JSON body 中的 category 字段
2. WHEN 收到有效的分类更换请求, THE Category_API SHALL 更新 media_items 表中对应记录的 category 字段，并返回更新后的 Media_Item
3. THE Category_API SHALL 验证请求用户为该媒体文件的拥有者、所属旅行的拥有者或管理员
4. IF 请求中的 category 值不在 people、animal、landscape、other 范围内, THEN THE Category_API SHALL 返回 400 状态码和描述性错误信息
5. IF 指定的媒体文件不存在, THEN THE Category_API SHALL 返回 404 状态码
6. IF 请求用户无权操作该媒体文件, THEN THE Category_API SHALL 返回 403 状态码

### Requirement 5: 批量分类更换

**User Story:** As a 相册拥有者, I want 在多选模式下批量更换图片分类, so that 我可以高效地纠正多张图片的分类。

#### Acceptance Criteria

1. WHILE 多选模式激活且有图片被选中, THE MyGalleryPage SHALL 在底部操作栏中显示"更换分类"按钮
2. WHEN 用户点击"更换分类"按钮, THE MyGalleryPage SHALL 显示包含 people、animal、landscape、other 四个选项的分类选择器
3. WHEN 用户选择一个 Category, THE Category_API SHALL 对所有选中的 Media_Item 逐一更新 category 字段
4. WHEN 批量分类更换全部成功, THE MyGalleryPage SHALL 更新所有受影响图片的本地状态，退出多选模式
5. IF 批量操作中部分请求失败, THEN THE MyGalleryPage SHALL 显示失败数量提示，保持多选模式以便用户重试
