import type { ProcessResult } from './ProcessTrigger';

export interface ProcessingLogProps {
  uploadCount: number;
  result: ProcessResult;
  onClose: () => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  people: '人物',
  animal: '动物',
  landscape: '风景',
  other: '其他',
};

export default function ProcessingLog({ uploadCount, result, onClose }: ProcessingLogProps) {
  return (
    <div className="processing-log-overlay" role="dialog" aria-label="处理日志">
      <div className="processing-log-modal">
        <h2>处理完成</h2>
        <ul>
          <li>上传文件数量：{uploadCount}</li>
          <li>处理图片数量：{result.totalImages}</li>
          <li>处理视频数量：{result.totalVideos}</li>
          <li>模糊删除数量：{result.blurryDeletedCount}</li>
          <li>去重删除数量：{result.dedupDeletedCount}</li>
          <li>分析成功数量：{result.analyzedCount}</li>
          <li>优化成功数量：{result.optimizedCount}</li>
          <li>分类成功数量：{result.classifiedCount}</li>
          {result.categoryStats && (
            <>
              {Object.entries(result.categoryStats).map(([key, count]) => (
                <li key={key}>{CATEGORY_LABELS[key] || key}：{count} 张</li>
              ))}
            </>
          )}
          <li>成片数量：{result.compiledCount}</li>
          {result.failedCount > 0 && (
            <li>处理失败数量：{result.failedCount}</li>
          )}
        </ul>
        <button onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}
