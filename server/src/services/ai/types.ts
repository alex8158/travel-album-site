// ---------------------------------------------------------------------------
// AI Provider Core Types
// ---------------------------------------------------------------------------

/** AI 调用的统一请求参数 */
export interface AIRequest {
  prompt: string;
  images?: Array<{ base64: string; mediaType: string }>;
  maxTokens?: number;
  temperature?: number;
}

/** AI 调用的统一响应格式 */
export interface AIResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}

/** Provider capabilities */
export type AICapability = 'text-generation' | 'image-analysis' | 'embedding';

/** Provider metadata */
export interface AIProviderMetadata {
  name: string;
  model: string;
  capabilities: AICapability[];
  costPerInputToken: number;
  costPerOutputToken: number;
}

/** Unified Provider interface */
export interface AIProvider {
  readonly metadata: AIProviderMetadata;

  generateText(prompt: string, options?: {
    maxTokens?: number;
    temperature?: number;
  }): Promise<AIResponse>;

  analyzeImage(images: Array<{ base64: string; mediaType: string }>, prompt: string, options?: {
    maxTokens?: number;
  }): Promise<AIResponse>;

  getHealth(): Promise<{ available: boolean; latencyMs: number }>;
}

// ---------------------------------------------------------------------------
// AI Smart Editing Domain Types
// ---------------------------------------------------------------------------

/** 预定义情感标签集 */
export type EmotionTag =
  | '欢乐' | '宁静' | '壮观' | '温馨' | '紧张'
  | '浪漫' | '神秘' | '活力' | '忧伤' | '震撼';

/** 所有有效情感标签 */
export const EMOTION_TAGS: EmotionTag[] = [
  '欢乐', '宁静', '壮观', '温馨', '紧张',
  '浪漫', '神秘', '活力', '忧伤', '震撼',
];

/** 单个片段的 AI 分析结果 */
export interface SegmentAIAnalysis {
  segmentIndex: number;
  sceneDescription: string;       // 不超过 100 字
  emotionTags: EmotionTag[];      // 1-3 个
  narrativeScore: number;         // 0-100 整数
}

/** 过渡方式 */
export type TransitionType = 'cut' | 'fade' | 'crossfade' | 'dissolve';

/** 节奏标注 */
export type PaceType = 'fast' | 'medium' | 'slow';

/** 剪辑方案中的单个片段 */
export interface EditPlanSegment {
  segmentIndex: number;
  reason: string;                  // 选择理由（一句话）
  transitionTo?: TransitionType;   // 到下一个片段的过渡方式
}

/** 完整剪辑方案 */
export interface EditPlan {
  mediaId: string;
  segments: EditPlanSegment[];
  pace: PaceType;
  totalDuration: number;
  narrativeSummary: string;        // 整体叙事概要
}

/** 文案类型 */
export type TextType = 'title' | 'subtitle' | 'narration';

/** 文案风格 */
export type TextStyle = 'travel_diary' | 'documentary' | 'social_media' | 'cinematic';

/** 生成的标题 */
export interface GeneratedTitles {
  titles: string[];               // 3 个候选标题，每个不超过 30 字符
}

/** 生成的字幕 */
export interface GeneratedSubtitles {
  subtitles: Array<{
    segmentIndex: number;
    text: string;                  // 不超过 20 字符
  }>;
}

/** 生成的旁白 */
export interface GeneratedNarration {
  narration: string;
  estimatedDurationSeconds: number; // 按朗读速度估算
}

// ---------------------------------------------------------------------------
// Cost Tracking & Budget Types
// ---------------------------------------------------------------------------

/** AI 调用类型 */
export type AICallType = 'content_analysis' | 'edit_planning' | 'text_generation';

/** AI 使用记录 */
export interface AIUsageRecord {
  id: string;
  userId: string;
  tripId: string;
  mediaId?: string;
  provider: string;
  model: string;
  callType: AICallType;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;         // 美元
  createdAt: string;
}

/** 费用统计 */
export interface UsageStats {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  callCount: number;
  byType: Record<AICallType, { cost: number; count: number }>;
}

/** 模型单价配置 */
export interface ModelPricing {
  provider: string;
  model: string;
  inputPricePerMToken: number;   // 每百万 token 价格（美元）
  outputPricePerMToken: number;
}

/** 预算配置 */
export interface BudgetConfig {
  userId: string;
  monthlyLimit: number;          // 美元
  customLimit?: number;          // 自定义限制（覆盖全局）
}

/** 预算检查结果 */
export interface BudgetCheckResult {
  allowed: boolean;
  currentUsage: number;
  limit: number;
  remainingBudget: number;
  warningLevel: 'none' | 'approaching' | 'exceeded';
  message?: string;
}
