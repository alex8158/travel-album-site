# 需求文档

## 简介

相册可见性控制功能为旅行相册网站增加公开/不公开状态管理能力。新创建的相册默认为公开状态，上传后立即可以浏览。用户在素材处理完成后可以选择将相册设为不公开，未公开的相册在首页上不可打开并显示"未公开"提示。用户还可以通过设置页面统一管理所有相册的可见性状态，包括将已公开的相册切换为不公开。

## 术语表

- **Visibility_Controller**：负责管理相册公开/不公开状态的模块
- **Trip**：一次旅行相册，包含标题、说明和关联素材
- **Settings_Page**：用于集中管理所有相册可见性状态的设置页面
- **HomePage**：展示所有旅行相册列表的首页
- **Upload_Flow**：从创建旅行到上传素材再到处理完成的完整上传流程

## 需求

### 需求 1：相册默认可见性状态

**用户故事：** 作为旅行者，我想要新创建的相册默认为公开状态，以便上传后立即可以浏览。

#### 验收标准

1. WHEN 一个新的 Trip 被创建时, THE Visibility_Controller SHALL 将该 Trip 的可见性状态设置为公开
2. THE Visibility_Controller SHALL 在 Trip 数据模型中持久化存储可见性状态字段，该字段取值为"公开"或"不公开"

### 需求 2：上传处理完成后选择可见性

**用户故事：** 作为旅行者，我想要在素材上传和处理完成后可以选择将相册设为不公开，以便我能控制哪些旅行内容对外展示。

#### 验收标准

1. WHEN 素材处理流程完成后, THE Upload_Flow SHALL 在完成页面展示一个可见性选择控件，允许用户选择"公开"或"不公开"
2. WHEN 用户在完成页面选择"不公开"时, THE Visibility_Controller SHALL 将该 Trip 的可见性状态更新为不公开
3. WHEN 用户在完成页面选择"公开"时, THE Visibility_Controller SHALL 保持该 Trip 的可见性状态为公开
4. WHEN 用户未做任何选择直接离开完成页面时, THE Visibility_Controller SHALL 保持该 Trip 的可见性状态为公开

### 需求 3：首页未公开相册展示限制

**用户故事：** 作为旅行者，我想要未公开的相册在首页上不可打开并显示"未公开"提示，以便我能区分哪些相册已经对外展示。

#### 验收标准

1. WHEN 首页加载旅行列表时, THE HomePage SHALL 展示所有 Trip（包括公开和不公开的）
2. WHILE 一个 Trip 的可见性状态为不公开时, THE HomePage SHALL 在该 Trip 卡片上显示"未公开"标签
3. WHILE 一个 Trip 的可见性状态为不公开时, THE HomePage SHALL 禁用该 Trip 卡片的点击跳转功能，使用户无法进入该相册的 Gallery_Page
4. WHILE 一个 Trip 的可见性状态为公开时, THE HomePage SHALL 正常显示该 Trip 卡片且允许点击进入 Gallery_Page
5. IF 用户通过直接输入 URL 尝试访问一个不公开的 Trip 的 Gallery_Page, THEN THE Gallery_Page SHALL 显示"该相册未公开"的提示信息并阻止内容展示

### 需求 4：已公开相册切换为不公开

**用户故事：** 作为旅行者，我想要将已经公开的相册设置为不公开，以便我能随时撤回对外展示的内容。

#### 验收标准

1. THE Visibility_Controller SHALL 提供 API 接口，接受 Trip ID 和目标可见性状态作为参数，更新该 Trip 的可见性状态
2. WHEN 可见性状态更新成功时, THE Visibility_Controller SHALL 返回更新后的 Trip 信息
3. IF 请求更新的 Trip ID 不存在, THEN THE Visibility_Controller SHALL 返回错误信息
4. IF 请求的目标可见性状态值无效（既非"公开"也非"不公开"）, THEN THE Visibility_Controller SHALL 返回参数错误信息

### 需求 5：设置页面管理相册可见性

**用户故事：** 作为旅行者，我想要有一个设置页面来集中管理所有相册的公开/不公开状态，以便我能方便地批量查看和调整相册可见性。

#### 验收标准

1. THE Settings_Page SHALL 以列表形式展示所有 Trip，每个条目包含旅行标题、创建时间和当前可见性状态
2. THE Settings_Page SHALL 为每个 Trip 提供一个可见性切换控件（如开关按钮），用于在公开和不公开之间切换
3. WHEN 用户通过切换控件更改某个 Trip 的可见性状态时, THE Settings_Page SHALL 立即调用 Visibility_Controller 的 API 更新状态
4. WHEN 可见性状态更新成功时, THE Settings_Page SHALL 在界面上实时反映更新后的状态
5. IF 可见性状态更新失败, THEN THE Settings_Page SHALL 将切换控件恢复到更新前的状态并显示错误提示
6. THE Settings_Page SHALL 可通过导航栏中的入口访问
